'use strict';

/**
 * Change-data-capture for ANALYTICS SESSIONS (storefront visits) — pull the current state of
 * every session that CHANGED (new OR updated) since a timestamp, using the streaming
 * changelog's RecordTime.
 *
 * Sessions have no REST API model, so this passes no `model` and receives plain objects.
 * Unlike hydrated models, plain objects keep every selected column, including `*_hash` ones.
 *
 * Datasets: defaults to the standard single-account datasets `ultracart_dw` /
 * `ultracart_dw_streaming`. Override via env vars:
 *   - Parent/umbrella account: UC_VIEW_DATASET=ultracart_dw_linked
 *                              UC_STREAMING_DATASET=ultracart_dw_linked_streaming
 *
 * Why two queries: the sessions view is very large, and almost all of a run's cost is the
 * view side. The changelog side is cheap to scan in full (a few MB on RecordTime), so:
 *   1. Ask the changelog, unbounded, for the OLDEST partition_date among changed sessions.
 *   2. Read the view with partition_date >= that value, passed as a query parameter so
 *      BigQuery can prune partitions (a subquery in the filter would not prune).
 * The bound is exact: a session that changes long after it started (an order or customer
 * attached late, a correction) widens that one run automatically instead of being missed.
 * On a measured account a typical run read about 0.03 GB in total; a run that has to reach
 * a session from three months back read about 0.4 GB. partition_date is the session's week
 * on both the view and the changelog, the same convention as the order tables.
 *
 * Notes:
 *  - RecordTime is a DATETIME — strip the trailing Z with toBigQueryDatetime().
 *  - Select columns explicitly. `hits` (every page view in the session) makes `SELECT *`
 *    many times more expensive; add it only if you need page-level detail.
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
  const params = { mid: merchantId, since: toBigQueryDatetime(since) };

  // 1. The oldest partition any changed session lives in. Cheap: no partition filter needed.
  const boundSql = `SELECT MIN(partition_date) AS from_partition
                      FROM ${STREAMING}.uc_analytics_session_streaming
                     WHERE merchant_id = @mid AND RecordTime > @since`;
  let fromPartition = null;
  for await (const row of ucbq.query(boundSql, { params })) fromPartition = row.from_partition;

  let count = 0;
  if (fromPartition) {
    // 2. Current state of the changed sessions, pruned to the partitions they can be in.
    const sql = `SELECT ${COLUMNS} FROM ${VIEW}.uc_analytics_sessions
                  WHERE merchant_id = @mid
                    AND partition_date >= @from_partition
                    AND client_session_oid IN (
                          SELECT client_session_oid
                            FROM ${STREAMING}.uc_analytics_session_streaming
                           WHERE merchant_id = @mid AND RecordTime > @since
                        )`;
    for await (const session of ucbq.query(sql, {
      params: { ...params, from_partition: fromPartition },
    })) {
      await upsert(session); // <-- your idempotent (by client_session_oid) write
      count += 1;
    }
  }

  console.log(`Synced ${count} changed sessions for ${merchantId} since ${since}.`);
  console.log(`Next run: --since ${startedAt}`);
}

async function upsert(record) { void record; }

main().catch((e) => { console.error(e); process.exit(1); });
