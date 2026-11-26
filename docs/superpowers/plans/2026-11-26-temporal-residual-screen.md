# Temporal Residual Screening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution in this session; no subagent dispatch.

**Goal:** Expose a descriptive per-trajectory time-versus-residual screen for kill-curve training and validation metrics.

**Architecture:** Add a dependency-free Spearman calculation to the existing predictive-diagnostics module, group exact residuals by independent unit, and exclude left-censored observations. Attach the diagnostic to kill-workflow metrics, validate its output schema, and show the validation screen in the existing kill-result table. No fit parameters, optimizer, or predictions change.

**Tech Stack:** JavaScript ES modules, `node:test`, JSON Schema, bilingual app strings, R 4.6.2 for external-data evidence.

## Global Constraints

- Keep the app version at `6.0.0`.
- Add no third-party dependencies.
- Preserve all existing workspace changes and staged files.
- Run `npm run check:syntax && npm run check:version && npm run test:release` after implementation.
- Treat within-trajectory time points as dependent; report descriptive correlations without p-values.

---

### Task 1: Add and expose a descriptive residual trend screen

**Files:**
- Modify: `src/analysis/predictive-diagnostics.js`
- Test: `src/analysis/tests/predictive-diagnostics.test.js`
- Modify: `src/analysis/kill-workflow.js`
- Test: `src/analysis/tests/kill-workflow.test.js`
- Modify: `schemas/kill-workflow-result.schema.json`
- Modify: `src/app/research/view.js`
- Modify: `src/app/i18n.js`
- Test: `src/app/tests/research-view.test.js`

**Interfaces:**
- Add `summarizeTemporalResidualTrends({ observations, predictions, minimumExactPointCount = 5, strongCorrelationThreshold = 0.7 })`.
- Return method, thresholds, trajectory counts, and sorted per-unit rows with exact/censored counts, `status`, `spearmanRho`, and `highMagnitudeTrend`.
- Add the result as `temporalResidualDiagnostics` under kill workflow metrics.
- Render validation high-magnitude trajectory count over evaluated trajectory count.

- [x] **Step 1: Write failing tests** for rank ties, censor exclusion, minimum point count, and constant vectors. The import test failed before the implementation was added; workflow, schema, and UI integration assertions were then added.
- [x] **Step 2: Run targeted tests** with `node --test src/analysis/tests/predictive-diagnostics.test.js src/analysis/tests/kill-workflow.test.js src/app/tests/research-view.test.js`; the first run failed because the new function was not exported.
- [x] **Step 3: Implement the descriptive screen** with average ranks for ties; set undefined correlation for too few points or constant time/residual vectors; do not calculate p-values.
- [x] **Step 4: Run targeted tests**; all 36 analysis and UI tests passed without changing fit or prediction calculations.
- [x] **Step 5: Run required project checks** with `npm run check:syntax && npm run check:version && npm run test:release`; also ran all tests (`558` passed, `0` failed, `1` optional source-data test skipped).
- [x] **Step 6: Review the diff** and retain only this feature's changes; preserve unrelated pre-existing edits.
