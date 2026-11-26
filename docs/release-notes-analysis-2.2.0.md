# Analysis engine 2.2.0 release notes

Date: 2026-11-26. Application `6.2.0` (unchanged); analysis engine `2.2.0`; scientific core `2.0.0`; teaching model `1.0.0`.

This is an analysis-only version bump. It changes how profile-likelihood endpoints are computed and adds a dependence-aware sensitivity interval. It does not change the point estimates, the optimizer, the model, the data, or the teaching core.

## What changed

1. **Profile endpoints are solved, not read off the grid.** A five-point grid was producing `psiMax` at `±0.345%` by linearly interpolating a quadratic profile across a wide bracket. The workflow now brackets the `1.920729410347062` crossing on the grid and refines it with a deterministic bisection (relative width `1e-6`, at most 8 iterations). The refined IID interval is `[0.407965, 0.438915]`, `±3.66%`. Raising the iteration cap to 20 moves the endpoints by `1.0e-6` relative, so the default cap is converged rather than merely cheap.
2. **`profileRootRefinement`, `profileRootRefinementMaxIterations`, `profileRootRefinementRelativeTolerance`, and `profileErrorModel` are recorded workflow options.** They are validated, written into `runMetadata.settings.workflowConfiguration`, into the computation settings, and into the replay input. `research-replay.js` treats them as optional so pre-2.2.0 inputs remain inspectable.
3. **A random-intercept AR(1) sensitivity interval is reported when `profileErrorModel` is `"both"`.** `phi` is the pooled within-curve lag-one residual autocorrelation, `lambda` is the between/within variance ratio from a balanced method-of-moments decomposition, and `sigma^2` is profiled analytically. Nuisance parameters are reoptimized under IID least squares and the likelihood ratio is anchored at the IID estimate. The block is labelled `sensitivity_analysis` and `primaryInterval` stays `iid_profile`.
4. **A `precision` research preset.** Standard optimizer budget, 11 profile points, root refinement, AR(1) sensitivity. `small` and `standard` keep their previous behaviour, and `small` remains the default.
5. **The current `6.2.0` example is regenerated with the `precision` preset.** The `5.0.0` and `6.0.0` example files are byte-frozen and unchanged.

## What deliberately did not change

- No interval was narrowed. Every change either widens an interval or adds a wider sensitivity interval.
- `K`, absolute CFU scale, `scaleOd` absolute scale, `psiMin`, `kappa`, and `zMIC` remain unidentified or unestimable for the same structural reasons. No budget increase or interval formula can fix that.
- The AR(1) block is not a joint AR(1) refit and must not be read as a symmetric standard error.

## Replay and schema

- `schemas/analysis-run.schema.json` accepts analysis `2.2.0` alongside `1.0.0`, `2.0.0`, and `2.1.0`.
- Replay requires the exact built-in analysis version. Packages produced by `2.1.0` are inspect-only under this build and are refused with `UNSUPPORTED_SOFTWARE_VERSION`; their recorded bytes are not rewritten.
- The release audit now compares the recorded replay options against the *resolved* preset configuration in both directions, so a preset substitution (for example claiming `standard` for a `precision` run, which share an optimizer budget) is rejected.

## Evidence

- `npm run benchmark:precision` — budgets, five grid/refinement configurations, IID and AR(1) intervals, condition number, correlation, residual autocorrelation, ICC, design effect, effective sample size. Output is byte-identical across runs.
- `npm run benchmark:external` and `npm run benchmark:coverage` — unchanged numbers; these paths do not use the profile or dependence code.
- `docs/parameter-precision.md` records the four precision layers separately and the per-parameter reasons why some cannot improve.

## Boundaries

Profile intervals remain conditional on the model, the Gaussian error assumption, the parameter bounds, and the fitted dataset. Root refinement removes a numerical artefact; it does not create information. The dependence block is a sensitivity analysis, not a hierarchical model. None of this is a coverage proof for future experiments.
