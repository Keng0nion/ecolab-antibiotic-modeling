# Kill curve fit diagnostics — 2026-11-19

## Decision

Keep the transformed optimization coordinates for the one-step kill-curve fit. They change only the optimizer's coordinates; reported parameters and bounds remain in their original biological units. For each positive parameter (`psiMax`, `zMIC`, `kappa`, and residual sigma), the optimizer works on its logarithm. For negative `psiMin`, it works on `log(-psiMin)`. Initial population remains on its original scale.

This decision is based on matched DG666 refits and the parameter-level bootstrap-boundary count. The transformed candidate improved the held-out averages and reduced the number of parameter intervals touching a fit boundary. One coarser summary moved in the opposite direction: groups with at least one such interval increased from 14/18 to 15/18. Both summaries are retained below.

## Matched comparison

The previous Ecolab output was `EcoLabDG666500.json`; the candidate was rerun with the same 6 main-fit restarts, 500 successful whole-unit bootstrap refits per strain, seed `20261118`, dataset fingerprint `d6e10bd178599eb09829e73844253dca29c4cd674ed9a623e0a64ba00ead3b29`, and locked split fingerprint `14cf2355fce46e40b8a6ef81731fd7b40c20b132dfbe426082f9d4fc01bac1c8`.

| Metric | Previous fit | Transformed coordinates | Change |
| --- | ---: | ---: | ---: |
| Mean locked-validation RMSE (18 groups) | 0.38815 | 0.37782 | −2.66% |
| Mean locked-validation MAE | 0.28292 | 0.27227 | −3.76% |
| Groups with lower validation RMSE | — | 11/18 | 7/18 higher |
| Main-fit groups with a parameter at a fit boundary | 5/18 | 1/18 | improved |
| Individual parameter 95% intervals touching a fit boundary | 30/108 | 16/108 | improved |
| Groups with at least one interval touching a fit boundary | 14/18 | 15/18 | slightly worse |
| Successful bootstrap fits | 9,000/9,000 | 9,000/9,000 | same |

The group-level count is a coarse flag and can rise when boundary-limited parameters are concentrated in more groups. The parameter-level count more directly measures the number of reported intervals clipped by the bounds. The change is not uniform across strains: 11 validation RMSEs improved and 7 worsened, so per-group results must remain visible.

## Boundary cases and profiles

Profile likelihood was run for the previously flagged CX 19-3, Tet 19-3, and Spec 22-3 groups. The profile uses training observations only, holds one parameter fixed at a time, refits nuisance parameters, and reports the discrete grid values within `ΔNLL ≤ 1.921` (the 95% one-parameter likelihood-ratio cutoff). It is a diagnostic grid, not a replacement for a full confidence interval.

- **`DG666|CX|19_3_2015`:** the transformed main fit moved from `psiMin = −12`, `kappa = 0.05`, `psiMax = 2` to interior values (`psiMin = −0.227`, `kappa = 1.991`, `psiMax = 0.311`). Validation RMSE fell from 0.5745 to 0.4526. The converged `psiMin` and `kappa` profiles excluded both endpoints on the evaluated grid. One `zMIC` profile point did not converge, so its endpoint exclusion is not treated as reliable evidence.
- **`DG666|Tet|19_3_2015`:** the transformed fit moved `psiMin` from the lower bound to `−0.0904` and `kappa` from 0.05 to 1.045; validation RMSE fell from 0.2470 to 0.2052. The `psiMin` profile excluded both endpoints. One `kappa` grid point did not converge, so the `kappa` profile remains qualified.
- **Spec, 22-3:** `psiMin` remains at `−12`; 93.2% of successful bootstrap refits landed at that lower bound. Its profile supports the lower bound and sharply excludes less-negative values on the grid. This remains a censored/bound-limited estimate and must not be presented as a precise interior value.

The transformed fit improves the flagged CX record but does not resolve every drug/replicate. Boundary diagnostics are therefore part of each strain's result. `boundaryLimited: true` means the point estimate, bootstrap interval, or bootstrap boundary mass touches the declared fit limits; `no_boundary_evidence` does not prove global identifiability. Profile points retain convergence status; non-converged points must not be used as evidence that a bound is excluded.

## Test availability

The CLI test already expects 13 task kinds and passes; no change was needed at its former line 107. The real-data Figshare test now skips with a stated reason only when all three optional source XLSX files are absent. If only part of the source set is present, it fails with the missing filenames instead of silently skipping.

## Reproduction and limits

The current code exposes `profileLikelihood: true`, `profilePoints`, and `profileLikelihoodStrains` on `runKillWorkflow`. Profile refits use the locked training data only. The 95% intervals are conditional on the stated model, bounds, successful bootstrap refits, and declared unit resampling; they do not establish biological validation or uncertainty beyond these repeats.

