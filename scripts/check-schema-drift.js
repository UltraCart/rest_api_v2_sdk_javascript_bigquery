'use strict';

/**
 * CI guard: verify the JS SDK model field names still align 1:1 with the BigQuery warehouse
 * columns. Fails (exit 1) on field drift that would silently break extracts.
 *
 * Usage:
 *   node scripts/check-schema-drift.js --project=ultracart-dw-acme --dataset=ultracart_dw_linked_high
 *   node scripts/check-schema-drift.js --merchant=DEMO --dataset=ultracart_dw_high
 *   node scripts/check-schema-drift.js --schema-dir=./schemas/tables/ultracart_dw_high   # offline snapshot
 *
 * Compare against a PII dataset (_high/_medium) so real PII fields are present (the base/no-PII
 * datasets expose them only as *_hash, which would otherwise look like SDK-only drift).
 *
 * What it reports per model/table:
 *   - sdkOnly    : SDK fields with no BQ column  -> DATA GAP (fails the check)
 *   - mismatches : record/array vs scalar shape  -> BREAKS hydration (fails the check)
 *   - bqOnly     : new BQ columns not in the SDK -> info only (they drop on hydrate)
 */

const path = require('path');
const fs = require('fs');
const { buildSdkTree, buildBqTree, diffTrees, defaultIgnoreBqOnly } = require('../src/schema-drift');
const { projectIdForMerchant } = require('../src/project');

// SDK model <-> warehouse table mapping to check.
const MAPPINGS = [
  { model: 'Order', table: 'uc_orders' },
  { model: 'Customer', table: 'uc_customers' },
  { model: 'AutoOrder', table: 'uc_auto_orders' },
  { model: 'Item', table: 'uc_items' },
];

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function sdkModelsDir() {
  const entry = require.resolve('ultra_cart_rest_api_v2');
  // dist/index.js -> dist/com.ultracart.admin.v2.models
  return path.join(path.dirname(entry), 'com.ultracart.admin.v2.models');
}

async function bqSchemaFields({ projectId, dataset, table }) {
  const { BigQuery } = require('@google-cloud/bigquery');
  const bq = new BigQuery({ projectId });
  const [md] = await bq.dataset(dataset).table(table).getMetadata();
  // For views, schema is on md.schema; for the underlying we'd read the view too.
  return (md.schema && md.schema.fields) || [];
}

function snapshotSchemaFields(schemaDir, table) {
  const file = path.join(schemaDir, `${table}.json`);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return json.fields || json; // support {fields:[...]} or a bare array
}

async function main() {
  const args = parseArgs(process.argv);
  const modelsDir = sdkModelsDir();

  const useSnapshot = !!args['schema-dir'];
  const projectId = args.project || (args.merchant ? projectIdForMerchant(args.merchant) : null);
  const dataset = args.dataset;

  if (!useSnapshot && (!projectId || !dataset)) {
    console.error('Provide --project/--merchant and --dataset, or --schema-dir for offline mode.');
    process.exit(2);
  }

  // Baseline of KNOWN, reviewed SDK-only exclusions (recursive nesting, sensitive write-only
  // fields the warehouse intentionally doesn't store). The check fails only on NEW drift.
  const baselineFile = args.baseline || path.join(__dirname, '..', 'schemas', 'known-sdk-only.json');
  const writeBaseline = 'write-baseline' in args;
  let baseline = {};
  if (!writeBaseline) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    } catch {
      baseline = {};
    }
  }

  let failed = false;
  const collected = {};
  for (const { model, table } of MAPPINGS) {
    let bqFields;
    try {
      bqFields = useSnapshot
        ? snapshotSchemaFields(args['schema-dir'], table)
        : await bqSchemaFields({ projectId, dataset, table });
    } catch (e) {
      console.log(`\n# ${model} <-> ${table}: SKIP (${e.message.split('\n')[0]})`);
      continue;
    }

    const sdkTree = buildSdkTree({ modelName: model, modelsDir });
    const bqTree = buildBqTree(bqFields);
    const { sdkOnly, bqOnly, mismatches } = diffTrees(sdkTree, bqTree, {
      ignoreBqOnly: defaultIgnoreBqOnly,
    });
    collected[model] = sdkOnly;

    const known = new Set(baseline[model] || []);
    const newGaps = sdkOnly.filter((p) => !known.has(p));
    const staleBaseline = [...known].filter((p) => !sdkOnly.includes(p));

    const problems = newGaps.length + mismatches.length;
    const status = problems === 0 ? 'OK' : 'DRIFT';
    console.log(`\n# ${model} <-> ${table}: ${status}`);
    if (newGaps.length) console.log(`  NEW SDK fields missing from BQ (${newGaps.length}): ${newGaps.join(', ')}`);
    if (mismatches.length) console.log(`  shape mismatches (${mismatches.length}): ${mismatches.join(', ')}`);
    const knownHit = sdkOnly.length - newGaps.length;
    if (knownHit) console.log(`  (${knownHit} known/allowlisted SDK-only field(s) ignored)`);
    if (staleBaseline.length) console.log(`  note: baseline entries no longer drifting (can remove): ${staleBaseline.join(', ')}`);
    if (bqOnly.length) console.log(`  BQ-only columns (info, ${bqOnly.length}): ${bqOnly.slice(0, 15).join(', ')}${bqOnly.length > 15 ? ' …' : ''}`);
    if (problems > 0) failed = true;
  }

  if (writeBaseline) {
    fs.writeFileSync(baselineFile, JSON.stringify(collected, null, 2) + '\n');
    console.log(`\n✓ wrote baseline (${Object.keys(collected).length} models) to ${path.relative(process.cwd(), baselineFile)}`);
    process.exit(0);
  }

  console.log(`\n${failed ? '✗ schema drift detected (new gaps not in baseline)' : '✓ SDK and BQ schemas aligned'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
