# Extracting order history into your application

This guide covers the two real-world flows for pulling UltraCart order data out of BigQuery
into your own system (e.g. a loyalty portal): a one-time **backfill** of full history, and an
ongoing **incremental sync**. It also explains how to pick the right dataset (linked parent
accounts and PII tiers), which trips up most first extracts.

> The library exposes **raw SQL only** — you write the `SELECT`, pass a model class, and
> stream hydrated SDK objects. There are no `getOrders()`-style helpers; the patterns below
> are SQL + a few lines of JavaScript.

---

## 1. Authentication

Uses Google Application Default Credentials (ADC). Nothing in code.

```bash
# Local / developer
gcloud auth application-default login

# Server / scheduled (loyalty-portal backend)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

For a server, register the service-account email in the UltraCart dashboard; UltraCart
provisions read access at the **taxonomy level** you're granted (this is what gates PII —
see §3).

---

## 2. Picking the dataset: linked (parent) accounts

UltraCart projects (`ultracart-dw-{merchantid}`) expose more than one dataset:

| Dataset | Holds |
|---|---|
| `ultracart_dw` | This single account's data, **no PII** (PII fields appear only as `*_hash`) |
| `ultracart_dw_linked` | **All** merchant ids under a parent/umbrella account (no PII) |
| `ultracart_dw_medium`, `ultracart_dw_high` | Same as base but **with PII**, taxonomy-gated |
| `ultracart_dw_linked_medium`, `ultracart_dw_linked_high` | Linked + PII |
| `ultracart_dw_streaming`, `_import`, `_ml`, `_work` | Analytics / internal |

**The rule that matters:** if the account is a **parent** of linked child accounts, its order
history lives in the **`ultracart_dw_linked*`** tables, which span every merchant id under it.
An *administrative-only* parent may have an **empty base `ultracart_dw`** — querying the base
would return zero orders even though the account has hundreds of thousands.

So a parent extracting "all our orders" queries the linked dataset and (optionally) filters by
`merchant_id`:

```sql
SELECT * FROM ultracart_dw_linked.uc_orders
WHERE merchant_id = @merchant_id     -- one child account
-- omit the filter to get ALL merchant ids under the parent
```

> **`merchant_id` is case-sensitive.** e.g. `ACME` and `acme` are distinct values in the
> data even though the *project id* is always lowercased. Filter with the exact case.

> The `_linked` tables are **views**, so their `numRows`/partitioning metadata reads as empty —
> that's expected; the data is real.

---

## 3. PII lives in the `_medium` / `_high` datasets

The base/`_linked` datasets are **no-PII**: customer names, emails, and addresses are present
only as `*_hash` columns (e.g. `billing.first_name_hash`, `billing.email_hash`,
`billing.cc_emails_hashes`). The SDK models have no `*_hash` properties, so those simply drop
on hydration — and `billing.first_name` will be `undefined`.

To get real customer identity for a loyalty portal, query the taxonomy-gated PII dataset you've
been granted:

```sql
SELECT * FROM ultracart_dw_linked_medium.uc_orders   -- has billing.first_name, cc_emails, ...
WHERE merchant_id = @merchant_id
```

---

## 4. Cost: estimate before you scan

BigQuery bills by **bytes scanned**, and **`LIMIT` does not reduce it**. `uc_orders` is very
wide, so `SELECT *` over full history scans a lot. Two habits:

- **Estimate first** with `dryRun()`.
- **Select only the columns you need** when you don't need the whole `Order`.

### Pruning does NOT work through the `_linked` views — column selection is the only lever

The underlying streaming/base table **is** partitioned (by `partition_date`, a **weekly**
column — each value is the Sunday that starts the order's creation week). Filtering on
`partition_date` prunes partitions **when you query that base table directly**.

But the **`ultracart_dw_linked*` tables are views**, and they **do not push row predicates down
to partition pruning**. Measured on a real parent account (via `ultracart_dw_linked`): a
`SELECT *` scans the same number of bytes whether you add `creation_dts >= …`, `partition_date >= …`,
`merchant_id = …`, or no filter at all. Those `WHERE` clauses still correctly limit the **rows
returned** — they just don't reduce **bytes scanned**.

Consequences for parent/umbrella accounts (whose data lives only in the linked view):

- **`SELECT` only the columns you need.** Column pruning *does* work through the view (it's
  columnar). E.g. selecting 4 columns instead of `*` dropped the same query from 1.352 GB to
  0.166 GB. This is your main cost control.
- **Date filters don't save money here** — a frequent incremental sync re-scans the full
  (selected) columns every run. Pick a sensible cadence, and keep the column list tight.
- To get real partition pruning, you must query the **underlying partitioned table** directly
  rather than the linked view (see the open question in §6).

```js
const est = await ucbq.dryRun(sql, { params });
console.log(`${est.gigabytesProcessed.toFixed(2)} GB (~$${est.estimatedCostUsd.toFixed(2)})`);
```

Every `query()` is capped at **10 GB billed by default** (override per call with
`maxBytesBilled`, or `0` to disable). A runaway query aborts instead of billing a fortune.

---

## 5. Backfill (one-time full history)

Stream the whole history once to seed your store. Because `query()` is an async iterator, this
is constant-memory regardless of row count — a **single pass** over all history:

```js
const sql = `SELECT * FROM ultracart_dw.uc_orders   -- use ultracart_dw_linked for a parent account
             WHERE merchant_id = @mid
             ORDER BY creation_dts`;
for await (const order of ucbq.query(sql, { params: { mid }, model: UltraCartApi.Order })) {
  await upsertIntoYourStore(order);   // idempotent on order_id
}
```

Make the write **idempotent on `order_id`** (upsert) so a re-run after a failure is safe.

> **Do not chunk a `_linked`-view backfill by date to "bound" it.** Because the view doesn't
> prune (§4), each date chunk re-scans the full table — so N chunks cost ≈ N× a single pass.
> One streaming pass is the cheapest option. Date-chunking only helps when you can query a
> genuinely partitioned base table (then each chunk scans just its partitions).
>
> The biggest cost lever is **selecting only the columns you need** instead of `SELECT *`.

There is a `*-full.js` example per entity:
[`orders-full.js`](../examples/orders-full.js), [`customers-full.js`](../examples/customers-full.js),
[`auto-orders-full.js`](../examples/auto-orders-full.js), [`items-full.js`](../examples/items-full.js).

---

## 6. Incremental sync (ongoing)

After the backfill, keep current by pulling only what changed since the last run, tracked with a
**watermark** you persist between runs. The recommended approach is **change-data-capture**
(below) — it catches new **and** updated records. A simpler *new-only* variant just filters the
view by `creation_dts >= @since`, but it misses later edits (refunds, shipments, status changes):

```sql
-- new-only (misses updates) — prefer the CDC pattern below
SELECT * FROM ultracart_dw.uc_orders
WHERE merchant_id = @mid AND creation_dts >= @since
```

> **Gotcha — filtering DATETIME columns.** `creation_dts` (and `refund_dts`, `reject_dts`) are
> BigQuery **DATETIME** columns (UTC, no zone). The library *emits* ISO strings with a trailing
> `Z` on read (`"2026-06-25T21:41:40Z"`), but BigQuery **rejects** that `Z` in a DATETIME
> comparison ("Invalid datetime string"). Strip it with the exported helper before using a
> value as a filter param:
> ```js
> const { toBigQueryDatetime } = require('@ultracart/bigquery-sdk');
> const params = { since: toBigQueryDatetime(watermark) }; // '2026-06-25T21:41:40Z' -> '...40'
> ```

Two correctness details:

- **Lookback overlap + dedup.** Use `>=` with the watermark shifted back a few minutes
  (or re-pull from the start of the watermark's day), and **dedup by `order_id`** on write
  (the upsert handles this). This avoids dropping orders that share the boundary timestamp or
  that land slightly out of order.
- **Advance the watermark** to the max `creation_dts` actually streamed, and persist it only
  after the batch is committed.

### Catching updates: change-data-capture via the streaming changelog

A `creation_dts` watermark catches **new** orders only — not **changes** to existing ones
(refunds, shipments, status changes). The deduped view has no "last modified" column, and
`partition_date` is the **creation** week, not the change time — so neither can detect updates.

But the **underlying streaming changelog** can. `<dataset>.uc_order_streaming` keeps a row per
order *version*, each stamped with **`RecordTime`**. So "what changed since T" is just the set
of order_ids with a changelog row newer than T — then fetch their current state from the view,
in **one query**:

```sql
SELECT * FROM ultracart_dw.uc_orders        -- _medium/_high for PII; _linked* for a parent acct
 WHERE merchant_id = @mid
   AND order_id IN (
         SELECT order_id
           FROM ultracart_dw_streaming.uc_order_streaming
          WHERE merchant_id = @mid
            AND RecordTime > @since                          -- the change cursor
       )
```

This catches new **and** updated records — including edits to years-old ones. There is a
`*-cdc.js` example per entity:
[`orders-cdc.js`](../examples/orders-cdc.js), [`customers-cdc.js`](../examples/customers-cdc.js),
[`auto-orders-cdc.js`](../examples/auto-orders-cdc.js), [`items-cdc.js`](../examples/items-cdc.js).
Each joins its view to its `uc_*_streaming` changelog on the entity's id column (`order_id`,
`customer_profile_oid`, `auto_order_oid`, `merchant_item_oid`).

Two things to get right:
- **`RecordTime` is a `DATETIME`** — strip the `Z` with `toBigQueryDatetime(since)` (§6 gotcha).
- **Do NOT add a `partition_date` filter to the changelog subquery.** `partition_date` is the
  order's *creation* week, so a recently-changed *old* order sits in an old partition and a
  partition filter would silently drop it. The `RecordTime` scan is columnar and cheap (~a few
  MB), so just scan it.
- **Deletes** are rare and intentionally ignored here: a deleted order's latest changelog row is
  `IsDelete`, which the view filters out, so it simply won't be returned. Handle separately only
  if you need hard deletes.

Advance your watermark to the time you **started** the run (not the max row time), so anything
written mid-run is re-examined next time.

---

## 7. Quick reference

| Goal | Dataset | Cursor / filter |
|---|---|---|
| Standard single account | `ultracart_dw` | `merchant_id = 'ACME'` |
| Parent — all child accounts | `ultracart_dw_linked` | `merchant_id` optional |
| One child of a parent | `ultracart_dw_linked` | `merchant_id = 'ACME'` |
| Need customer name/email | `ultracart_dw_linked_medium` (or `_high`) | — |
| Full backfill | per above | single streaming pass, no date chunks |
| New orders since last run | per above | `creation_dts >= watermark` (+ lookback) |
| New **and updated** orders (CDC) | view + `uc_order_streaming` | `RecordTime > watermark` subquery |
