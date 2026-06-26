'use strict';

/**
 * Project-id derivation and dataset conventions for the UltraCart data warehouse.
 *
 * Each merchant's BigQuery project is derived deterministically from the merchant id:
 *   merchant "DEMO" -> project "ultracart-dw-demo"
 *
 * Authentication is handled by Google Application Default Credentials (ADC) — the same
 * model the uc-bq tooling uses. Callers authenticate out-of-band via either:
 *   - `gcloud auth application-default login`           (developer machines), or
 *   - GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json   (server / CI),
 * and the @google-cloud/bigquery client picks them up automatically. No keys in code.
 *
 * @module project
 */

/**
 * Derive the BigQuery project id for a merchant.
 * @param {string} merchantId e.g. "DEMO"
 * @returns {string} e.g. "ultracart-dw-demo"
 */
function projectIdForMerchant(merchantId) {
  if (!merchantId || typeof merchantId !== 'string') {
    throw new Error('merchantId is required to derive the BigQuery project id');
  }
  return `ultracart-dw-${merchantId.trim().toLowerCase()}`;
}

/** Standard (no-PII) dataset. */
const DATASET_STANDARD = 'ultracart_dw';
/** Medium dataset — contains PII; access gated by taxonomy level. */
const DATASET_MEDIUM = 'ultracart_dw_medium';
/** High dataset — contains PII; access gated by taxonomy level. */
const DATASET_HIGH = 'ultracart_dw_high';
/** Streaming dataset — analytics & screen recordings (very large tables). */
const DATASET_STREAMING = 'ultracart_dw_streaming';

/**
 * LINKED datasets. When an account is the PARENT of linked child accounts, the linked
 * datasets contain tables that cover ALL of the parent's merchant ids (parent + children),
 * whereas the base `ultracart_dw*` datasets may be EMPTY for the parent. A loyalty/data
 * extract for a parent must therefore read from the linked datasets to get every order
 * across every merchant id.
 *
 * For an administrative-only parent the base `ultracart_dw.uc_orders` can be empty while
 * `ultracart_dw_linked.uc_orders` holds the rows for all of its child merchant ids.
 */
const DATASET_LINKED = 'ultracart_dw_linked';
const DATASET_LINKED_LOW = 'ultracart_dw_linked_low';
const DATASET_LINKED_MEDIUM = 'ultracart_dw_linked_medium';
const DATASET_LINKED_HIGH = 'ultracart_dw_linked_high';
const DATASET_LINKED_STREAMING = 'ultracart_dw_linked_streaming';

/**
 * Resolve the orders/standard dataset to query, accounting for linked parent accounts.
 *
 * @param {object} opts
 * @param {boolean} [opts.linked=false] Query the linked (all-merchant-ids) dataset.
 * @param {'low'|'medium'|'high'} [opts.taxonomy] PII tier; omit for the base (no-PII) set.
 * @returns {string} dataset id, e.g. "ultracart_dw", "ultracart_dw_medium",
 *                   "ultracart_dw_linked", "ultracart_dw_linked_high".
 */
function resolveDataset({ linked = false, taxonomy } = {}) {
  const base = linked ? 'ultracart_dw_linked' : 'ultracart_dw';
  return taxonomy ? `${base}_${taxonomy}` : base;
}

module.exports = {
  projectIdForMerchant,
  resolveDataset,
  DATASET_STANDARD,
  DATASET_MEDIUM,
  DATASET_HIGH,
  DATASET_STREAMING,
  DATASET_LINKED,
  DATASET_LINKED_LOW,
  DATASET_LINKED_MEDIUM,
  DATASET_LINKED_HIGH,
  DATASET_LINKED_STREAMING,
};
