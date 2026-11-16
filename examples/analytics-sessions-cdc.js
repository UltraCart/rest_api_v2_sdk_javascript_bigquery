'use strict';

/**
 * Change-data-capture for ANALYTICS SESSIONS (storefront visits) — in one query, pull the
 * current state of every session that CHANGED (new OR updated) since a timestamp, using the
 * streaming changelog's RecordTime.
 *
 * Sessions have no REST API model, so this passes no `model` and receives plain objects.
 * Unlike hydrated models, plain objects keep every selected column, including `*_hash` ones.
 *
 * Datasets: defaults to the standard single-account datasets `ultracart_dw` /
 * `ultracart_dw_streaming`. Override via env vars:
 *   - Parent/umbrella account: UC_VIEW_DATASET=ultracart_dw_linked
 *                              UC_STREAMING_DATASET=ultracart_dw_linked_streaming
 *
 * Notes:
 *  - RecordTime is a DATETIME — strip the trailing Z with toBigQueryDatetime().
 *  - Select columns explicitly. `hits` (every page view in the session) makes `SELECT *`
 *    many times more expensive; add it only if you need page-level detail.
 *  - Unlike orders, a session only changes while it is live, so BOTH the view and the
 *    changelog are bounded with partition_date (the session's week). On a measured account
 *    that cut one run from 0.71 GB to 0.03 GB scanned. The bound is relative to `since`,
 *    so a skipped day widens the window automatically. Do NOT copy this bound into the
 *    order/customer/auto-order/item examples: those records change for years.
 *
 * Run:
 *   node examples/analytics-sessions-cdc.js ACME 2026-06-22T00:00:00Z
 */

const { UltraCartBigQuery, toBigQueryDatetime } = require('../src');

const VIEW = process.env.UC_VIEW_DATASET || 'ultracart_dw';
const STREAMING = process.env.UC_STREAMING_DATASET || 'ultracart_dw_streaming';

const COLUMNS = [
  'client_session_oid',
  'client_id',
  'session_dts',
  'first_seen_dts',
  'last_seen_dts',
  'order_id',
  'customer_profile_oid',
  'new_visitor',
  'new_customer',
  'utms',
].join(', ');

async function main() {
  const merchantId = process.argv[2] || 'DEMO';
  const since = process.argv[3];
  if (!since) {
    console.error('Usage: node examples/analytics-sessions-cdc.js <MERCHANT_ID> <since ISO8601>');
    process.exit(1);
  }

  const startedAt = new Date().toISOString(); // next run's watermark — set before querying
  const projectId = process.env.UC_PROJECT_ID;
  const ucbq = new UltraCartBigQuery(projectId ? { projectId } : { merchantId });

  const sql = `SELECT ${COLUMNS} FROM ${VIEW}.uc_analytics_sessions
                WHERE merchant_id = @mid
                  AND partition_date >= DATE_SUB(DATE(@since), INTERVAL 14 DAY)
                  AND client_session_oid IN (
                        SELECT client_session_oid
                          FROM ${STREAMING}.uc_analytics_session_streaming
                         WHERE merchant_id = @mid
                           AND partition_date >= DATE_SUB(DATE(@since), INTERVAL 14 DAY)
                           AND RecordTime > @since
                      )`;
  const params = { mid: merchantId, since: toBigQueryDatetime(since) };

  let count = 0;
  for await (const session of ucbq.query(sql, { params })) {
    await upsert(session); // <-- your idempotent (by client_session_oid) write
    count += 1;
  }
  console.log(`Synced ${count} changed sessions for ${merchantId} since ${since}.`);
  console.log(`Next run: --since ${startedAt}`);
}

async function upsert(record) { void record; }

main().catch((e) => { console.error(e); process.exit(1); });
