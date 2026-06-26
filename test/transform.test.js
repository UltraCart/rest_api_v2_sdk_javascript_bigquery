'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { transformRows, toIso8601, toNumber, isPrimitiveArrayField, toBigQueryDatetime } = require('../src/transform');
const { projectIdForMerchant } = require('../src/project');
const { UltraCartBigQuery } = require('../src/client');
const UltraCartApi = require('ultra_cart_rest_api_v2');

/**
 * Mimics how @google-cloud/bigquery returns scalar wrappers: each carries a `.value`.
 * The transformer must unwrap these via schema, not via instanceof.
 */
const wrap = (value) => ({ value });

/**
 * A representative slice of the uc_orders schema covering every transform branch:
 *   - DATETIME (UTC wall-clock, no zone)  -> ISO 8601 Z
 *   - TIMESTAMP (zoned)                   -> ISO 8601 Z
 *   - DATE                                -> passthrough YYYY-MM-DD
 *   - INTEGER / NUMERIC                   -> Number
 *   - primitive array (REPEATED RECORD{value}) -> string[]
 *   - object array   (REPEATED RECORD{many})   -> [{...}]
 *   - object array with single non-`value` field (Tags -> {tag_value}) NOT flattened
 *   - nested RECORD                       -> {...}
 */
const SCHEMA_FIELDS = [
  { name: 'order_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'merchant_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'creation_dts', type: 'DATETIME', mode: 'NULLABLE' },
  { name: 'last_update_ts', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'ship_on_date', type: 'DATE', mode: 'NULLABLE' },
  { name: 'exchange_rate', type: 'NUMERIC', mode: 'NULLABLE' },
  {
    name: 'billing',
    type: 'RECORD',
    mode: 'NULLABLE',
    fields: [
      { name: 'first_name', type: 'STRING', mode: 'NULLABLE' },
      { name: 'day_phone', type: 'STRING', mode: 'NULLABLE' },
      // primitive array: string[]  (REPEATED RECORD with single `value`)
      { name: 'cc_emails', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'value', type: 'STRING', mode: 'NULLABLE' }] },
    ],
  },
  {
    // object array: Array<OrderItem>
    name: 'items',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [
      { name: 'merchant_item_id', type: 'STRING', mode: 'NULLABLE' },
      { name: 'quantity', type: 'INTEGER', mode: 'NULLABLE' },
    ],
  },
  {
    // object array NOT flattened: single field but named tag_value, not value
    name: 'Tags',
    type: 'RECORD',
    mode: 'REPEATED',
    fields: [{ name: 'tag_value', type: 'STRING', mode: 'NULLABLE' }],
  },
];

/** One row as @google-cloud/bigquery would surface it (scalars wrapped, nesting intact). */
const RAW_ROW = {
  order_id: 'DEMO-1001',
  merchant_id: 'DEMO',
  creation_dts: wrap('2025-01-15 10:30:00'), // DATETIME, space sep, no zone
  last_update_ts: wrap('2025-01-15T10:35:00.000Z'), // TIMESTAMP, zoned
  ship_on_date: wrap('2025-01-16'), // DATE
  exchange_rate: wrap('1.250000'), // NUMERIC as string
  billing: {
    first_name: 'Ada',
    day_phone: '555-0100',
    cc_emails: [wrap('a@example.com'), wrap('b@example.com')],
  },
  items: [
    { merchant_item_id: 'WIDGET', quantity: wrap('2') },
    { merchant_item_id: 'GADGET', quantity: wrap('1') },
  ],
  Tags: [{ tag_value: 'vip' }, { tag_value: 'loyalty' }],
};

test('toIso8601 normalizes DATETIME to UTC with Z', () => {
  assert.equal(toIso8601(wrap('2025-01-15 10:30:00'), 'DATETIME'), '2025-01-15T10:30:00Z');
  assert.equal(toIso8601('2025-01-15T10:30:00', 'DATETIME'), '2025-01-15T10:30:00Z');
  assert.equal(toIso8601(wrap('2025-01-15T10:30:00.123456'), 'DATETIME'), '2025-01-15T10:30:00.123456Z');
});

test('toIso8601 leaves DATE/TIME untouched and normalizes TIMESTAMP', () => {
  assert.equal(toIso8601(wrap('2025-01-16'), 'DATE'), '2025-01-16');
  assert.equal(toIso8601(wrap('2025-01-15T10:35:00.000Z'), 'TIMESTAMP'), '2025-01-15T10:35:00.000Z');
});

test('toNumber normalizes numeric strings/wrappers, passes through null', () => {
  assert.equal(toNumber(wrap('1.250000')), 1.25);
  assert.equal(toNumber('42'), 42);
  assert.equal(toNumber(null), null);
});

test('isPrimitiveArrayField only fires on REPEATED RECORD with a single `value` field', () => {
  assert.equal(isPrimitiveArrayField(SCHEMA_FIELDS[6].fields[2]), true); // billing.cc_emails
  assert.equal(isPrimitiveArrayField(SCHEMA_FIELDS[8]), false); // Tags (tag_value)
  assert.equal(isPrimitiveArrayField(SCHEMA_FIELDS[7]), false); // items (multi-field)
});

test('toBigQueryDatetime strips the zone for DATETIME filter params (inverse of toIso8601)', () => {
  // the Z the library emits on read must be removed for a DATETIME column comparison
  assert.equal(toBigQueryDatetime('2026-06-25T21:41:40Z'), '2026-06-25T21:41:40');
  assert.equal(toBigQueryDatetime('2026-06-25T21:41:40.493Z'), '2026-06-25T21:41:40.493');
  assert.equal(toBigQueryDatetime('2026-06-25 21:41:40'), '2026-06-25T21:41:40');
  // round-trips with toIso8601
  assert.equal(toBigQueryDatetime(toIso8601('2026-06-25 21:41:40', 'DATETIME')), '2026-06-25T21:41:40');
  // non-UTC offset normalized to UTC wall-clock first
  assert.equal(toBigQueryDatetime('2026-06-25T16:41:40-05:00'), '2026-06-25T21:41:40.000');
  assert.equal(toBigQueryDatetime(null), null);
});

test('transformRows produces SDK-shaped plain objects', () => {
  const [row] = transformRows([RAW_ROW], SCHEMA_FIELDS);

  // dates
  assert.equal(row.creation_dts, '2025-01-15T10:30:00Z');
  assert.equal(row.last_update_ts, '2025-01-15T10:35:00.000Z');
  assert.equal(row.ship_on_date, '2025-01-16');

  // numbers
  assert.equal(row.exchange_rate, 1.25);

  // primitive array flattened
  assert.deepEqual(row.billing.cc_emails, ['a@example.com', 'b@example.com']);

  // nested record preserved
  assert.equal(row.billing.first_name, 'Ada');

  // object array preserved + inner number normalized
  assert.equal(row.items.length, 2);
  assert.deepEqual(row.items[0], { merchant_item_id: 'WIDGET', quantity: 2 });

  // object array with non-`value` single field NOT flattened
  assert.deepEqual(row.Tags, [{ tag_value: 'vip' }, { tag_value: 'loyalty' }]);
});

test('round-trip: transform + hydrate into a real SDK Order instance', () => {
  const ucbq = new UltraCartBigQuery({ merchantId: 'DEMO', bigquery: {} });
  const [order] = ucbq.hydrate([RAW_ROW], SCHEMA_FIELDS, UltraCartApi.Order);

  assert.ok(order instanceof UltraCartApi.Order, 'should be a real Order instance');
  assert.equal(order.order_id, 'DEMO-1001');
  assert.equal(order.creation_dts, '2025-01-15T10:30:00Z');
  assert.equal(order.exchange_rate, 1.25);

  // nested OrderBilling hydrated, primitive array intact
  assert.ok(order.billing instanceof UltraCartApi.OrderBilling, 'billing -> OrderBilling');
  assert.deepEqual(order.billing.cc_emails, ['a@example.com', 'b@example.com']);

  // items hydrated into OrderItem instances
  assert.ok(order.items[0] instanceof UltraCartApi.OrderItem, 'items[] -> OrderItem');
  assert.equal(order.items[0].merchant_item_id, 'WIDGET');
  assert.equal(order.items[0].quantity, 2);
});

test('projectIdForMerchant derives ultracart-dw-{merchantid}', () => {
  assert.equal(projectIdForMerchant('DEMO'), 'ultracart-dw-demo');
  assert.equal(projectIdForMerchant('Widgets'), 'ultracart-dw-widgets');
  assert.throws(() => projectIdForMerchant(''), /merchantId is required/);
});
