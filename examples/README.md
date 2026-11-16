# Examples

Runnable scripts showing how to extract UltraCart data from BigQuery into native SDK objects.
There are two patterns per entity:

- **`*-full.js`** — one-time **full backfill** (stream the entire history to seed your store).
- **`*-cdc.js`** — ongoing **change-data-capture** (pull everything that changed — new *and*
  updated — since a timestamp, via the streaming changelog's `RecordTime`).

| Entity | Full backfill | Change-data-capture | View table | SDK model | Id column |
|---|---|---|---|---|---|
| Orders | [`orders-full.js`](orders-full.js) | [`orders-cdc.js`](orders-cdc.js) | `uc_orders` | `Order` | `order_id` |
| Customers | [`customers-full.js`](customers-full.js) | [`customers-cdc.js`](customers-cdc.js) | `uc_customers` | `Customer` | `customer_profile_oid` |
| Auto orders | [`auto-orders-full.js`](auto-orders-full.js) | [`auto-orders-cdc.js`](auto-orders-cdc.js) | `uc_auto_orders` | `AutoOrder` | `auto_order_oid` |
| Items | [`items-full.js`](items-full.js) | [`items-cdc.js`](items-cdc.js) | `uc_items` | `Item` | `merchant_item_oid` |
| Analytics sessions | — | [`analytics-sessions-cdc.js`](analytics-sessions-cdc.js) | `uc_analytics_sessions` | none (plain objects) | `client_session_oid` |

Plus one complete job: **[`daily-sync.js`](daily-sync.js)** — orders CDC **and** delete detection
with a file-backed watermark, ready to put on a schedule. Start there if you are replacing a
daily REST API pull.

## Prerequisites

1. Authenticate with Google Application Default Credentials:
   ```bash
   gcloud auth application-default login          # dev
   # or: export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   ```
2. Install peer deps alongside this package:
   ```bash
   npm install @ultracart/bigquery-sdk ultra_cart_rest_api_v2 @google-cloud/bigquery
   ```

## Running

```bash
# Full backfill (merchant id is the first arg)
node examples/orders-full.js ACME

# CDC (merchant id + an ISO-8601 "since" timestamp)
node examples/orders-cdc.js ACME 2026-06-22T00:00:00Z

# Scheduled sync: initialize the watermark once after the backfill, then run on a schedule
node examples/daily-sync.js ACME --init 2026-06-22T00:00:00Z
node examples/daily-sync.js ACME
```

## Daily sync and deletes

The `*-cdc.js` examples take the "since" timestamp on the command line. A real job has to
remember it. `daily-sync.js` shows the whole loop:

1. Capture the run's **start** time before querying. That becomes the next watermark.
2. Upsert every changed order (view joined to `uc_order_streaming` on `RecordTime`).
3. Delete every order whose **newest** changelog row since the watermark has `IsDelete = TRUE`.
   The view filters deleted records out, so step 2 alone never sees them.
4. Save the watermark only after steps 2 and 3 commit. A failed run repeats the same window.

The watermark lives in `./.uc-watermark.json` (override with `UC_WATERMARK_FILE`).

The merchant's BigQuery project is derived as `ultracart-dw-{merchantid}`. Override the project
or datasets with environment variables:

| Env var | Default | Purpose |
|---|---|---|
| `UC_PROJECT_ID` | `ultracart-dw-{merchantid}` | Query a specific project directly |
| `UC_VIEW_DATASET` | `ultracart_dw` | The view dataset (see dataset selection below) |
| `UC_STREAMING_DATASET` | `ultracart_dw_streaming` | The changelog dataset (CDC only) |
| `UC_WATERMARK_FILE` | `./.uc-watermark.json` | Where `daily-sync.js` keeps its watermark |

## Choosing a dataset

The examples default to the **standard single-account** datasets, which is correct for most
merchants and contain **no PII** (names/emails appear only as `*_hash`).

- **Need customer PII** (names, emails, addresses)? Use a higher taxonomy tier:
  ```bash
  UC_VIEW_DATASET=ultracart_dw_medium node examples/customers-full.js ACME   # or _high
  ```
- **Parent / umbrella account** whose data spans multiple child merchant ids? Use the linked
  family (and filter or omit `merchant_id` to scope):
  ```bash
  UC_VIEW_DATASET=ultracart_dw_linked \
  UC_STREAMING_DATASET=ultracart_dw_linked_streaming \
  node examples/orders-cdc.js ACME 2026-06-22T00:00:00Z
  ```
  For PII on a parent account, set `UC_VIEW_DATASET=ultracart_dw_linked_medium` (or `_high`).
  The changelog side stays `ultracart_dw_linked_streaming`: there is one streaming dataset per
  account regardless of tier, and the CDC subquery only reads ids from it.

See [`../docs/EXTRACTION.md`](../docs/EXTRACTION.md) for the full guide (linked accounts, PII
tiers, cost/pruning, watermarks, and the CDC pattern in depth).

## Note

Each example writes to a stubbed `upsert()` / `void record` sink — replace it with your store's
write, and make it **idempotent on the entity's id column** so re-runs are safe.
