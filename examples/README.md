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
```

The merchant's BigQuery project is derived as `ultracart-dw-{merchantid}`. Override the project
or datasets with environment variables:

| Env var | Default | Purpose |
|---|---|---|
| `UC_PROJECT_ID` | `ultracart-dw-{merchantid}` | Query a specific project directly |
| `UC_VIEW_DATASET` | `ultracart_dw` | The view dataset (see dataset selection below) |
| `UC_STREAMING_DATASET` | `ultracart_dw_streaming` | The changelog dataset (CDC only) |

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
  node examples/orders-cdc.js ACME 2026-06-22T00:00:00Z      # add _medium/_high for PII
  ```

See [`../docs/EXTRACTION.md`](../docs/EXTRACTION.md) for the full guide (linked accounts, PII
tiers, cost/pruning, watermarks, and the CDC pattern in depth).

## Note

Each example writes to a stubbed `upsert()` / `void record` sink — replace it with your store's
write, and make it **idempotent on the entity's id column** so re-runs are safe.
