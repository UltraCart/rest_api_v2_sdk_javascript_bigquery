# Contributing

Thanks for your interest in improving the UltraCart REST API V2 JavaScript SDK — BigQuery
extension.

## Getting set up

```bash
git clone https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery
cd rest_api_v2_sdk_javascript_bigquery
npm install
npm test          # runs the offline unit tests (no BigQuery access needed)
```

The unit tests use synthetic BigQuery rows and run with no network or credentials, so they're
safe to run anywhere.

## Running against real BigQuery (optional)

Some checks talk to a live warehouse. Authenticate with Application Default Credentials and
point them at a project you have access to:

```bash
gcloud auth application-default login
node examples/orders-full.js <MERCHANT_ID>
npm run check:schema -- --project=ultracart-dw-<merchant> --dataset=ultracart_dw_high
```

## Project layout

| Path | What |
|---|---|
| `src/` | Library source (`client.js`, `transform.js`, `project.js`, `schema-drift.js`) |
| `test/` | Offline unit tests (`node --test`) |
| `examples/` | Runnable extraction examples (full + CDC per entity) |
| `scripts/` | Dev/CI tooling (schema-drift checker) |
| `docs/` | Long-form guides (`EXTRACTION.md`) |
| `schemas/` | `known-sdk-only.json` drift baseline |

## Guidelines

- **Match the surrounding style.** Plain CommonJS, no build step, no TypeScript.
- **Add tests** for behavior changes. Keep them offline (mock the BigQuery client like the
  existing `test/client.test.js` does).
- **Run `npm test`** before opening a PR; all tests must pass.
- **Schema drift:** if the SDK or warehouse schema legitimately changes the accepted set of
  SDK-only fields, refresh the baseline with `npm run baseline:schema -- --project=… --dataset=…`
  and explain why in the PR.
- **Keep dependencies minimal.** The runtime depends only on `@google-cloud/bigquery`, with
  `ultra_cart_rest_api_v2` as a peer.

## Reporting bugs / requesting features

Open an issue with a clear description, the relevant SQL/dataset, and (for bugs) a minimal
repro. Please don't include real customer PII in issues.

## Security

Do not file security issues publicly — email **support@ultracart.com** instead.
