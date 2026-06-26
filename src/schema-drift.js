'use strict';

/**
 * Schema drift checker — protects the core invariant this library relies on: that the JS SDK
 * model field names align 1:1 with the BigQuery warehouse columns. If the SDK regenerates with
 * a new/renamed field, or the warehouse schema changes, extracts silently lose data. This
 * module builds a field tree from both sides and diffs them.
 *
 * Pure functions (no fs / no network) so the diff logic is unit-testable; the file/BigQuery
 * wiring lives in scripts/check-schema-drift.js.
 *
 * @module schema-drift
 */

const path = require('path');
const fs = require('fs');
const { isPrimitiveArrayField } = require('./transform');

/** Field "kinds" in both trees. */
const SCALAR = 'scalar';
const MODEL = 'model'; // nested record / object
const MODEL_ARRAY = 'modelArray'; // repeated record / array of objects
const PRIMITIVE_ARRAY = 'primitiveArray'; // string[]/number[] (BQ: REPEATED RECORD{value})

/**
 * Parse a transpiled swagger-codegen JS model source and return its field definitions.
 * Matches lines like:
 *   obj['creation_dts'] = _ApiClient["default"].convertToType(data['creation_dts'], 'String');
 *   obj['items']        = _ApiClient["default"].convertToType(data['items'], [_OrderItem["default"]]);
 *   obj['billing']      = _ApiClient["default"].convertToType(data['billing'], _OrderBilling["default"]);
 *   obj['cc_emails']    = _ApiClient["default"].convertToType(data['cc_emails'], ['String']);
 *
 * @param {string} source
 * @returns {Array<{name:string, kind:string, model?:string}>}
 */
function parseSdkModelFields(source) {
  const out = [];
  const seen = new Set();

  // Pattern 1: scalars/arrays/maps via ApiClient.convertToType(data['x'], TYPE)
  const reConvert = /obj\['([^']+)'\]\s*=\s*_ApiClient\["default"\]\.convertToType\(data\['[^']+'\],\s*(.+)\);/g;
  let m;
  while ((m = reConvert.exec(source)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], ...classifySdkType(m[2].trim()) });
  }

  // Pattern 2: nested single objects via _Model["default"].constructFromObject(data['x'])
  const reConstruct = /obj\['([^']+)'\]\s*=\s*_(\w+)\["default"\]\.constructFromObject\(data\['[^']+'\]\);/g;
  while ((m = reConstruct.exec(source)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ name: m[1], kind: MODEL, model: m[2] });
  }

  return out;
}

/** Classify the convertToType second argument into a kind (+ nested model name). */
function classifySdkType(rawType) {
  let mm;
  // array of model: [_OrderItem["default"]]
  if ((mm = rawType.match(/^\[_(\w+)\["default"\]\]$/))) return { kind: MODEL_ARRAY, model: mm[1] };
  // nested model: _OrderBilling["default"]
  if ((mm = rawType.match(/^_(\w+)\["default"\]$/))) return { kind: MODEL, model: mm[1] };
  // array of primitive: ['String']
  if (/^\['\w+'\]$/.test(rawType)) return { kind: PRIMITIVE_ARRAY };
  // scalar primitive: 'String' | 'Number' | 'Boolean' | 'Date'
  if (/^'\w+'$/.test(rawType)) return { kind: SCALAR };
  // map / object literal {'String': ...} and anything else -> treat as a scalar leaf
  return { kind: SCALAR };
}

/**
 * Build a recursive field tree for an SDK model by reading + parsing its source and its nested
 * models. Cycles (e.g. Order -> Customer -> Order) are stopped at the repeated model.
 *
 * @param {object} args
 * @param {string} args.modelName
 * @param {string} args.modelsDir Directory of `<Model>.js` files.
 * @param {(file:string)=>string} [args.readFile] Injectable reader (defaults to fs).
 * @param {Set<string>} [args.seen] Internal cycle guard.
 * @returns {{kind:string, children?:object}} tree node whose `children` map name -> node
 */
function buildSdkTree({ modelName, modelsDir, readFile, seen }) {
  const read = readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const visited = seen || new Set();
  const file = path.join(modelsDir, `${modelName}.js`);

  let source;
  try {
    source = read(file);
  } catch {
    return { kind: MODEL, children: {}, missingModel: true };
  }

  const children = {};
  for (const f of parseSdkModelFields(source)) {
    if ((f.kind === MODEL || f.kind === MODEL_ARRAY) && f.model && !visited.has(f.model)) {
      const sub = buildSdkTree({
        modelName: f.model,
        modelsDir,
        readFile: read,
        seen: new Set(visited).add(f.model),
      });
      children[f.name] = { kind: f.kind, children: sub.children };
    } else {
      children[f.name] = { kind: f.kind };
    }
  }
  return { kind: MODEL, children };
}

/**
 * Build a recursive field tree from a BigQuery schema `fields` array. A REPEATED RECORD whose
 * sole sub-field is `value` is a primitive array (string[]/number[]); other RECORDs recurse.
 *
 * @param {Array} fields
 * @returns {{kind:string, children:object}}
 */
function buildBqTree(fields) {
  const children = {};
  for (const f of fields || []) {
    if (isPrimitiveArrayField(f)) {
      children[f.name] = { kind: PRIMITIVE_ARRAY };
    } else if (f.type === 'RECORD' || f.type === 'STRUCT') {
      children[f.name] = {
        kind: f.mode === 'REPEATED' ? MODEL_ARRAY : MODEL,
        children: buildBqTree(f.fields).children,
      };
    } else {
      children[f.name] = { kind: SCALAR };
    }
  }
  return { kind: MODEL, children };
}

const isContainer = (kind) => kind === MODEL || kind === MODEL_ARRAY;

/**
 * Diff an SDK tree against a BQ tree.
 *
 * @param {object} sdkNode tree from buildSdkTree
 * @param {object} bqNode  tree from buildBqTree
 * @param {object} [opts]
 * @param {(path:string,name:string)=>boolean} [opts.ignoreBqOnly] return true to suppress a
 *        BQ-only column (warehouse-only extras like *_hash, partition_date, RecordTime).
 * @returns {{sdkOnly:string[], bqOnly:string[], mismatches:string[]}}
 *   sdkOnly   — SDK fields with no matching BQ column (DATA GAP — extract loses these).
 *   bqOnly    — BQ columns not in the SDK, after the ignore filter (info: they drop on hydrate).
 *   mismatches— same name, but one side is a record/array and the other a scalar (BREAKS hydrate).
 */
function diffTrees(sdkNode, bqNode, opts = {}) {
  const ignoreBqOnly = opts.ignoreBqOnly || (() => false);
  const sdkOnly = [];
  const bqOnly = [];
  const mismatches = [];

  function walk(sdk, bq, prefix) {
    const sdkChildren = (sdk && sdk.children) || {};
    const bqChildren = (bq && bq.children) || {};

    for (const name of Object.keys(sdkChildren)) {
      const p = prefix ? `${prefix}.${name}` : name;
      const s = sdkChildren[name];
      const b = bqChildren[name];
      if (!b) {
        sdkOnly.push(p);
        continue;
      }
      if (isContainer(s.kind) !== isContainer(b.kind)) {
        mismatches.push(`${p} (sdk:${s.kind} vs bq:${b.kind})`);
        continue;
      }
      if (isContainer(s.kind) && isContainer(b.kind)) {
        walk(s, b, p);
      }
    }

    for (const name of Object.keys(bqChildren)) {
      if (sdkChildren[name]) continue;
      const p = prefix ? `${prefix}.${name}` : name;
      if (!ignoreBqOnly(p, name)) bqOnly.push(p);
    }
  }

  walk(sdkNode, bqNode, '');
  return { sdkOnly, bqOnly, mismatches };
}

/**
 * Default ignore predicate for warehouse-only columns that are expected NOT to be in the SDK:
 * hashed PII (`*_hash`, `*_hashes`), the partition column, and the streaming changelog
 * bookkeeping columns. Extend via the CLI as needed.
 */
function defaultIgnoreBqOnly(_p, name) {
  return (
    /_hash$/.test(name) ||
    /_hashes$/.test(name) ||
    /^partition_/.test(name) || // partition_date, partition_oid
    name === 'RecordTime' ||
    name === 'IsDelete'
  );
}

module.exports = {
  parseSdkModelFields,
  classifySdkType,
  buildSdkTree,
  buildBqTree,
  diffTrees,
  defaultIgnoreBqOnly,
  kinds: { SCALAR, MODEL, MODEL_ARRAY, PRIMITIVE_ARRAY },
};
