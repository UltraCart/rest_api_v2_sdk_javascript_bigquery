'use strict';

/**
 * Full backfill of ITEMS (catalog) — stream the entire catalog once to seed your store.
 * Constant memory (async iterator). Make your write idempotent on merchant_item_oid.
 *
 * Datasets: defaults to the standard single-account dataset `ultracart_dw`. Items carry
 * little/no PII, but the same tier override applies:
 *   - Higher tier:           UC_VIEW_DATASET=ultracart_dw_medium   (or _high)
 *   - Parent/umbrella account: UC_VIEW_DATASET=ultracart_dw_linked (+ _medium/_high) —
 *                             the linked tables span ALL child merchant ids.
 *
 * Run:
 *   node examples/items-full.js ACME
 *   UC_PROJECT_ID=ultracart-dw-acme node examples/items-full.js ACME
 */

const { UltraCartBigQuery } = require('../src');
const UltraCartApi = require('ultra_cart_rest_api_v2');

const VIEW = process.env.UC_VIEW_DATASET || 'ultracart_dw';

async function main() {
  const merchantId = process.argv[2] || 'DEMO';
  const projectId = process.env.UC_PROJECT_ID;
  const ucbq = new UltraCartBigQuery(projectId ? { projectId } : { merchantId });

  const sql = `SELECT * FROM ${VIEW}.uc_items WHERE merchant_id = @mid`;
  const params = { mid: merchantId };

  const est = await ucbq.dryRun(sql, { params });
  console.log(`Backfill items from ${ucbq.projectId}.${VIEW}: ~${est.gigabytesProcessed.toFixed(2)} GB (~$${est.estimatedCostUsd.toFixed(2)}).`);

  let count = 0;
  for await (const item of ucbq.query(sql, { params, model: UltraCartApi.Item })) {
    await upsert(item); // <-- your idempotent (by merchant_item_oid) write
    count += 1;
    if (count % 10000 === 0) console.log(`  …${count}`);
  }
  console.log(`Backfilled ${count} items.`);
}

async function upsert(record) { void record; }

main().catch((e) => { console.error(e); process.exit(1); });
