# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)
- **Node.js 22 is now the minimum supported runtime** (`engines: >=22`, was `>=18`).
- Upgraded `@google-cloud/bigquery` from `^8.3.1` to `^9.0.1`, which sets that same Node
  floor. No API surface of this library changed — `createQueryJob`, `job.getQueryResults`,
  `dataset().table().getMetadata()` and the `{ value }` scalar wrappers the transformer
  relies on all behave identically under v9.
- Node 18 and 20 are both past end-of-life. Consumers still on them should stay on the
  `0.1.x` line, which tracks `@google-cloud/bigquery` v8 (npm dist-tag `legacy-18`).

### Added
- Test covering construction of a real `@google-cloud/bigquery` client. Every other test
  injects a fake, so nothing previously exercised the actual dependency — the thing a major
  version bump is most likely to break.

### Security
- Resolved a high-severity `brace-expansion` DoS advisory set (GHSA-3jxr-9vmj-r5cp,
  GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895) by bumping the transitive lockfile pin to 1.1.18.
  The package was reachable only through the dev toolchain
  (`ultra_cart_rest_api_v2` → `@babel/cli` → `glob` → `minimatch`); published installs of this
  SDK were never affected.

### Changed
- Refreshed the `ultra_cart_rest_api_v2` lockfile pin to 4.1.125. The declared dev/peer range
  (`^4.1.103`) is unchanged, so no consumer upgrade is required.

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
