# Predictive Diagnostics Implementation Plan

> **For agentic workers:** Execute inline with the red-green-refactor checkpoints below. Do not dispatch subagents; preserve the user’s existing staged and unstaged changes.

**Goal:** Add honest new-observation predictive uncertainty for real CFU and OD data while preserving the current fitted point models.

**Architecture:** Add a pure statistical helper for Gaussian-mixture prediction summaries. The CFU workflow will feed it whole-unit bootstrap parameter fits and retain censoring-aware scores; the OD workflow will calibrate simultaneous new-trajectory bands from nested, training-only whole-trajectory cross-fitting. Both outputs will state their calibration basis and sample resolution.

**Tech Stack:** Node.js >=20.19, native ES modules, `node:test`, existing Ecolab random/statistical utilities; no new runtime dependencies.

## Global Constraints

- Do not add third-party runtime dependencies.
- Keep application version `6.0.0` and scientific engine version unchanged.
- Add each new source file to `package.json`'s `check:syntax` command.
- Preserve units, censoring semantics, dataset fingerprints, locked splits, and exact replay behavior.
- Never treat the four previously viewed OD development curves as untouched validation or interval-calibration data.
- Preserve all staged, unstaged, and untracked user changes that predate this task.
- A material regression on either real-data track triggers rollback of only the new implementation slice.

---

## File map

- Create `src/analysis/predictive-diagnostics.js`: pure Gaussian-mixture prediction intervals and exact/censored scoring.
- Create `src/analysis/tests/predictive-diagnostics.test.js`: deterministic statistical contract tests.
- Modify `src/analysis/kill-workflow.js`: build CFU predictive summaries from converged whole-unit bootstrap fits; retain point estimates.
- Modify `schemas/kill-workflow-result.schema.json`: validate the optional new predictive diagnostics object.
- Modify `src/analysis/growth-comparison.js`: nested training-only whole-trajectory calibration and new-trajectory conformal bands.
- Modify `src/analysis/tests/kill-workflow.test.js` and `src/analysis/tests/growth-comparison.test.js`: workflow-level contracts and leakage guards.
- Modify `src/app/research/view.js`, `src/app/i18n.js`, and focused view tests: show interval level, calibration count, coverage/status, and limits.
- Modify `README.md` and `docs/limitations.md`: explain the new intervals and their evidence limits.
- Modify `package.json`: register the new helper in syntax checks.

## Task 1: Capture the current benchmark and protect the working tree

**Files:** no repository source changes. Save task-start copies of every file listed in the file map under a task-specific directory in `/tmp`; record `git status --short` before and after.

- [ ] Run `npm run check:syntax`.
- [ ] Run `npm run check:version`.
- [ ] Run `npm run test:release` and `npm test` on the unchanged task-start tree.
- [ ] Record the fixed-seed CFU metrics from the existing DG666 benchmark and the OD training-CV metrics from the bundled BW25113 data. Record exact source fingerprints, independent-unit split, and optimizer/bootstrap budgets.
- [ ] Confirm the four viewed OD curves are labelled development and are excluded from every new calibration computation.

Expected result: a baseline record with no worktree changes. Any pre-existing failure is recorded before edits and is not attributed to this implementation.

## Task 2: Implement the predictive-distribution math helper (TDD)

**Files:** create `src/analysis/predictive-diagnostics.js`; create `src/analysis/tests/predictive-diagnostics.test.js`.

**Interface:**

```js
summarizeGaussianMixturePredictions({ observations, samples, intervalLevel })
```

`observations` is an ordered array of workflow observations. `samples` is an ordered array of `{ means: number[], sigmas: number[] }`, one mean and positive standard deviation per observation for each bootstrap fit. The helper returns `{ status, intervalLevel, sampleCount, predictions, summary }`; every prediction retains `observationId`, exact/censored status, predictive median/limits, exact log predictive density or left-censor event probability/log score, and whether an exact observation is inside its interval. Invalid, misaligned, empty, or non-finite inputs return the established structured `AnalysisError` shape.

- [ ] Write tests first for: a single Gaussian giving known median/interval; a two-component mixture using the average component CDF; exact interval coverage and log score; a left-censored observation scored as `P(Y <= LOD)` without using its recorded bound as an exact value; empty bootstrap draws returning unavailable; invalid sigma and vector-length mismatch errors.
- [ ] Run `node --test src/analysis/tests/predictive-diagnostics.test.js`; verify each new behavior fails for the expected missing export/behavior.
- [ ] Implement the mixture CDF as the arithmetic mean of `normalCdf((x - mean) / sigma)`, invert quantiles with deterministic bisection, and compute exact mixture log density with log-sum-exp. Clamp only probabilities used for finite log scores, and report the unclamped event probability.
- [ ] Re-run the focused test until green; check deterministic output and tails against closed-form one-component cases.

## Task 3: Add censoring-aware CFU prediction diagnostics (TDD)

**Files:** modify `src/analysis/kill-workflow.js`, `schemas/kill-workflow-result.schema.json`, and `src/analysis/tests/kill-workflow.test.js`.

- [ ] Add a failing workflow test asserting `predictiveDiagnostics` reports exact predictive intervals, exact log scores, censored event probabilities, bootstrap sample count, and held-out independent-unit IDs.
- [ ] Run the focused test and verify it fails because the new output is absent.
- [ ] During `bootstrapIntervals`, retain converged parameter vectors (including boundary fits) for predictive propagation separately from interior-only parameter confidence intervals. Do not change the existing interval estimator or its boundary rules.
- [ ] For each held-out observation, evaluate the CFU model under each converged bootstrap vector, pair that mean with that vector's `errorSigmaLog10`, and call `summarizeGaussianMixturePredictions`. If bootstrap is disabled or no bootstrap fit converges, return an explicit unavailable reason; do not silently substitute a fitted-mean interval.
- [ ] Keep exact-observation point estimates and existing `validationMetrics` byte-for-byte stable. Add censor-aware predictive NLL and event-probability summaries without changing the current `censoredPredictionHitRate` definition.
- [ ] Extend the result schema with strict validation for the new object and its statuses. Re-run kill workflow and schema tests.

## Task 4: Add nested whole-trajectory OD predictive bands (TDD)

**Files:** modify `src/analysis/growth-comparison.js` and `src/analysis/tests/growth-comparison.test.js`.

- [ ] Write failing tests for: calibration scores produced only from training trajectories; selection rerun inside each outer fold; one max-absolute-residual score per held-out trajectory; finite-sample conformal quantile; 95% interval unavailable when the calibration count cannot resolve that tail; previously viewed development IDs never appear among calibration IDs.
- [ ] Run the focused test and verify the expected missing diagnostic/status causes failure.
- [ ] For each configured outer training-CV fold, select among `training_mean`, `logistic`, and `gompertz` using inner whole-trajectory folds made only from the outer training IDs; fit the inner-selected model to those IDs; predict the untouched outer trajectories.
- [ ] Calculate one calibration score per outer held-out trajectory: maximum absolute OD residual across its evaluated time points. For level `1-alpha`, use rank `ceil((n + 1) * (1-alpha))`; return `insufficient_finite_sample_resolution` when rank exceeds `n`, never a finite optimistic band.
- [ ] Center the simultaneous band on the final training-selected fit and use the finite-sample residual quantile as a common radius. Report its assumption of exchangeable independent trajectories, calibration IDs/count, rank, interval level, and explicit warning that actual coverage still needs independent data.
- [ ] Add the added nested-fit budget to configuration validation and progress reporting so requested runs cannot exceed the documented evaluation cap. Re-run the focused OD tests and deterministic replay tests.

## Task 5: Present diagnostics without overstating evidence (TDD)

**Files:** modify `src/app/research/view.js`, `src/app/i18n.js`, `src/app/tests/research-view.test.js`, `README.md`, and `docs/limitations.md`.

- [ ] Add view tests first for both modalities: show predictive interval/status, number of independent calibration units, exact/censored scoring distinction, and unavailable/low-resolution wording; do not label OD mean intervals as prediction intervals.
- [ ] Run the view tests and confirm they fail on missing copy/rendering.
- [ ] Render the CFU and OD diagnostics from the new result objects in Chinese and English. Escape all source-derived strings and show warnings when intervals are unavailable or calibration units are few.
- [ ] Document that the OD bands use training-only nested cross-fitting, the CFU mixture uses the existing censored-Gaussian observation model, and neither demonstrates cross-strain/drug transfer by itself.
- [ ] Re-run view, export, and replay tests to ensure the new result remains serializable and old package replay semantics stay intact.

## Task 6: Full verification and rollback decision

- [ ] Run `npm run check:syntax`, `npm run check:version`, `npm run test:release`, and `npm test`.
- [ ] Re-run the fixed-input real-data benchmarks with task-start seeds, splits, data fingerprints, and budgets; compare each dataset and subgroup separately.
- [ ] Confirm existing CFU/OD point estimates and legacy scores are unchanged; new CFU intervals are not used as exact values for censored observations; new OD calibration IDs contain training units only.
- [ ] Review observed interval widths and calibration counts. Treat the old OD mean-curve bands as a different estimand, not a width baseline.
- [ ] If any old scientific invariant, deterministic fit output, or primary held-out score regresses beyond task-start repeatability, restore only the affected implementation files from their task-start copies, preserve user changes, and re-run the baseline checks.
- [ ] If all gates pass, retain the implementation and report exact benchmark results, limitations, and rollback status.

## Self-review

- The plan covers the spec's separate CFU/OD models, training-only calibration, three evidence levels, low-sample warnings, no cross-domain claim without held-out data, and rollback requirement.
- New OD calibration is nested to avoid model-selection leakage; viewed development data remain excluded.
- Existing point estimates and OD fitted-mean bands have distinct contracts and will remain unchanged.
- No third-party runtime dependency or biological-model expansion is introduced.
