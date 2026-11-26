# Kill workflow identifiability and bootstrap contract

## Goal
Complete the kill-curve fit output with profile-based identifiability, censored one-sided parameter reporting, bootstrap diagnostics that separate optimizer convergence from identifiable interior replicates, and comparable RMSE/MAE metrics.

## Acceptance
- Every strain can be profiled for psiMin, kappa, and zMIC; diagnostics distinguish identified, lower-unidentified, and upper-unidentified from profile shape over the allowed range.
- Lower-unidentified psiMin is represented as a one-sided reported bound, not as a finite estimate at the optimizer limit; a separate explicit prediction substitute preserves reproducibility.
- Bootstrap output reports optimizer-converged, converged-and-interior, boundary counts/fraction, with boundary fits excluded from reported valid intervals.
- Cross-group quality summaries use per-group RMSE/MAE; objective/NLL remains within-fit diagnostic only.
- Existing baseline artifacts remain available and the old/new model-quality comparison uses identical observations and locked split.

## Steps
1. Add tests for profile-shape classification, one-sided psiMin semantics, bootstrap counts/exclusion, all-strain profiling, and RMSE/MAE summaries.
2. Implement explicit identifiability and reported-estimate contract without changing the likelihood or loosening bounds to force interior estimates.
3. Extend workflow options for all-group profiling and deterministic oracle full-data refits with clearly labeled evaluation scope.
4. Recompute prior and revised runs from the same validation CSVs; compare per-strain RMSE/MAE, profile classifications, convergence, and boundary rates.
5. Keep the revised model only if predictive accuracy and stability are not lower; otherwise restore the previous fit behavior while retaining honest diagnostics.
