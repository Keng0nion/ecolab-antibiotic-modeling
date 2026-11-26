# Ecolab 6.1.0 release notes

Date: 2026-11-26. Application `6.1.0`; analysis engine `2.1.0`; scientific core `2.0.0`; teaching model `1.0.0`.

## Fit statuses and diagnostics

- All fitting entry points check that the training set contains at least `p + 1` exact, uncensored observations for `p` free parameters. The OD least-squares path also checks local prediction-Jacobian rank. Ineligible runs return status-only results without parameter values, predictions, residuals, or validation metrics.
- The research UI and exported results show fit status, optimizer convergence, every parameter estimate at a bound, whether σ reached its lower bound, and profile-likelihood status. Profiles that are skipped or cannot be assessed after a failed refit are labelled `NOT_ASSESSED`.
- The OD profile fixes the target parameter and reoptimizes the remaining biological and OD observation-layer nuisance parameters. It profiles Gaussian residual scale analytically. Kill-model profiles retain the censored Gaussian likelihood. Both are conditional on their model and error assumptions.
- The kill model uses the common `psiMin` lower bound of −5 log10/h. Boundary hits appear as a parameter list; an open profile does not get presented as a point estimate.

## Interface, export, and registry

- Data import shows exact-observation readiness thresholds. Fit and export states retain results that contain only a diagnostic status.
- Result JSON and linked dataset CSV include application version, random seed, RNG algorithm, fit status, and requested settings.
- The transferred CAB1/LB parameter set is marked `teaching_calibration_only` and cannot be represented as condition-matched research parameters without appropriate validation.

## Regression evidence and limits

- Node tests cover censored likelihood behavior, Regoes algebraic equivalence, exact-point and local-rank rules, boundary handling, status-only results, and informative estimates in Foerster et al. (2016) supplementary Tables S1/S2.
- The published-table fixture records why rounded-zero SE rows, a weakly resolved extreme row, and a duplicate DG666 entry are excluded. It checks the copied table values and equation behavior; it does not refit the original data or validate Ecolab on that study's conditions.
- The current BW25113 source remains untreated OD600. It does not validate antibiotic-effect parameters or identify absolute CFU. Previously viewed trajectories remain development data.

## Versioned examples

The generated `6.1.0` example is the current release artifact. [6.0.0 example files](../data/examples/ecolab-stage6-research-6.0.0.json) remain historical and are not rewritten by the current generator. Because replay requires the exact built-in software, the 6.0.0 package is inspect-only under 6.1.0: the CLI and browser refuse replay with `UNSUPPORTED_SOFTWARE_VERSION` instead of silently recomputing it with 2.1.0 code. Its recorded bytes and scientific result hash stay as generated in 6.0.0.
