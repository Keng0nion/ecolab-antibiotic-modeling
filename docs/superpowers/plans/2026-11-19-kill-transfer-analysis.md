# Kill-curve transfer analysis closure

## Goal
Make the migration comparison paired and estimator-consistent; report donor psiMin sensitivity, two reference estimators, oracle predictions, portable provenance, and a versioned v5 data-processing record.

## Acceptance
- Direct transfer and MIC-ratio transfer are evaluated on the same eligible 12 directed strain pairs; WHO K/L are excluded from MIC ratios because MIC is right-censored (>32), never imputed as 32.
- Paired transfer-error ratio has a deterministic bootstrap 95% interval.
- For all three donor psiMin scenarios (profile upper, point, profile lower), all migration errors are recomputed. If a side is unbounded, report it as unavailable/one-sided rather than substituting a search limit.
- Each migration method is reported against both concentration-wise censored slope references and one-step censored-fit references; RMSE/MAE are per strain/pair.
- Oracle rows refit each recipient with all its observations and predict its own curve, explicitly labeled as an in-sample model-form reference.
- Source paths are relative/configurable; regenerated artifacts include input fingerprints and provenance.
- A versioned change record states v5 conversion, per-curve geometric-mean inoculum, right-censoring not truncation, −4 h row exclusion, and concentration-grid alignment.

## Steps
1. Add regression tests/helpers for same-pair eligibility, ratio bootstrap determinism, metric definitions, and censoring behavior.
2. Update transfer recomputation with paired 12-pair cohort, three psiMin scenarios, two references, and oracle rows.
3. Refit or reuse deterministic v5 runs for all 6 main groups and all 18 DG666 groups with profile and bootstrap diagnostics; write versioned outputs beside the validation data.
4. Compare revised outputs with existing 500-bootstrap baseline and prior migration JSON; preserve old files and emit a concise machine-readable comparison.
5. Verify all local source paths, fingerprints, output schemas, and release checks.
