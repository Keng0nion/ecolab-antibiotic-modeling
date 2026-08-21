# Stage 5 release checklist / 发布检查表

## Release identity / 发布标识

- [x] Application version is `5.0.0` in root `package.json`.
- [x] `src/app/version.js` matches the root version.
- [x] `build-core.js` reads the root package version.
- [x] Scientific core remains `2.0.0`; analysis engine remains `1.0.0`.

## Build and integrity / 构建与完整性

- [x] Default outputs remain `dist/core/` and `dist/web/`.
- [x] Both build scripts accept `--out-dir`.
- [x] Web build tests use temporary directories and validate relative URLs and module imports there.
- [x] Two clean temporary builds have identical per-file SHA-256 content hashes.
- [x] Release audit rejects `raw`, `.xlsx`, and test paths.
- [x] Release audit generates a sorted `dist/release-manifest.sha256`.
- [x] `_headers` is copied into the Web release.
- [x] CSP permits same-origin module Workers and `blob:` downloads without `unsafe-inline`.

## Documentation and portfolio / 文档与作品集

- [x] Bilingual overview, architecture, limitations, portfolio, maintenance, deployment, and checklist pages exist.
- [x] README is a concise navigation entry.
- [x] Versioned small-preset artifact is generated from the bundled dataset.
- [x] Artifact reports L3, failed L4 eligibility, fitted parameters, metrics, warnings, and reproduction command.
- [x] Worse-than-predeclared-baseline validation remains explicit.
- [x] Normalized JSON artifact SHA-256, canonical dataset fingerprint, and original workbook hashes are named as distinct provenance objects.
- [x] Stage 4 is recorded as approved; Stage 5 implementation/audit status is recorded in blueprints.
- [x] Blueprint terminology uses `zMIC` rather than ambiguous `MIC`/`×MIC` for the modeled quantity.

## Static size budget / 静态大小预算

Conservative release thresholds enforced by `scripts/audit-release.js`:

| Product | Total budget | Maximum single file | Measured 2026-08-21 |
| --- | ---: | ---: | ---: |
| `dist/web` | 10 MiB | 5 MiB | 7.38 MiB total; 4.10 MiB largest |
| `dist/core` | 10 MiB | 5 MiB | 7.02 MiB total; 4.10 MiB largest |

Measurement environment:

```text
macOS 26.5.2 (25F84)
Apple M2, 8 GiB RAM
Node.js v26.4.0
```

These are uncompressed static-file measurements. No browser interaction P95, startup P95, or network transfer P95 was measured; none is claimed as passed.

## Validation record / 验证记录

Passed in the recorded environment:

- [x] `npm run check:version`
- [x] `npm run audit:data`
- [x] `npm run test:release`, including computed WCAG AA dark-theme contrast checks for release-critical semantic colors
- [x] `npm run check:reproducible`
- [x] `npm run example:research`
- [x] `npm run build:clean && npm run build:core && npm run build:web`
- [x] `npm run audit:release`

Full project validation:

- [x] `npm run build` passed, including `npm run check`, data audit, 238 automated tests, clean core build, and clean Web build.

Manual checks not completed in this environment:

- [ ] Chrome manual workflow and accessibility pass.
- [ ] Firefox manual workflow and accessibility pass.
- [ ] Safari manual workflow; Safari WebDriver requires Allow remote automation.
- [ ] Browser interaction performance/P95 measurements.

## Release decision / 发布决定

Automated Stage 5 release/build audits and the full project build pass for the generated products. Final public release remains **in progress** until the owner completes or explicitly accepts the outstanding manual browser and browser-performance checks.
