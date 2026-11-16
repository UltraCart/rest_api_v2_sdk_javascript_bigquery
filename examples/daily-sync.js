'use strict';

/**
 * A complete scheduled sync job for ORDERS: the shape to copy into a nightly cron or
 * scheduled task. It pulls every order that was created, changed, or deleted since the last
 * successful run, and keeps its own watermark on disk.
 *
 * Seed your store once with orders-full.js, then run this on a schedule. The first run
 * needs a starting point, so it refuses to run until a watermark exists:
 *   node examples/daily-sync.js ACME --init 2026-06-22T00:00:00Z   # once, after the backfill
 *   node examples/daily-sync.js ACME                                # every run after that
 *
 * How it stays correct:
 *  - The watermark is the time this run STARTED, captured before any query, so anything
 *    written while the run is in flight is picked up again next time.
 *  - The watermark is saved only after every write succeeds. A failed run changes nothing
 *    and the next run repeats the same window, so writes must be idempotent on order_id.
 *  - No partition_date filter on the changelog: partition_date is the week an order was
 *    CREATED, so a filter would silently drop edits to older orders.
 *  - Deletes come from the changelog too. The view filters deleted records out, so the
 *    change query alone never reports them.
 *
 * Datasets and watermark path can be overridden via env vars:
 *   UC_VIEW_DATASET       default ultracart_dw          (ultracart_dw_medium/_high for PII,
 *                                                         ultracart_dw_linked* for a parent)
 *   UC_STREAMING_DATASET  default ultracart_dw_streaming (ultracart_dw_linked_streaming
 *                                                         for a parent account)
 *   UC_WATERMARK_FILE     default ./.uc-watermark.json
 *   UC_PROJECT_ID         default ultracart-dw-{merchantid}
 */

const fs = require('node:fs/promises');
const { UltraCartBigQuery, toBigQueryDatetime } = require('../src');
const UltraCartApi = require('ultra_cart_rest_api_v2');

const VIEW = process.env.UC_VIEW_DATASET || 'ultracart_dw';
const STREAMING = process.env.UC_STREAMING_DATASET || 'ultracart_dw_streaming';
const WATERMARK_FILE = process.env.UC_WATERMARK_FILE || './.uc-watermark.json';

async function loadWatermark() {
  try {
    return JSON.parse(await fs.readFile(WATERMARK_FILE, 'utf8')).since;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveWatermark(since) {
  // Write then rename, so a crash mid-write cannot leave a truncated watermark behind.
  const tmp = `${WATERMARK_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ since }, null, 2));
  await fs.rename(tmp, WATERMARK_FILE);
}

async function main() {
  const merchantId = process.argv[2];
  if (!merchantId) {
    console.error('Usage: node examples/daily-sync.js <MERCHANT_ID> [--init <since ISO8601>]');
    process.exit(1);
  }

  if (process.argv[3] === '--init') {
    if (!process.argv[4]) throw new Error('--init needs a starting ISO 8601 timestamp');
    await saveWatermark(new Date(process.argv[4]).toISOString());
    console.log(`Watermark initialized to ${process.argv[4]} in ${WATERMARK_FILE}.`);
    return;
  }

  const since = await loadWatermark();
  if (!since) {
    console.error(`No watermark in ${WATERMARK_FILE}. Backfill with orders-full.js first, then`);
    console.error('run: node examples/daily-sync.js <MERCHANT_ID> --init <when the backfill started>');
    process.exit(1);
  }

  const startedAt = new Date().toISOString(); // becomes the next watermark
  const projectId = process.env.UC_PROJECT_ID;
  const ucbq = new UltraCartBigQuery(projectId ? { projectId } : { merchantId });
  const params = { mid: merchantId, since: toBigQueryDatetime(since) };

  // 1. New and changed orders: current state from the view, for every id with a changelog
  //    row since the watermark. List the columns you store instead of SELECT * to cut cost.
  const changedSql = `SELECT * FROM ${VIEW}.uc_orders
                       WHERE merchant_id = @mid
                         AND order_id IN (
                               SELECT order_id FROM ${STREAMING}.uc_order_streaming
                                WHERE merchant_id = @mid AND RecordTime > @since
                             )`;
  let changed = 0;
  for await (const order of ucbq.query(changedSql, { params, model: UltraCartApi.Order })) {
    await upsertOrder(order);
    changed += 1;
  }

  // 2. Deleted orders: ids whose NEWEST changelog row since the watermark is a delete.
  //    Taking only the newest row means an order deleted and then re-created inside the
  //    window is not reported as deleted (step 1 already upserted it).
  const deletedSql = `SELECT order_id FROM (
                        SELECT order_id, IsDelete,
                               ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY RecordTime DESC) AS rn
                          FROM ${STREAMING}.uc_order_streaming
                         WHERE merchant_id = @mid AND RecordTime > @since
                      )
                      WHERE rn = 1 AND IsDelete`;
  let deleted = 0;
  for await (const row of ucbq.query(deletedSql, { params })) {
    await deleteOrder(row.order_id);
    deleted += 1;
  }

  // 3. Only now, with every write committed, advance the watermark.
  await saveWatermark(startedAt);
  console.log(`${merchantId}: ${changed} changed, ${deleted} deleted since ${since}. Next run from ${startedAt}.`);
}

async function upsertOrder(order) { void order; }   // <-- your write, keyed on order_id
async function deleteOrder(orderId) { void orderId; } // <-- your delete, keyed on order_id

main().catch((e) => { console.error(e); process.exit(1); });
