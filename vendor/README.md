# vendor/xlsx.full.min.js — SheetJS CE (self-hosted)

Replaces the previously CDN-loaded `xlsx@0.18.5` (jsDelivr) with a locally
vendored, checksum-verified SheetJS Community Edition build, to remove the
known Prototype Pollution / ReDoS issues fixed after 0.18.5 and to stop
depending on a third-party CDN for a security-relevant dependency.

- **Version**: 0.20.3
- **Source**: `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`
  (official SheetJS CDN — SheetJS moved distribution off the npm registry;
  this is the path documented in the SheetJS project's own README/docs as the
  canonical CE download location)
- **License**: Apache License 2.0 — see `LICENSE.xlsx` in this directory
  (fetched from `https://cdn.sheetjs.com/xlsx-0.20.3/package/LICENSE`)
- **SHA-256** of `xlsx.full.min.js`:
  `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`
- **Retrieved**: 2026-08-25, verified byte-identical to the `xlsx-latest`
  alias at time of retrieval (i.e. 0.20.3 was current-latest when vendored).

## Updating this file

1. Fetch `https://cdn.sheetjs.com/xlsx-<version>/package/dist/xlsx.full.min.js`
   from the official SheetJS CDN (never an npm mirror or unofficial CDN).
2. Verify the file downloads over HTTPS from `cdn.sheetjs.com` and record its
   SHA-256 here.
3. Replace `xlsx.full.min.js` and update the version/checksum notes above.
4. Re-run the Excel import/export/template isolation tests before deploying.
