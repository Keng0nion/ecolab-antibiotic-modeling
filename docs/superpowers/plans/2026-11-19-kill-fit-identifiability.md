# Kill Fit Identifiability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve numerical fitting behavior without changing the Regoes response equation, and report when kill-curve parameters are weakly identified by the observations.

**Architecture:** Preserve the physical parameterization and likelihood while optimizing in scaled coordinates for positive parameters. Add profile-likelihood diagnostics for selected response parameters and explicit boundary/identifiability metadata. Compare candidates against the checked-in prior Ecolab result using the same dataset fingerprint, locked split, seed, and evaluation budget. Keep the candidate only if held-out predictive performance does not worsen and parameter stability improves; otherwise revert the fitting change and retain only defensible diagnostics.

**Tech Stack:** Existing Node.js ES modules, bounded optimizers, censored Gaussian likelihood, node:test.

## Global Constraints

- Do not add third-party dependencies.
- Preserve Ecolab app version `6.0.0` and existing staged CLI work.
- Do not interpret moving estimates away from limits as evidence of better estimation by itself.
- Compare exact locked validation units; do not tune against them.
- If prediction or parameter reliability is lower than baseline, immediately restore the prior fitting algorithm.

---

### Task 1: Establish baseline comparison and target tests

**Files:**
- Modify: `src/analysis/tests/kill-workflow.test.js`
- Read: `src/analysis/kill-workflow.js`, `src/analysis/optimizers.js`
- Compare: saved `EcoLabDG666500.json` and `EcoLabDG666-18重启诊断.json` outputs in the adjacent Foerster validation workspace.

- [x] Add synthetic tests for transformed coordinates, a bound-limited fit, and profile-likelihood output.
- [x] Confirm the new optimizer-coordinate test fails before implementing coordinate transforms.
- [x] Record baseline per-unit validation RMSE/MAE, parameter-level interval boundary frequencies, and bootstrap convergence under the same fingerprint and split.

### Task 2: Add numerical scaling and identifiability reports

**Files:**
- Modify: `src/analysis/kill-workflow.js`
- Modify: `src/analysis/tests/kill-workflow.test.js`
- Modify: `docs/` scientific method reference if result fields are public.

- [x] Add log / negative-log optimizer coordinates while preserving the Regoes equation, model-space bounds, likelihood, and reported parameter units.
- [x] Add optional profile-likelihood and bootstrap boundary diagnostics for `psiMinLog10PerHour`, `hillKappa`, and `zMicMgPerL`.
- [x] Mark boundary-limited results explicitly; do not call results with no boundary flags proven identifiable.
- [x] Verify focused tests, syntax check, version check, and release tests.

### Task 3: Compare and accept or revert

**Files:**
- Read/write: adjacent Foerster validation outputs only for the comparison report.

- [x] Refit DG666 with the prior and candidate algorithms under identical data, split, seed, restart budget, and 500 successful bootstrap refits per group.
- [x] Compare per-unit held-out RMSE/MAE and parameter-level interval boundary incidence. Keep both group-level and parameter-level summaries visible because they move in opposite directions.
- [x] Retain the transformed optimizer: mean validation error and parameter-level boundary incidence improve, even though groups with any interval touching a bound rise from 14/18 to 15/18.
- [x] Re-run `npm test`, `npm run check:syntax`, `npm run check:version`, and `npm run test:release`.

