'use strict';

/**
 * Generic, schema-driven transformer that converts BigQuery result rows into the shape
 * expected by the UltraCart JS SDK model classes.
 *
 * The UltraCart data warehouse tables are generated from the same domain model that powers
 * the REST API, so field names and nesting already line up 1:1 with the SDK models. Only
 * two structural differences exist, plus number normalization:
 *
 *   1. Dates  — BigQuery stores DATETIME (UTC wall-clock, no zone). The SDK expects an
 *               ISO 8601 string. We emit ISO 8601 with an explicit `Z`.
 *   2. Arrays — A primitive array (e.g. string[]) is stored in BigQuery as a REPEATED
 *               RECORD whose only sub-field is named `value`. We flatten it back to a
 *               primitive array. (Object arrays like `Tags` -> RECORD{tag_value} are NOT
 *               flattened — only the literal single `value` sub-field triggers flattening.)
 *   3. Numbers — INTEGER/NUMERIC may arrive as wrapper objects/strings; normalize to Number.
 *
 * The transform is driven entirely by the BigQuery result *schema* (field name/type/mode),
 * never by runtime `instanceof` checks against @google-cloud/bigquery internals, so it is
 * deterministic and unit-testable with plain objects.
 *
 * @module transform
 */

const DATE_TYPES = new Set(['DATETIME', 'TIMESTAMP', 'DATE', 'TIME']);
const INT_TYPES = new Set(['INTEGER', 'INT64']);
const FLOAT_TYPES = new Set(['FLOAT', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'DECIMAL', 'BIGDECIMAL']);

/**
 * Unwrap a @google-cloud/bigquery scalar wrapper (BigQueryDate, BigQueryDatetime,
 * BigQueryTimestamp, BigQueryTime, BigQueryInt) which all carry a single `value` property.
 * Plain scalars pass through untouched.
 */
function unwrap(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return value.value;
  }
  return value;
}

/**
 * Convert a BigQuery date/datetime value to an ISO 8601 string in UTC.
 *
 * - DATETIME has no zone and UltraCart stores it as UTC wall-clock -> append `Z`.
 * - TIMESTAMP already carries a zone/`Z` -> normalized to a `Z` ISO string.
 * - DATE / TIME are returned as-is (`YYYY-MM-DD` / `HH:MM:SS`).
 */
function toIso8601(raw, type) {
  const v = unwrap(raw);
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);

  if (type === 'DATE' || type === 'TIME') return s;

  if (type === 'TIMESTAMP') {
    // Already zoned (ends with Z or +/-HH:MM). Normalize via Date for a canonical Z form.
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }

  // DATETIME: "YYYY-MM-DD HH:MM:SS[.ffffff]" with no zone -> treat as UTC.
  let iso = s.replace(' ', 'T');
  const hasZone = /[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso);
  if (!hasZone) iso += 'Z';
  return iso;
}

/**
 * Convert an ISO 8601 / Date value into a BigQuery DATETIME literal (no timezone), for use
 * as a query parameter against DATETIME columns like `creation_dts`.
 *
 * This is the INVERSE of toIso8601(): the warehouse's DATETIME columns are UTC wall-clock
 * with no zone, and BigQuery rejects a trailing `Z` ("Invalid datetime string"). Since the
 * library emits `...Z` strings on read, callers naturally feed them back as filters — strip
 * the zone so the comparison works. A non-UTC offset is first normalized to UTC.
 *
 * @example toBigQueryDatetime('2026-06-25T21:41:40Z') -> '2026-06-25T21:41:40'
 * @param {string|Date} value
 * @returns {string} a BigQuery DATETIME literal (or the input unchanged if null/undefined)
 */
function toBigQueryDatetime(value) {
  if (value === null || value === undefined) return value;
  let s = value instanceof Date ? value.toISOString() : String(value);
  s = s.replace(' ', 'T');
  // A non-UTC offset (e.g. +05:00) must be converted to UTC wall-clock first.
  if (/[+-]\d{2}:?\d{2}$/.test(s)) {
    s = new Date(s).toISOString();
  }
  return s.replace(/[zZ]$/, ''); // DATETIME has no timezone
}

/** Normalize a BigQuery numeric value to a JS Number. */
function toNumber(raw) {
  const v = unwrap(raw);
  if (v === null || v === undefined || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

/**
 * Is this schema field a primitive array? i.e. a REPEATED RECORD whose ONLY sub-field is
 * literally named `value`. This is how the warehouse encodes string[]/number[].
 */
function isPrimitiveArrayField(field) {
  return (
    field.mode === 'REPEATED' &&
    field.type === 'RECORD' &&
    Array.isArray(field.fields) &&
    field.fields.length === 1 &&
    field.fields[0].name === 'value'
  );
}

/** Transform a single scalar leaf value according to its schema type. */
function transformScalar(value, type) {
  if (value === null || value === undefined) return value;
  if (DATE_TYPES.has(type)) return toIso8601(value, type);
  if (INT_TYPES.has(type) || FLOAT_TYPES.has(type)) return toNumber(value);
  return unwrap(value);
}

/**
 * Transform one value (scalar | record | array) against its schema field definition.
 */
function transformField(value, field) {
  if (value === null || value === undefined) return value;

  // Primitive array: REPEATED RECORD{ value } -> [v, v, ...]
  if (isPrimitiveArrayField(field)) {
    const inner = field.fields[0];
    return asArray(value).map((el) => transformScalar(unwrap(extractValue(el)), inner.type));
  }

  // Object array: REPEATED RECORD{ ...many } -> [ {..}, {..} ]
  if (field.mode === 'REPEATED' && field.type === 'RECORD') {
    return asArray(value).map((el) => transformRecord(el, field.fields));
  }

  // Repeated scalar (rare in this schema): REPEATED STRING/INT/... -> [scalar, ...]
  if (field.mode === 'REPEATED') {
    return asArray(value).map((el) => transformScalar(el, field.type));
  }

  // Nested object: RECORD (NULLABLE/REQUIRED) -> { ... }
  if (field.type === 'RECORD') {
    return transformRecord(value, field.fields);
  }

  // Leaf scalar
  return transformScalar(value, field.type);
}

/** For a primitive-array element, pull the `value` sub-field out of the struct. */
function extractValue(el) {
  if (el !== null && typeof el === 'object' && !Array.isArray(el) && 'value' in el) {
    return el.value;
  }
  return el;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * Transform a single record (row or nested RECORD) given its schema fields.
 * @param {object} row
 * @param {Array<{name:string,type:string,mode:string,fields?:Array}>} fields
 * @returns {object}
 */
function transformRecord(row, fields) {
  if (row === null || row === undefined) return row;
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(row, field.name)) {
      out[field.name] = transformField(row[field.name], field);
    }
  }
  return out;
}

/**
 * Transform an array of BigQuery result rows into plain SDK-shaped objects.
 * @param {Array<object>} rows  rows from @google-cloud/bigquery getQueryResults()
 * @param {Array} schemaFields  the result schema's `fields` array
 * @returns {Array<object>}
 */
function transformRows(rows, schemaFields) {
  return rows.map((row) => transformRecord(row, schemaFields));
}

module.exports = {
  transformRows,
  transformRecord,
  transformField,
  toBigQueryDatetime,
  // exported for unit testing
  toIso8601,
  toNumber,
  isPrimitiveArrayField,
};
