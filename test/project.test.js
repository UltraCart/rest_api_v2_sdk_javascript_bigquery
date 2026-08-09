'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDataset,
  projectIdForMerchant,
  DATASET_STANDARD,
  DATASET_MEDIUM,
  DATASET_HIGH,
  DATASET_STREAMING,
  DATASET_LINKED,
  DATASET_LINKED_LOW,
  DATASET_LINKED_MEDIUM,
  DATASET_LINKED_HIGH,
  DATASET_LINKED_STREAMING,
} = require('../src/project');

test('resolveDataset covers the linked x taxonomy matrix', () => {
  // base (no-PII), no taxonomy
  assert.equal(resolveDataset(), 'ultracart_dw');
  assert.equal(resolveDataset({}), 'ultracart_dw');

  // taxonomy tiers on the base datasets
  assert.equal(resolveDataset({ taxonomy: 'low' }), 'ultracart_dw_low');
  assert.equal(resolveDataset({ taxonomy: 'medium' }), 'ultracart_dw_medium');
  assert.equal(resolveDataset({ taxonomy: 'high' }), 'ultracart_dw_high');

  // linked datasets — required for a parent account, whose base datasets may be EMPTY
  // while the linked ones carry rows for every child merchant id.
  assert.equal(resolveDataset({ linked: true }), 'ultracart_dw_linked');
  assert.equal(resolveDataset({ linked: true, taxonomy: 'low' }), 'ultracart_dw_linked_low');
  assert.equal(resolveDataset({ linked: true, taxonomy: 'medium' }), 'ultracart_dw_linked_medium');
  assert.equal(resolveDataset({ linked: true, taxonomy: 'high' }), 'ultracart_dw_linked_high');

  // linked:false is explicitly the base set, not a linked one
  assert.equal(resolveDataset({ linked: false, taxonomy: 'high' }), 'ultracart_dw_high');
});

test('resolveDataset agrees with the exported dataset constants', () => {
  // The constants and the resolver are two ways to name the same datasets; if they ever
  // disagree, callers mixing the two would silently query the wrong tier.
  assert.equal(resolveDataset(), DATASET_STANDARD);
  assert.equal(resolveDataset({ taxonomy: 'medium' }), DATASET_MEDIUM);
  assert.equal(resolveDataset({ taxonomy: 'high' }), DATASET_HIGH);
  assert.equal(resolveDataset({ linked: true }), DATASET_LINKED);
  assert.equal(resolveDataset({ linked: true, taxonomy: 'low' }), DATASET_LINKED_LOW);
  assert.equal(resolveDataset({ linked: true, taxonomy: 'medium' }), DATASET_LINKED_MEDIUM);
  assert.equal(resolveDataset({ linked: true, taxonomy: 'high' }), DATASET_LINKED_HIGH);

  // streaming is not reachable via resolveDataset (it is not a taxonomy tier) — assert the
  // constants stand on their own so a rename cannot go unnoticed.
  assert.equal(DATASET_STREAMING, 'ultracart_dw_streaming');
  assert.equal(DATASET_LINKED_STREAMING, 'ultracart_dw_linked_streaming');
});

test('projectIdForMerchant normalizes case and surrounding whitespace', () => {
  assert.equal(projectIdForMerchant('DEMO'), 'ultracart-dw-demo');
  assert.equal(projectIdForMerchant('  DEMO  '), 'ultracart-dw-demo', 'trims');
  assert.equal(projectIdForMerchant('MixedCase'), 'ultracart-dw-mixedcase');
});

test('projectIdForMerchant rejects a missing or non-string merchant id', () => {
  // Failing loudly here beats deriving "ultracart-dw-undefined" and getting an opaque
  // permission error from BigQuery much later.
  assert.throws(() => projectIdForMerchant(), /merchantId is required/);
  assert.throws(() => projectIdForMerchant(''), /merchantId is required/);
  assert.throws(() => projectIdForMerchant(null), /merchantId is required/);
  assert.throws(() => projectIdForMerchant(12345), /merchantId is required/);
});
