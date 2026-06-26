'use strict';

/**
 * Change-data-capture for CUSTOMERS — in one query, pull the current state of every customer
 * that CHANGED (new OR updated) since a timestamp, using the streaming changelog's RecordTime.
 *
 * Datasets: defaults to the standard single-account datasets `ultracart_dw` /
 * `ultracart_dw_streaming` (NO PII). Override via env vars:
 *   - PII:                    UC_VIEW_DATASET=ultracart_dw_medium   (or _high)
 *   - Parent/umbrella account: UC_VIEW_DATASET=ultracart_dw_linked
 *                              UC_STREAMING_DATASET=ultracart_dw_linked_streaming (+ _medium/_high)
 *
 * Notes:
 *  - RecordTime is a DATETIME — strip the trailing Z with toBigQueryDatetime().
 *  - Do NOT filter the changelog subquery by partition_date (it is the creation week).
 *  - Deletes are rare and ignored (the view filters out IsDelete rows).
 *
 * Run:
 *   node examples/customers-cdc.js ACME 2026-06-22T00:00:00Z
 */

const { UltraCartBigQuery, toBigQueryDatetime } = require('../src');
const UltraCartApi = require('ultra_cart_rest_api_v2');

const VIEW = process.env.UC_VIEW_DATASET || 'ultracart_dw';
const STREAMING = process.env.UC_STREAMING_DATASET || 'ultracart_dw_streaming';

async function main() {
  const merchantId = process.argv[2] || 'DEMO';
  const since = process.argv[3];
  if (!since) {
    console.error('Usage: node examples/customers-cdc.js <MERCHANT_ID> <since ISO8601>');
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  const projectId = process.env.UC_PROJECT_ID;
  const ucbq = new UltraCartBigQuery(projectId ? { projectId } : { merchantId });

  const sql = `SELECT * FROM ${VIEW}.uc_customers
                WHERE merchant_id = @mid
                  AND customer_profile_oid IN (
                        SELECT customer_profile_oid FROM ${STREAMING}.uc_customer_streaming
                         WHERE merchant_id = @mid AND RecordTime > @since
                      )`;
  const params = { mid: merchantId, since: toBigQueryDatetime(since) };

  let count = 0;
  for await (const customer of ucbq.query(sql, { params, model: UltraCartApi.Customer })) {
    await upsert(customer); // <-- your idempotent (by customer_profile_oid) write
    count += 1;
  }
  console.log(`Synced ${count} changed customers for ${merchantId} since ${since}.`);
  console.log(`Next run: --since ${startedAt}`);
}

async function upsert(record) { void record; }

main().catch((e) => { console.error(e); process.exit(1); });
