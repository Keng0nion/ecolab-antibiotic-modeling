# Changelog

## 6.2.0 — 2026-11-26

Application `6.2.0`; analysis engine `2.2.0`; scientific core `2.0.0`; teaching model `1.0.0`. Release notes: [6.2.0](./release-notes-6.2.0.md) and [analysis 2.2.0](./release-notes-analysis-2.2.0.md).

### Import and provenance

- Research Workspace import now accepts Excel workbooks (`.xlsx`) in addition to normalized JSON and CSV. `src/app/research/xlsx-import.js` reads the ZIP container and the first worksheet with no third-party dependency, converts it to CSV text, and hands that text to the existing strict importer, which keeps ownership of headers, units, ranges and censoring. Only the first worksheet is read, formulas use cached values, Excel dates are not converted, and the conversion is recorded as an `XLSX_FIRST_WORKSHEET_ONLY` import warning plus `sourceFormat: "xlsx"`. Decompression uses `DecompressionStream("deflate-raw")` (Chrome/Edge 103+, Safari 16.4+, Firefox 113+, Node 21+) and fails with `XLSX_INFLATE_UNAVAILABLE` rather than guessing.
- `data/raw/figshare-bw25113-growth-v1/acquisition.json` is now tracked while the three XLSX payloads stay ignored. `npm run audit:data` requires that manifest, so an untracked copy made a fresh clone fail with a missing-file error; the audit message now names the restore and regeneration commands.

### Profile precision (analysis 2.2.0)

- Raised the analysis engine to `2.2.0`. Profile-likelihood endpoints are now solved with a deterministic bracket-and-bisection refinement instead of being read off a five-point grid. The five-point grid had reported `psiMax` as `±0.345%`; the refined IID interval is `[0.407965, 0.438915]`, `±3.66%`. Nine and eleven grid points still report only `±0.730%` and `±0.856%`, so grid density alone cannot substitute for root refinement. The default eight iterations agree with a twenty-iteration run to `1.0e-6` relative. Evidence: `npm run benchmark:precision`, `docs/parameter-precision.md`.
- Added a random-intercept AR(1) sensitivity interval (`profileErrorModel: "both"`): `phi=0.835`, `lambda=0.122`, ICC `0.109`, mean design effect `15.13`, effective sample size `23.3`. It is anchored at the IID estimate, keeps nuisance reoptimization under IID least squares, and is reported as a sensitivity analysis, not a joint AR(1) refit. It widens and asymmetrically shifts the intervals; it never narrows them.
- Added a `precision` research preset (standard optimizer budget, 11 profile points, root refinement, AR(1) sensitivity) and wired it through the Research Workspace select, Chinese/English copy, CLI usage, replay options, export metadata and tests. `small` and `standard` keep their previous behaviour; `small` remains the default.
- Added `src/analysis/residual-dependence.js` with pure AR(1)/random-intercept covariance summaries, profiled-sigma negative log-likelihood and a deterministic threshold-crossing bisection, plus unit tests.
- The release audit now resolves the recorded preset through `researchWorkflowConfiguration` and compares it with the recorded replay options in both directions. The previous one-directional check could not tell `precision` from `standard`, which share an optimizer budget, so a preset substitution passed. `scripts/tests/release.test.js` "rejects stale preset" covers this.
- Added an external-data model test (`npm run benchmark:external`): five untreated wells from an independent laboratory (CC0) and 12 new conditions from the public BW25113 study, with 48 held-out curves. The 80% band covered 35/48 = 72.9% (95% CI 59.0-83.4%), consistent with the 73.1% simulation; the workflow refused a band in all five 4-curve folds as expected. Documented in [docs/external-model-test.md](./external-model-test.md).
- Added a deterministic prediction-band coverage study (`npm run benchmark:coverage`) with a documented report at [docs/prediction-band-coverage.md](./prediction-band-coverage.md). It is evidence tooling only: no analysis contract, version, or existing result changes.

### Versioned examples and replay

- Regenerated the current `6.2.0` example with the `precision` preset and analysis `2.2.0`. The `5.0.0`, `6.0.0` and `6.1.0` examples are byte-frozen and were not touched; the `6.1.0` pair was restored to its released bytes before regeneration.
- Replay now requires application `6.2.0` and analysis `2.2.0` exactly. Packages produced by `6.1.0` / `2.1.0` are inspect-only under this build, consistent with the existing exact-replay rule; the CLI and browser refuse them with `UNSUPPORTED_SOFTWARE_VERSION` instead of silently recomputing.

## 6.1.0 — 2026-11-26

- Added a shared fit eligibility check: a fit needs at least one more exact, uncensored training observation than its free parameter count. OD least-squares fits also stop when the local prediction Jacobian is rank deficient. These cases return `NOT_IDENTIFIABLE` without estimates, predictions, residuals, or validation metrics.
- Added per-fit convergence, parameter-boundary, σ lower-bound, and profile-likelihood status. Profile refits that fail convergence are `NOT_ASSESSED`; kill `psiMin` uses the −5 log10/h lower limit and does not report a boundary substitute as a point estimate when its profile remains open.
- Added import readiness, fit status, parameter-by-parameter boundary reporting, and status-preserving JSON/CSV exports with application version, settings, and random seeds.
- Marked the transferred parameter set as teaching calibration only and research-fit ineligible.
- Added Node regression references for informative rows in Foerster et al. (2016) supplementary Tables S1/S2 and an algebraic equivalence check for Regoes evaluation. The table fixture does not refit the article's original CFU observations.
- Published the current application / analysis versions as `6.1.0` / `2.1.0`; the teaching scientific core and model remain `2.0.0` / `1.0.0`. `schemas/analysis-run.schema.json` accepts analysis `2.1.0` while keeping the `1.0.0` and `2.0.0` manifest contracts valid. The 6.0.0 generated example remains a historical file and is inspect-only under 6.1.0 replay.

## 6.0.0

See [6.0.0 release notes](./release-notes-6.0.0.md).
