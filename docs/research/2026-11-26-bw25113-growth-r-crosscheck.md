# BW25113 direct-OD model cross-check in R

**Date:** 2026-11-26
**Purpose:** Independently check Ecolab's direct-OD curve selection and held-out scoring with R.

## Source and scope

The local Figshare bundle records data from Aida and Ying's 2025 *Scientific Data* article, which describes 13,608 *E. coli* BW25113 growth curves across 1,029 chemically defined media ([article](https://doi.org/10.1038/s41597-025-05356-3); [Figshare dataset v1](https://doi.org/10.6084/m9.figshare.28342064.v1)). The source dataset is CC BY 4.0; the bundle retains its author and dataset attribution. This benchmark uses only the admitted `Cond00003` subset: 12 untreated, raw, unblanked OD600 well trajectories, sampled every 0.5 h from 0.5 to 22 h. Eight trajectories are used for training and four for the held-out comparison.

OD600 remains OD600 here. This is not CFU data, does not test antibiotic response, and provides no OD-to-CFU conversion. The workflow also labels these previously viewed curves as a development comparison, so they are not claimed as untouched validation evidence. Source details and known limitations are recorded in [the bundled dataset README](../../data/datasets/figshare-bw25113-growth-v1/README.md).

The normalized CSV SHA-256 is `03e137484b717970cd4cc47be88c52224e08cbb0713b7d6b4456b91c63985188`. The R script verifies this fingerprint, the exact 528 rows, and the 8/4 trajectory split before fitting.

## Independent R method

Run from the repository root:

```sh
Rscript scripts/benchmarks/validate-bw25113-growth-r.R
```

The script uses base R only. It independently reproduces leave-one-trajectory-out CV for the exact-time training mean, logistic, and Gompertz candidates. The two sigmoid candidates use bounded L-BFGS-B with a fixed 36-start grid and the same parameter bounds/objective as Ecolab. It then refits the R-selected candidate to all eight training trajectories and computes the four held-out trajectory RMSEs.

The matched Ecolab JavaScript run used seed `3817`; bounds `baselineOd [0, 0.3]`, `amplitudeOd [0.001, 1]`, `ratePerHour [0.001, 4]`, and `timingHours [0, 30]`; one restart; population 64; differential-evolution/Nelder-Mead budgets 1,200/1,200; and bootstrap disabled. R and JavaScript therefore share the data, split, equations, objective, and bounds, but use independent optimizers.

## Results

| Candidate | Ecolab JavaScript LOO macro RMSE | Independent R LOO macro RMSE |
| --- | ---: | ---: |
| Training mean | 0.003848267075 | 0.003848267075 |
| Logistic | 0.008315412120 | 0.008315411113 |
| Gompertz | 0.010714264513 | 0.010714264017 |

Both implementations select `training_mean`. The CV score differences are below `1.1 × 10⁻9` OD600. R's independent refit reproduces Ecolab's held-out trajectory RMSEs within `1 × 10⁻12`:

| Held-out trajectory | RMSE (OD600) |
| --- | ---: |
| Curve00033 | 0.001585512356 |
| Curve00034 | 0.002986177912 |
| Curve00035 | 0.003731345647 |
| Curve00036 | 0.003887214985 |
| Macro average | 0.003047562725 |
| Pooled | 0.003180585191 |

The JavaScript run recorded optimizer-stage budget warnings on some non-selected sigmoid refits. The close R scores support agreement on this benchmark but do not establish global convergence. The selected training-mean predictor itself has no nonlinear optimizer.

## Interpretation

This is a reproducible cross-language check of one real, authoritative OD dataset and its predeclared trajectory split. It found no material discrepancy between the Ecolab model-selection/held-out scoring and an independent R implementation. It does not validate the CFU kill model, other strains or media, antibiotic effects, or predictive coverage across experiments. More independent conditions and trajectories are needed to assess transfer and finite-sample prediction intervals.
