# Changelog

## Unreleased

- Added an external-data model test (`npm run benchmark:external`): five untreated wells from an independent laboratory (CC0) and 12 new conditions from the public BW25113 study, with 48 held-out curves. The 80% band covered 35/48 = 72.9% (95% CI 59.0-83.4%), consistent with the 73.1% simulation; the workflow refused a band in all five 4-curve folds as expected. Documented in [docs/external-model-test.md](./external-model-test.md).
- Added a deterministic prediction-band coverage study (`npm run benchmark:coverage`) with a documented report at [docs/prediction-band-coverage.md](./prediction-band-coverage.md). It is evidence tooling only: no analysis contract, version, or existing result changes.

## 6.1.0 — 2026-11-26

- Added a shared fit eligibility check: a fit needs at least one more exact, uncensored training observation than its free parameter count. OD least-squares fits also stop when the local prediction Jacobian is rank deficient. These cases return `NOT_IDENTIFIABLE` without estimates, predictions, residuals, or validation metrics.
- Added per-fit convergence, parameter-boundary, σ lower-bound, and profile-likelihood status. Profile refits that fail convergence are `NOT_ASSESSED`; kill `psiMin` uses the −5 log10/h lower limit and does not report a boundary substitute as a point estimate when its profile remains open.
- Added import readiness, fit status, parameter-by-parameter boundary reporting, and status-preserving JSON/CSV exports with application version, settings, and random seeds.
- Marked the transferred parameter set as teaching calibration only and research-fit ineligible.
- Added Node regression references for informative rows in Foerster et al. (2016) supplementary Tables S1/S2 and an algebraic equivalence check for Regoes evaluation. The table fixture does not refit the article's original CFU observations.
- Published the current application / analysis versions as `6.1.0` / `2.1.0`; the teaching scientific core and model remain `2.0.0` / `1.0.0`. `schemas/analysis-run.schema.json` accepts analysis `2.1.0` while keeping the `1.0.0` and `2.0.0` manifest contracts valid. The 6.0.0 generated example remains a historical file and is inspect-only under 6.1.0 replay.

## 6.0.0

See [6.0.0 release notes](./release-notes-6.0.0.md).
