# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-16

### Added
- Exported the dataset constants that were defined but unreachable from the package root:
  `DATASET_LINKED`, `DATASET_LINKED_LOW`, `DATASET_LINKED_MEDIUM`, `DATASET_LINKED_HIGH`,
  `DATASET_LINKED_STREAMING`, plus a new `DATASET_LOW` (`ultracart_dw_low`). Parent accounts
  can now name their CDC changelog dataset without a string literal.
- `examples/daily-sync.js`: a complete schedulable job. Orders change data capture, delete
  detection from the changelog's `IsDelete` rows, and a file-backed watermark that advances
  only after every write commits.
- `examples/analytics-sessions-cdc.js`: change data capture for storefront visits
  (`uc_analytics_sessions` joined to `uc_analytics_session_streaming` on
  `client_session_oid`), returning plain objects, with a `partition_date` bound on both sides
  that cut a measured run from 0.71 GB to 0.03 GB scanned.
- README section "Incremental sync (change data capture)", and `docs/EXTRACTION.md`
  sections on detecting deletes and syncing analytics sessions.

### Changed
- Upgraded the paired `ultra_cart_rest_api_v2` dev dependency from `^4.1.103` to `^4.1.254`,
  so tests hydrate against the current SDK models. The peer range is unchanged (`^4.1.103`):
  older SDK versions still hydrate, they simply lack fields added since.
- Corrected the `DATASET_STREAMING` doc comment: the streaming dataset holds the per-entity
  changelogs, not only analytics and screen recordings.
- CDC example headers no longer claim `_medium` / `_high` variants of the linked streaming
  dataset. There is one streaming dataset per account regardless of tier.

### Security
- `npm audit fix` resolved 4 advisories (2 high, 2 moderate) in `brace-expansion`,
  `browserslist`, `baseline-browser-mapping`, and `qs`. All are reachable only through the
  `ultra_cart_rest_api_v2` dev dependency's tree (`@babel/cli`, `superagent`); this package's
  own runtime dependencies were not affected. `npm audit` now reports 0 vulnerabilities.

## [0.2.1] - 2026-10-13

### Changed
- Refreshed the `@google-cloud/bigquery` lockfile pin from 9.0.1 to 9.0.2 (upstream patch
  release). The declared range (`^9.0.1`) is unchanged, so no consumer upgrade is required.

## [0.2.0] - 2026-08-08

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

[Unreleased]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/UltraCart/rest_api_v2_sdk_javascript_bigquery/releases/tag/v0.1.0
