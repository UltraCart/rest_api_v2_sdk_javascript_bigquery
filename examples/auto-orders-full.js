'use strict';

/**
 * Full backfill of AUTO ORDERS (subscriptions) — stream the entire history once to seed your
 * store. Constant memory (async iterator). Make your write idempotent on auto_order_oid.
 *
 * Datasets: defaults to the standard single-account dataset `ultracart_dw` (NO PII —
 * names/emails appear only as *_hash). Override via env var:
 *   - PII:                   UC_VIEW_DATASET=ultracart_dw_medium   (or _high)
 *   - Parent/umbrella account: UC_VIEW_DATASET=ultracart_dw_linked (+ _medium/_high for PII) —
 *                             the linked tables span ALL child merchant ids.
 *
 * Run:
 *   node examples/auto-orders-full.js ACME
 *   UC_PROJECT_ID=ultracart-dw-acme UC_VIEW_DATASET=ultracart_dw_medium node examples/auto-orders-full.js ACME
 */

const { UltraCartBigQuery } = require('../src');
const UltraCartApi = require('ultra_cart_rest_api_v2');

const VIEW = process.env.UC_VIEW_DATASET || 'ultracart_dw';

async function main() {
  const merchantId = process.argv[2] || 'DEMO';
  const projectId = process.env.UC_PROJECT_ID;
  const ucbq = new UltraCartBigQuery(projectId ? { projectId } : { merchantId });

  const sql = `SELECT * FROM ${VIEW}.uc_auto_orders WHERE merchant_id = @mid`;
  const params = { mid: merchantId };

  const est = await ucbq.dryRun(sql, { params });
  console.log(`Backfill auto orders from ${ucbq.projectId}.${VIEW}: ~${est.gigabytesProcessed.toFixed(2)} GB (~$${est.estimatedCostUsd.toFixed(2)}).`);

  let count = 0;
  for await (const autoOrder of ucbq.query(sql, { params, model: UltraCartApi.AutoOrder })) {
    await upsert(autoOrder); // <-- your idempotent (by auto_order_oid) write
    count += 1;
    if (count % 10000 === 0) console.log(`  …${count}`);
  }
  console.log(`Backfilled ${count} auto orders.`);
}

async function upsert(record) { void record; }

main().catch((e) => { console.error(e); process.exit(1); });
