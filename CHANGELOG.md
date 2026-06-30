# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-30

### Added
- Initial release: `UltraCartBigQuery` client that streams UltraCart data-warehouse rows and
  hydrates them into native `ultra_cart_rest_api_v2` SDK model instances.
- Async-iterator `query()` with constant-memory pagination (default page size 50,000).
- Default `maximumBytesBilled` cap (10 GB, overridable; `0` disables) and `dryRun()` cost
  estimation.
- Generic, schema-driven row transformer: BigQuery `DATETIME` → ISO 8601 (UTC `Z`); single-
  `value` `REPEATED RECORD` → primitive array; numeric normalization.
- `toBigQueryDatetime()` helper for filtering `DATETIME` columns (inverse of the read-side
  date transform).
- `projectIdForMerchant()` and `resolveDataset()` helpers; dataset constants.
- Schema-drift guard (`scripts/check-schema-drift.js`, `npm run check:schema`) comparing SDK
  model field trees to the warehouse schema, with a reviewed baseline in
  `schemas/known-sdk-only.json`.
- Per-entity examples for full backfill and change-data-capture (orders, customers, auto
  orders, items), plus the extraction guide in `docs/EXTRACTION.md`.

[Unreleased]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/releases/tag/v0.1.0
