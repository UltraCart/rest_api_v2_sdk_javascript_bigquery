'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { UltraCartBigQuery, DEFAULT_MAX_BYTES_BILLED, DEFAULT_PAGE_SIZE } = require('../src/client');
const UltraCartApi = require('ultra_cart_rest_api_v2');

const wrap = (value) => ({ value }); // mimic @google-cloud/bigquery scalar wrappers

const SCHEMA_FIELDS = [
  { name: 'order_id', type: 'STRING', mode: 'NULLABLE' },
  { name: 'creation_dts', type: 'DATETIME', mode: 'NULLABLE' },
];

/**
 * Fake @google-cloud/bigquery client that paginates over `pages` and records the job config.
 * getQueryResults(autoPaginate:false) returns [rows, nextQuery, apiResponse]; schema only on
 * the first page (as the real API does once results are materialized).
 */
function makeFakeBigQuery({ pages, captured, bytesProcessed = '2147483648' }) {
  return {
    createQueryJob: async (cfg) => {
      captured.jobConfig = cfg;
      captured.pageQueries = [];
      let call = 0;
      const job = {
        metadata: { statistics: { totalBytesProcessed: bytesProcessed } },
        getQueryResults: async (q) => {
          captured.pageQueries.push(q);
          const rows = pages[call];
          const apiResponse = call === 0 ? { schema: { fields: SCHEMA_FIELDS } } : {};
          const next =
            call < pages.length - 1
              ? { autoPaginate: false, maxResults: q.maxResults, pageToken: `tok${call}` }
              : null;
          call += 1;
          return [rows, next, apiResponse];
        },
      };
      return [job];
    },
  };
}

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

test('query() streams across pages and hydrates SDK instances', async () => {
  const captured = {};
  const pages = [
    [{ order_id: 'A-1', creation_dts: wrap('2025-01-15 10:30:00') },
     { order_id: 'A-2', creation_dts: wrap('2025-01-16 11:00:00') }],
    [{ order_id: 'A-3', creation_dts: wrap('2025-01-17 12:00:00') }],
  ];
  const bigquery = makeFakeBigQuery({ pages, captured });
  const ucbq = new UltraCartBigQuery({ projectId: 'ultracart-dw-demo', bigquery });

  const orders = await collect(
    ucbq.query('SELECT * FROM ultracart_dw.uc_orders', { model: UltraCartApi.Order }),
  );

  assert.equal(orders.length, 3, 'streams all rows across both pages');
  assert.ok(orders[0] instanceof UltraCartApi.Order);
  assert.equal(orders[0].order_id, 'A-1');
  // DATETIME transformed to ISO 8601 Z even though schema only came on page 1
  assert.equal(orders[0].creation_dts, '2025-01-15T10:30:00Z');
  assert.equal(orders[2].creation_dts, '2025-01-17T12:00:00Z');
  // two pages were fetched
  assert.equal(captured.pageQueries.length, 2);
});

test('query() captures schema from a later page when the first page is a pre-completion poll', async () => {
  // Simulates a slow query: first getQueryResults returns before the job completes — no rows,
  // no schema — then the next page carries both. Schema must be captured from the page that
  // has it, or every row hydrates empty (regression guard).
  const captured = { pageQueries: [] };
  let call = 0;
  const bigquery = {
    createQueryJob: async (cfg) => {
      captured.jobConfig = cfg;
      const job = {
        metadata: { statistics: {} },
        getQueryResults: async (q) => {
          captured.pageQueries.push(q);
          if (call++ === 0) {
            // pre-completion poll: empty rows, empty apiResponse (no schema), but more to come
            return [[], { autoPaginate: false, maxResults: q.maxResults, pageToken: 'p1' }, {}];
          }
          return [
            [{ order_id: 'Z-1', creation_dts: wrap('2025-02-01 09:00:00') }],
            null,
            { schema: { fields: SCHEMA_FIELDS } },
          ];
        },
      };
      return [job];
    },
  };
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery });
  const orders = await collect(ucbq.query('SELECT * FROM t', { model: UltraCartApi.Order }));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].order_id, 'Z-1', 'fields populated despite schema arriving on page 2');
  assert.equal(orders[0].creation_dts, '2025-02-01T09:00:00Z');
});

test('query() applies the default 10 GB cost cap', async () => {
  const captured = {};
  const bigquery = makeFakeBigQuery({ pages: [[]], captured });
  const ucbq = new UltraCartBigQuery({ projectId: 'ultracart-dw-demo', bigquery });
  await collect(ucbq.query('SELECT 1'));
  assert.equal(captured.jobConfig.maximumBytesBilled, String(DEFAULT_MAX_BYTES_BILLED));
});

test('query() allows overriding and disabling the cost cap', async () => {
  const captured = {};
  let ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages: [[]], captured }) });
  await collect(ucbq.query('SELECT 1', { maxBytesBilled: 5000 }));
  assert.equal(captured.jobConfig.maximumBytesBilled, '5000');

  const captured2 = {};
  ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages: [[]], captured: captured2 }) });
  await collect(ucbq.query('SELECT 1', { maxBytesBilled: 0 }));
  assert.equal('maximumBytesBilled' in captured2.jobConfig, false, '0 disables the cap');
});

test('constructor maxBytesBilled:0 disables the default cap', async () => {
  const captured = {};
  const ucbq = new UltraCartBigQuery({ projectId: 'p', maxBytesBilled: 0, bigquery: makeFakeBigQuery({ pages: [[]], captured }) });
  await collect(ucbq.query('SELECT 1'));
  assert.equal('maximumBytesBilled' in captured.jobConfig, false);
});

test('constructor requires a merchantId or an explicit projectId', () => {
  // Without this the client would build a BigQuery instance with projectId undefined and
  // fail much later, at query time, with an opaque error from the API.
  assert.throws(() => new UltraCartBigQuery(), /merchantId or an explicit projectId/);
  assert.throws(() => new UltraCartBigQuery({}), /merchantId or an explicit projectId/);
  assert.throws(
    () => new UltraCartBigQuery({ bigquery: {} }),
    /merchantId or an explicit projectId/,
  );
});

test('explicit projectId overrides merchantId derivation', () => {
  const ucbq = new UltraCartBigQuery({
    merchantId: 'DEMO',
    projectId: 'ultracart-dw-override',
    bigquery: {},
  });
  assert.equal(ucbq.projectId, 'ultracart-dw-override');
});

test('query() without a model yields plain SDK-shaped objects', async () => {
  const captured = {};
  const pages = [[{ order_id: 'P-1', creation_dts: wrap('2025-03-01 08:00:00') }]];
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages, captured }) });

  const [row] = await collect(ucbq.query('SELECT * FROM t'));

  assert.equal(row instanceof UltraCartApi.Order, false, 'no model -> not hydrated');
  assert.deepEqual(row, { order_id: 'P-1', creation_dts: '2025-03-01T08:00:00Z' });
  assert.equal(Object.getPrototypeOf(row), Object.prototype, 'a plain object');
});

test('query() forwards named parameters to the job config', async () => {
  // Named params are the library's safe alternative to string-interpolating SQL. If they
  // stopped reaching createQueryJob, queries would fail or silently match nothing.
  const captured = {};
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages: [[]], captured }) });

  const params = { since: '2025-01-01T00:00:00', merchant: 'DEMO' };
  await collect(ucbq.query('SELECT * FROM t WHERE creation_dts >= @since', { params }));

  assert.deepEqual(captured.jobConfig.params, params);
  assert.equal(captured.jobConfig.query, 'SELECT * FROM t WHERE creation_dts >= @since');
});

test('query() page size defaults to 50k and honors both override levels', async () => {
  const captured = {};
  let ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages: [[]], captured }) });
  await collect(ucbq.query('SELECT 1'));
  assert.equal(captured.pageQueries[0].maxResults, DEFAULT_PAGE_SIZE, 'default');
  assert.equal(captured.pageQueries[0].autoPaginate, false, 'manual pagination');

  // constructor-level override
  const captured2 = {};
  ucbq = new UltraCartBigQuery({ projectId: 'p', pageSize: 1000, bigquery: makeFakeBigQuery({ pages: [[]], captured: captured2 }) });
  await collect(ucbq.query('SELECT 1'));
  assert.equal(captured2.pageQueries[0].maxResults, 1000);

  // per-query override wins over the constructor
  const captured3 = {};
  ucbq = new UltraCartBigQuery({ projectId: 'p', pageSize: 1000, bigquery: makeFakeBigQuery({ pages: [[]], captured: captured3 }) });
  await collect(ucbq.query('SELECT 1', { pageSize: 25 }));
  assert.equal(captured3.pageQueries[0].maxResults, 25);
});

test('constructs a real @google-cloud/bigquery client when none is injected', () => {
  // Every other test injects a fake client, so nothing else would notice a breaking change
  // in @google-cloud/bigquery itself. This exercises the real constructor and the methods
  // query()/dryRun() depend on. No network and no credentials: the BigQuery client resolves
  // auth lazily, on first request, not at construction.
  const ucbq = new UltraCartBigQuery({ merchantId: 'DEMO' });
  assert.equal(ucbq.projectId, 'ultracart-dw-demo', 'merchantId derives the project id');
  assert.equal(ucbq.bigquery.constructor.name, 'BigQuery');
  assert.equal(typeof ucbq.bigquery.createQueryJob, 'function', 'query() depends on this');
  assert.equal(typeof ucbq.bigquery.dataset, 'function', 'the drift checker depends on this');
});

test('dryRun() estimates bytes/GB/cost without running', async () => {
  const captured = {};
  // 2 GiB processed
  const bigquery = makeFakeBigQuery({ pages: [[]], captured, bytesProcessed: String(2 * 1024 ** 3) });
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery });
  const est = await ucbq.dryRun('SELECT * FROM ultracart_dw.uc_orders');
  assert.equal(captured.jobConfig.dryRun, true);
  assert.equal(est.totalBytesProcessed, 2 * 1024 ** 3);
  assert.equal(est.gigabytesProcessed, 2);
  assert.ok(Math.abs(est.estimatedCostUsd - (2 / 1024) * 6.25) < 1e-9);
});

test('dryRun() reports zero when the job carries no byte statistics', async () => {
  // A dry run against a fully-cached or trivial query can come back without
  // totalBytesProcessed. Returning 0 beats NaN propagating into a cost estimate.
  const bigquery = {
    createQueryJob: async () => [{ metadata: {} }],
  };
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery });
  const est = await ucbq.dryRun('SELECT 1');

  assert.equal(est.totalBytesProcessed, 0);
  assert.equal(est.gigabytesProcessed, 0);
  assert.equal(est.estimatedCostUsd, 0);
});

test('dryRun() forwards named parameters', async () => {
  const captured = {};
  const ucbq = new UltraCartBigQuery({ projectId: 'p', bigquery: makeFakeBigQuery({ pages: [[]], captured }) });
  await ucbq.dryRun('SELECT * FROM t WHERE id = @id', { params: { id: 'X-1' } });

  assert.deepEqual(captured.jobConfig.params, { id: 'X-1' });
  assert.equal(captured.jobConfig.dryRun, true);
});
