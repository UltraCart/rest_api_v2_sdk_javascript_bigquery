# UltraCart REST API V2 — JavaScript SDK · BigQuery extension

Query the UltraCart data warehouse directly in BigQuery and get back **native UltraCart JS
SDK model instances** (`Order`, `Customer`, `AutoOrder`, …) — the same objects you already
use against the REST API. Ideal for bulk extracts (order history, customer data, loyalty
portals) where hammering the REST API would be slow and wasteful.

> Status: **early release (0.3.0).** Core auth + transformer + SDK hydration working and
> unit-tested. See the [CHANGELOG](./CHANGELOG.md) for release notes and
> [CONTRIBUTING](./CONTRIBUTING.md) to get involved.

## Why

The warehouse tables are generated from the same domain model that powers the REST API, so
the structures line up 1:1 with the SDK models. Only two structural differences exist
between BigQuery and the SDK, which this library handles automatically:

1. **Dates** — BigQuery `DATETIME` (UTC) → ISO 8601 string with `Z`.
2. **Primitive arrays** — `string[]`/`number[]` are stored as a `REPEATED RECORD { value }`
   and flattened back to a primitive array.

(Plus numeric normalization to JS `Number`.)

## Install

```bash
npm install @ultracart/bigquery-sdk ultra_cart_rest_api_v2 @google-cloud/bigquery
```

**Requires Node.js 22 or newer.** This follows `@google-cloud/bigquery` v9, which sets the
same floor. Node 18 and 20 are both past end-of-life; if you are still on one of them, stay
on `@ultracart/bigquery-sdk@0.1.x`, which tracks `@google-cloud/bigquery` v8.

## Authentication

Uses Google Application Default Credentials (ADC) — no keys in code:

```bash
# Developer machine
gcloud auth application-default login

# Server / CI
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

The service-account email is registered in the UltraCart dashboard, which provisions
read access to your warehouse project at the assigned taxonomy (PII) level.

## Usage

`query()` returns an **async iterator** — results stream a page at a time, so the same code
handles a small incremental sync and a full-history backfill with constant memory.

```js
const { UltraCartBigQuery } = require('@ultracart/bigquery-sdk');
const UltraCartApi = require('ultra_cart_rest_api_v2');

// Project is derived as ultracart-dw-{merchantId}
const ucbq = new UltraCartBigQuery({ merchantId: 'DEMO' });

const sql = `SELECT * FROM ultracart_dw.uc_orders
             WHERE creation_dts >= @since
             ORDER BY creation_dts`;

for await (const order of ucbq.query(sql, { params: { since: '2025-01-01' }, model: UltraCartApi.Order })) {
  // order is a real UltraCartApi.Order instance:
  //   order.creation_dts      -> "2025-01-15T10:30:00Z"
  //   order.billing.cc_emails -> ["a@example.com", "b@example.com"]  (medium/high datasets)
  //   order.items[0]          -> OrderItem instance
}
```

Omit `model` to stream plain SDK-shaped objects instead of hydrated instances.

### Estimate cost before a big extract

`LIMIT` does **not** reduce bytes scanned, so estimate first:

```js
const est = await ucbq.dryRun(sql, { params: { since: '2025-01-01' } });
console.log(`${est.gigabytesProcessed.toFixed(2)} GB (~$${est.estimatedCostUsd.toFixed(2)})`);
```

Every query is capped at **10 GB billed by default** (overridable per call with
`maxBytesBilled`, or `0` to disable) — a runaway `SELECT *` aborts instead of billing a
fortune.

## Incremental sync (change data capture)

For a recurring job (a nightly order pull, a loyalty sync), don't re-read history and don't
filter on `creation_dts`: that misses refunds, shipments, and status changes on older orders.
Every view has a **changelog** in the streaming dataset (`uc_order_streaming`,
`uc_customer_streaming`, `uc_auto_order_streaming`, `uc_item_streaming`,
`uc_analytics_session_streaming`) with one row per version of each record, stamped with
`RecordTime` and flagged `IsDelete` on deletion. Ask it which ids changed, and read their
current state from the view:

```js
const { UltraCartBigQuery, toBigQueryDatetime, DATASET_STREAMING } = require('@ultracart/bigquery-sdk');

const startedAt = new Date().toISOString();          // the NEXT run's watermark
const sql = `SELECT * FROM ultracart_dw.uc_orders
              WHERE merchant_id = @mid
                AND order_id IN (
                      SELECT order_id FROM ${DATASET_STREAMING}.uc_order_streaming
                       WHERE merchant_id = @mid AND RecordTime > @since)`;

for await (const order of ucbq.query(sql, {
  params: { mid: 'DEMO', since: toBigQueryDatetime(lastWatermark) },
  model: UltraCartApi.Order,
})) {
  await upsert(order);                                // idempotent on order_id
}
await saveWatermark(startedAt);                       // only after every write commits
```

Rules that keep it correct:

- **Watermark = the run's start time**, saved only after all writes commit.
- **Upsert on the entity id**, so a failed run can simply repeat.
- **No fixed `partition_date` window.** It is the creation week; edits to old records live in
  old partitions. To prune a very large view (analytics sessions), look up the oldest changed
  partition in the changelog first and pass it as a parameter, as the sessions example does.
- **`toBigQueryDatetime()`** on the watermark: `RecordTime` is a `DATETIME` and rejects the `Z`.
- **Deletes** never come back from the view. Query the changelog for ids whose newest row is
  `IsDelete`.

[`examples/daily-sync.js`](examples/daily-sync.js) is the complete job (changes, deletes, and a
file-backed watermark). Per-entity CDC scripts and the sessions variant are listed in
[`examples/`](examples/README.md); the reasoning is in [`docs/EXTRACTION.md`](docs/EXTRACTION.md).

### Datasets & linked (parent) accounts

- Base `ultracart_dw` holds a single account's data with **no PII** (PII fields appear only
  as `*_hash`). `ultracart_dw_low` is the next tier up and still hashes PII.
- **Parent/umbrella accounts** keep data in the **`ultracart_dw_linked*`** datasets, which
  span **all** of the parent's merchant ids — query those (and filter by `merchant_id`) to
  cover every account. Their changelog dataset is `ultracart_dw_linked_streaming`.
- **Customer PII** (names, emails, addresses, raw `cc_emails`) lives only in the
  **`_medium` / `_high`** taxonomy datasets, e.g. `ultracart_dw_linked_medium`.
- There is one streaming (changelog) dataset per account regardless of tier.

Every name is exported as a constant: `DATASET_STANDARD`, `DATASET_LOW`, `DATASET_MEDIUM`,
`DATASET_HIGH`, `DATASET_STREAMING`, `DATASET_LINKED`, `DATASET_LINKED_LOW`,
`DATASET_LINKED_MEDIUM`, `DATASET_LINKED_HIGH`, `DATASET_LINKED_STREAMING`. `resolveDataset({
linked, taxonomy })` builds the view names from flags.

## Develop

```bash
npm test   # no-network unit tests (synthetic BigQuery rows -> SDK instances)
```

### Schema drift guard

This library relies on SDK model field names matching BigQuery columns 1:1. A guard verifies
that and fails on drift (e.g. the SDK regenerates with a new field that the warehouse lacks):

```bash
# Live check against a PII-tier dataset (so real fields are present, not just *_hash)
npm run check:schema -- --project=ultracart-dw-<merchant> --dataset=ultracart_dw_high

# After an intentional, reviewed change, refresh the accepted-exclusions baseline
npm run baseline:schema -- --project=ultracart-dw-<merchant> --dataset=ultracart_dw_high
```

Known, reviewed SDK-only fields (recursive nesting like `customer_profile.orders`, and
sensitive write-only fields like `password`) are recorded in
[`schemas/known-sdk-only.json`](schemas/known-sdk-only.json); the check fails only on **new**
drift. The pure diff logic is covered by `npm test`; CI runs the live check on a schedule when
GCP credentials are configured.
