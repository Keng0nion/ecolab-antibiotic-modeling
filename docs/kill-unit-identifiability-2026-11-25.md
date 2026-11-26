# Per-concentration-group growth-rate identifiability — 2026-11-25

Historical run note: the profile values below were computed with `[-12, 2]` log10-fold/h. The current Ecolab contract uses `[-5, 2]`, aligned to the `psiMin` fit bound. These recorded values are retained as the earlier run's results and are not current-bound estimates.

## Problem

Three concentration groups in the Foerster 2016 DG666 time-kill set cannot identify a growth rate from their own observations:

| Group | Concentration (mg/L) | Observations |
| --- | ---: | --- |
| `DG666\|Gen\|19_3_2015` | 2.5 | 5.204 at t=0, then 6/6 left-censored at 2 |
| `DG666\|Spec\|19_3_2015` | 50 | 5.602 at t=0, 2.000 at t=1, then 4/5 left-censored at 2 |
| `DG666\|CIP\|22_3_2015` | 0.15625 | 5.301 at t=0, 2.000 at t=1, then 5/6 left-censored at 2 |

All three reach the detection limit (`10^2` CFU/mL) within one hour and never leave it. Quoting a point estimate for their rate made the WT row of the derived parameter table inconsistent with the other rows.

## Why the rate is not identifiable

The kill model advances the log10 population by the net growth rate `psi(C)`:

```
N(t) = N0 + psi(C) * t                  (psi(C) <= 0, below carrying capacity)
psi(C) = psiMax * (1 - f) + psiMin * f  (Regoes four-parameter response)
```

When every post-baseline observation is left-censored at `L`, the likelihood term for each such observation is `log Phi((L - N0 - psi(C)*t) / sigma)`. As `psi(C)` decreases, every predicted value falls further below `L`, each censored term approaches `log(1) = 0`, and the likelihood flattens. Any sufficiently fast kill fits equally well: the data bound `psi(C)` from above and say nothing about how much faster it is. That is a structural property of the observation window, not an optimizer failure, and it is invisible in a point estimate.

A value recorded as exact but equal to the detection limit has the same problem: it cannot be distinguished from a censored observation. For `Spec 19_3 C=50` and `CIP 22_3 C=0.15625`, the `t=1` count was exactly `100 CFU/mL`, so the declared-censoring profile looks identified while the at-limit reading does not.

## What the diagnostic does

For the historical run summarized here, `unitGrowthRateIdentifiability()` profiled `psi(C)` over `[-12, 2]` log10-fold/h in 0.1 steps. That range describes these recorded results, not the current implementation. Current runs use `[-5, 2]`, matching the `psiMin` fitting bound. In either run, only `psi(C)` varies; the strain-level `N0` and residual `sigma` stay fixed, and the likelihood is the same censored Gaussian used by the fit. The verdict reuses `classifyKillProfile`, so group-level and strain-level profiles share one monotonicity rule and one likelihood-ratio cutoff.

Two readings are computed — declared censoring, and exact-at-limit treated as censored. `status` is the conservative combination. `basis` records the structure that produced it.

## Result on the DG666 set

203 concentration groups, using the v6 fitted parameters (`EcoLabDG666_v6_500次_profile全组.json`):

| Group | `status` | `basis` | One-sided 95% bound | Model `psi(C)` |
| --- | --- | --- | --- | ---: |
| `Gen 19_3 C=2.5` | lower-unidentified | all post-baseline at detection limit | `psi(C) ≤ -2.962` | -1.852 |
| `Spec 19_3 C=50` | lower-unidentified | all post-baseline at detection limit | `psi(C) ≤ -2.988` | -4.352 |
| `CIP 22_3 C=0.15625` | lower-unidentified | all post-baseline at detection limit | `psi(C) ≤ -3.150` | -4.120 |

Exactly three of 203 groups are flagged. The nearest controls stay identified, which confirms the criterion is the observation window rather than the concentration alone:

| Control group | `t=1` value | `status` |
| --- | ---: | --- |
| `Spec 22_3 C=100` | 2.301 | identified |
| `Gen 22_3 C=5` | 2.477 | identified |
| `Gen 19_3 C=1.25` | 2.477 | identified |

`modelWithinUnitSupport95` is false only for `Gen 19_3 C=2.5`: the strain fit predicts `psi(C) = -1.852`, but that group's own data require `psi(C) ≤ -2.962`. The model therefore under-predicts killing at the top gentamicin concentration — a group-level lack of fit that the aggregate RMSE hides, and the direct reason the WT row looked inconsistent.

## How to use the output

- Report `psi(C) ≤ bound`, never a point estimate, for a non-identified group. The bound is conditional on the strain-level `N0` and `sigma`.
- `modelNetGrowthRateLog10PerHour` remains available for drawing the fitted curve; it is a model-implied value, not that group's estimate.
- A group-level `identified` verdict does not prove `psiMax` is identified from that group. It states only that the group's own observations pin down the rate it was run at.
- The diagnostic is reported for every run; it adds no refitting and does not change the fitted parameters, the dataset fingerprint or the split fingerprint.

## Limits

- The profile is conditional, not a joint confidence region: `N0`, `sigma` and the other response parameters are held at the strain fit.
- The 0.1 grid resolution bounds the reported crossing; the interpolation between adjacent grid points is linear in `psi`.
- The union range used by `modelWithinUnitSupport95` is deliberately permissive. A `true` value does not establish fit; it only means neither censoring reading rejects the model value.
- Nothing here replaces the strain-level parameter profiles or the boundary diagnostics.
