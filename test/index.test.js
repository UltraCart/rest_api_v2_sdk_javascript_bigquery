'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sdk = require('../src/index');

/**
 * The published entry point. Anything reachable from here is public API for consumers of
 * @ultracart/bigquery-sdk, so removing or renaming one of these is a breaking change even
 * when every other test still passes. This pins the surface so that can't happen silently.
 */
const EXPECTED_EXPORTS = {
  UltraCartBigQuery: 'function',
  DEFAULT_MAX_BYTES_BILLED: 'number',
  DEFAULT_PAGE_SIZE: 'number',
  resolveDataset: 'function',
  projectIdForMerchant: 'function',
  DATASET_STANDARD: 'string',
  DATASET_MEDIUM: 'string',
  DATASET_HIGH: 'string',
  DATASET_STREAMING: 'string',
  transformRows: 'function',
  toBigQueryDatetime: 'function',
};

test('index exposes exactly the documented public surface', () => {
  for (const [name, type] of Object.entries(EXPECTED_EXPORTS)) {
    assert.equal(typeof sdk[name], type, `export ${name} should be a ${type}`);
  }

  // Catches accidental additions too — an unintended export is a maintenance commitment.
  assert.deepEqual(
    Object.keys(sdk).sort(),
    Object.keys(EXPECTED_EXPORTS).sort(),
    'unexpected or missing export at the package entry point',
  );
});

test('the documented default constants hold their published values', () => {
  // Both are quoted in the README and CHANGELOG; changing either is consumer-visible.
  assert.equal(sdk.DEFAULT_MAX_BYTES_BILLED, 10 * 1024 * 1024 * 1024, '10 GB cost cap');
  assert.equal(sdk.DEFAULT_PAGE_SIZE, 50000);
});

test('entry-point exports are the same functions the modules export', () => {
  // index.js re-exports by hand, so a typo could bind a name to the wrong implementation.
  const project = require('../src/project');
  const transform = require('../src/transform');
  const { UltraCartBigQuery } = require('../src/client');

  assert.equal(sdk.UltraCartBigQuery, UltraCartBigQuery);
  assert.equal(sdk.resolveDataset, project.resolveDataset);
  assert.equal(sdk.projectIdForMerchant, project.projectIdForMerchant);
  assert.equal(sdk.transformRows, transform.transformRows);
  assert.equal(sdk.toBigQueryDatetime, transform.toBigQueryDatetime);
});

test('the package entry point resolves to the tested module', () => {
  // package.json "main" must point at what these tests exercise, or the published package
  // could ship a different entry than the one under test.
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'src/index.js');
  assert.equal(require.resolve('../' + pkg.main), require.resolve('../src/index'));
});
