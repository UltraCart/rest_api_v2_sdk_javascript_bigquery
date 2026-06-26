'use strict';

const { UltraCartBigQuery, DEFAULT_MAX_BYTES_BILLED, DEFAULT_PAGE_SIZE } = require('./client');
const project = require('./project');
const transform = require('./transform');

module.exports = {
  UltraCartBigQuery,
  DEFAULT_MAX_BYTES_BILLED,
  DEFAULT_PAGE_SIZE,
  resolveDataset: project.resolveDataset,
  projectIdForMerchant: project.projectIdForMerchant,
  DATASET_STANDARD: project.DATASET_STANDARD,
  DATASET_MEDIUM: project.DATASET_MEDIUM,
  DATASET_HIGH: project.DATASET_HIGH,
  DATASET_STREAMING: project.DATASET_STREAMING,
  // low-level mapping, exposed for advanced use
  transformRows: transform.transformRows,
  // helper for filtering DATETIME columns (strips the Z the library emits on read)
  toBigQueryDatetime: transform.toBigQueryDatetime,
};
