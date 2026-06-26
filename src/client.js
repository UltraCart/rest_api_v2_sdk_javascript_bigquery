'use strict';

const { BigQuery } = require('@google-cloud/bigquery');
const { projectIdForMerchant } = require('./project');
const { transformRecord } = require('./transform');

/** Default ceiling on bytes billed per query: 10 GB. Matches the uc-bq skill default. */
const DEFAULT_MAX_BYTES_BILLED = 10 * 1024 * 1024 * 1024;
/**
 * Rows fetched per page while streaming. Bounds memory; one page is held at a time.
 * 50k chosen empirically: streaming is round-trip bound, and larger pages mean far fewer
 * HTTP fetches (e.g. 456k sparse rows: ~24s at 10k/page vs ~10s at 100k/page). 50k balances
 * throughput against per-page memory for wide rows. Override per client or per query.
 */
const DEFAULT_PAGE_SIZE = 50000;
/** BigQuery on-demand analysis pricing, USD per TiB scanned (for dryRun estimates). */
const USD_PER_TIB = 6.25;

/**
 * UltraCartBigQuery — query the UltraCart data warehouse and stream back native JS SDK model
 * instances.
 *
 * Results are delivered as an async iterator so a full-history backfill (hundreds of
 * thousands of orders) and an incremental sync share the same constant-memory path.
 *
 * @example
 *   const { UltraCartBigQuery } = require('rest_api_v2_sdk_javascript_bigquery');
 *   const UltraCartApi = require('ultra_cart_rest_api_v2');
 *
 *   const ucbq = new UltraCartBigQuery({ merchantId: 'DEMO' });
 *   for await (const order of ucbq.query(
 *     'SELECT * FROM ultracart_dw.uc_orders WHERE creation_dts >= @since',
 *     { params: { since: '2025-01-01' }, model: UltraCartApi.Order }
 *   )) {
 *     // order is a real UltraCartApi.Order instance
 *   }
 */
class UltraCartBigQuery {
  /**
   * @param {object} options
   * @param {string} [options.merchantId] Merchant id; project derived as ultracart-dw-{id}.
   * @param {string} [options.projectId]  Explicit project id (overrides merchantId derivation).
   * @param {import('@google-cloud/bigquery').BigQuery} [options.bigquery] Inject a client
   *        (testing / custom auth). If omitted, a client is created using ADC.
   * @param {number} [options.maxBytesBilled] Default per-query byte ceiling. Defaults to
   *        10 GB. Pass 0 or null to disable the default cap.
   * @param {number} [options.pageSize] Rows fetched per page while streaming (default 50000).
   */
  constructor(options = {}) {
    const { merchantId, projectId, bigquery, maxBytesBilled, pageSize } = options;
    this.projectId = projectId || (merchantId ? projectIdForMerchant(merchantId) : undefined);
    if (!this.projectId) {
      throw new Error('Provide either a merchantId or an explicit projectId');
    }
    // Distinguish "not provided" (use default) from "explicitly 0/null" (disable cap).
    this.maxBytesBilled = maxBytesBilled === undefined ? DEFAULT_MAX_BYTES_BILLED : maxBytesBilled;
    this.pageSize = pageSize || DEFAULT_PAGE_SIZE;
    this.bigquery = bigquery || new BigQuery({ projectId: this.projectId });
  }

  /**
   * Run a SQL query and stream each result row as an SDK model instance (or, without
   * `model`, a plain SDK-shaped object). Returns an async iterator — iterate with
   * `for await`. Rows are fetched a page at a time, so memory stays bounded regardless of
   * result size.
   *
   * @param {string} sql Standard SQL. Use named params (@name) for safety.
   * @param {object} [opts]
   * @param {object} [opts.params] Named query parameters.
   * @param {Function} [opts.model] An UltraCart SDK model class (e.g. UltraCartApi.Order).
   * @param {number} [opts.maxBytesBilled] Per-query byte ceiling override (0/null disables).
   * @param {number} [opts.pageSize] Per-page row count override.
   * @returns {AsyncGenerator<object>} async iterator of SDK instances / shaped objects.
   */
  async *query(sql, opts = {}) {
    const { params, model } = opts;
    const limit = opts.maxBytesBilled === undefined ? this.maxBytesBilled : opts.maxBytesBilled;
    const pageSize = opts.pageSize || this.pageSize;

    const [job] = await this.bigquery.createQueryJob({
      query: sql,
      params,
      ...(limit ? { maximumBytesBilled: String(limit) } : {}),
    });

    // Manual pagination: getQueryResults(autoPaginate:false) returns
    // [rows, nextQuery, apiResponse]. The result schema (which drives the transform) lives on
    // apiResponse.schema. For a slow query the FIRST page can return before the job completes —
    // no schema and no rows yet — so capture the schema from whichever page carries it (a page
    // with rows always carries the schema), not just the first. nextQuery carries the pageToken
    // and is null/undefined when the result set is exhausted.
    let nextQuery = { autoPaginate: false, maxResults: pageSize };
    let schemaFields = [];

    do {
      const [rows, following, apiResponse] = await job.getQueryResults(nextQuery);
      const pageSchema = apiResponse && apiResponse.schema && apiResponse.schema.fields;
      if (pageSchema && pageSchema.length) schemaFields = pageSchema;
      for (const row of rows) {
        yield this.hydrateRow(row, schemaFields, model);
      }
      nextQuery = following;
    } while (nextQuery);
  }

  /**
   * Estimate what a query would cost WITHOUT running it (BigQuery dry run). Useful before a
   * large backfill, since LIMIT does not reduce bytes scanned.
   *
   * @param {string} sql
   * @param {object} [opts]
   * @param {object} [opts.params] Named query parameters.
   * @returns {Promise<{totalBytesProcessed:number, gigabytesProcessed:number,
   *           estimatedCostUsd:number}>}
   */
  async dryRun(sql, opts = {}) {
    const { params } = opts;
    const [job] = await this.bigquery.createQueryJob({ query: sql, params, dryRun: true });
    const bytes = Number(
      (job.metadata && job.metadata.statistics && job.metadata.statistics.totalBytesProcessed) || 0,
    );
    return {
      totalBytesProcessed: bytes,
      gigabytesProcessed: bytes / (1024 * 1024 * 1024),
      estimatedCostUsd: (bytes / (1024 * 1024 * 1024 * 1024)) * USD_PER_TIB,
    };
  }

  /**
   * Transform a single raw BigQuery row (+ schema) and optionally hydrate it into an SDK
   * model instance via `model.constructFromObject`.
   *
   * @param {object} row A parsed @google-cloud/bigquery result row.
   * @param {Array} schemaFields BigQuery result schema `fields`.
   * @param {Function} [model] SDK model class with a static constructFromObject(data).
   * @returns {object}
   */
  hydrateRow(row, schemaFields, model) {
    const shaped = transformRecord(row, schemaFields);
    if (model && typeof model.constructFromObject === 'function') {
      return model.constructFromObject(shaped);
    }
    return shaped;
  }

  /**
   * Transform + hydrate an array of rows. Convenience for callers who already have rows in
   * hand (e.g. tests, or running their own job). Prefer query() for streaming.
   *
   * @param {Array<object>} rows
   * @param {Array} schemaFields BigQuery result schema `fields`.
   * @param {Function} [model] SDK model class with a static constructFromObject(data).
   * @returns {Array<object>}
   */
  hydrate(rows, schemaFields, model) {
    return rows.map((row) => this.hydrateRow(row, schemaFields, model));
  }
}

module.exports = {
  UltraCartBigQuery,
  DEFAULT_MAX_BYTES_BILLED,
  DEFAULT_PAGE_SIZE,
};
