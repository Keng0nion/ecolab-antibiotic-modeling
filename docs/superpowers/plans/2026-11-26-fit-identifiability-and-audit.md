# Fit Identifiability and Audit Implementation Plan

> **For agentic workers:** Execute inline in this session. Work test first in each task and preserve existing staged and unstaged changes.

**Goal:** Make every fitting path explicit about identifiability and convergence, withhold estimates when uncensored evidence is insufficient, and expose auditable settings and statuses through the Research interface and exports.

**Architecture:** Put the minimum uncensored evidence rule and common fit diagnostics at the shared `fitParameters` boundary. Keep the existing kill workflow profile-likelihood analysis and OD research Jacobian analysis as model-specific diagnostics, and return explicit `NOT_ASSESSED` records when a likelihood profile was not run or failed. Feed these results into the existing Research import, analysis, and export surfaces; preserve research packages and historical 6.0.0 fixtures as immutable records.

**Tech Stack:** Node.js 20.19+, ES modules, `node:test`, existing browser Research UI, optional R cross-check scripts and authoritative Foerster 2016 source tables.

## Global Constraints

- Add no runtime dependencies; use the repository's existing Node and browser architecture.
- Never use validation observations for fitting; insufficient uncensored evidence returns a status and no parameter numbers.
- Report convergence, parameter boundaries, sigma lower-bound hits, and profile assessment independently.
- Record the application's software version, exact settings, and random seeds in completed-run exports.
- Treat transferred parameter sets as teaching calibration only unless condition-matched validation has actually been completed.
- Keep existing user changes and historical 6.0.0 artifacts intact; update the current release contract to 6.1.0.

## File Map

- `src/analysis/fitting.js`: shared exact-observation gate, fit status, local identifiability, and convergence diagnostics.
- `src/analysis/research-workflow.js`: stop the OD least-squares path before reporting parameters when the shared fit is ineligible; export model-specific Jacobian assessment.
- `src/analysis/kill-workflow.js` and `schemas/kill-workflow-result.schema.json`: explicit fit status, all-boundary diagnostics, sigma lower-bound flag, and profile `NOT_ASSESSED` outcomes.
- `src/analysis/tests/fitting-recovery.test.js`, `src/analysis/tests/kill-workflow.test.js`, and new tests under `src/analysis/tests/`: censored likelihood, Regoes equivalence, identifiability, boundary, convergence, and published-table regression cases.
- `src/app/research/controller.js`, `src/app/research/view.js`, `src/app/research/export.js`, `src/app/research/state.js`: import/readiness status, fit status, kill-result export, full run metadata, and persisted default-settings behavior.
- `data/registry/parameter-sets.json`, registry validators/tests: declared educational use and research-ineligible scope for transferred calibrations.
- `docs/limitations.md`, `docs/release-checklist.md`, `docs/changelog.md`, `README.md`, `AGENTS.md`, `package.json`, `src/app/version.js`, `scripts/check-version.js`: methods, assumptions, known limits, release audit, and version 6.1.0.
- `src/app/tests/` and browser run: import → fit → export → reload verification using the real Research interface.

## Tasks

### Task 1: Shared fitting status contract

- Add tests first for exact-observation count below `freeParameterCount + 1`, sufficient exact observations, local rank deficiency, and non-converged optimization.
- Verify the tests fail on the current `fitParameters` implementation.
- Implement the shared rule in `fitParameters`; return `status: "NOT_IDENTIFIABLE"` with null estimates and no predictions when the exact-data minimum fails. Keep convergence and rank status separate from optimizer output.
- Run `node --test src/analysis/tests/fitting-recovery.test.js`.

### Task 2: Model-specific kill diagnostics

- Add tests first for each parameter hitting either bound, `errorSigmaLog10` at its lower bound, non-convergence, requested profile success, and profile not requested or unable to complete.
- Verify each new diagnostic test fails before implementation.
- Make the kill workflow report a structured `fitDiagnostics` record, with `NOT_ASSESSED` for skipped/failed profiles and no estimates for any strain failing the shared exact-data gate. Update its JSON schema and group-level warning behavior.
- Run `node --test src/analysis/tests/kill-workflow.test.js`.

### Task 3: Least-squares research workflow

- Add a small OD dataset test that fails the exact-data rule and assert the workflow returns status only with no biological parameter values.
- Verify the test fails before implementation.
- Short-circuit the OD least-squares result before identifiability, validation scoring, or package generation; retain the existing Jacobian and objective-slice diagnostics for eligible fits, and label non-likelihood slices accurately.
- Run `node --test src/analysis/tests/od-observation-model-workflow.test.js`.

### Task 4: Interface statuses and complete exports

- Test import-card readiness status, analysis status, and export-menu availability for both OD and kill results.
- Test that each result export includes app version, requested/effective settings, and all derived seeds; preserve CSV formula protection and standalone dataset semantics.
- Add localized UI strings, render the statuses at import, fit, and export, and add a kill result JSON/CSV export path.
- Test state reinitialization and restoration so the documented default preset and seed are shown consistently after reopening.
- Run `node --test src/app/tests/research-view.test.js src/app/tests/research-export.test.js src/app/tests/research-controller.test.js`.

### Task 5: Registry purpose and published-table regression fixtures

- Add tests that transferred CAB1/LB parameter records explicitly declare teaching calibration purpose and are rejected as condition-matched research-fit parameters.
- Add a source-attributed test fixture from the identifiable reported portions of Foerster 2016 Tables S1 and S2; include only reported values with finite, informative model-based standard errors, and assert the excluded extreme/weakly identified portions remain excluded.
- Verify both sets of tests fail before implementation.
- Add registry purpose fields and validator checks; add Node regression tests for fixture identity, units, parameters, and identifiability inclusion rules. Preserve a linked R source script or recorded R cross-check with version and seed where the original-data calculation is reproducible.
- Run the registry and analysis tests plus the targeted R cross-check.

### Task 6: Documentation and release record

- Add method, assumptions, identifiability threshold, profile-likelihood interpretation, convergence handling, limits of the published-data comparison, and each code/data change to the changelog.
- Update the release checklist and current version references to 6.1.0 while keeping files explicitly named 6.0.0 as historical artifacts.
- Run `npm run check:version` and `npm run audit:data`.

### Task 7: Full verification and browser workflow

- Run `npm run check:syntax`, `npm run check:version`, `npm run test:release`, `npm test`, and `npm run build:public`.
- Start the local app and exercise real browser import → fit → export; inspect all three statuses and the exported metadata.
- Reload the browser application and verify the default preset/seed and persisted dataset/run are restored as documented.
- If a regression appears, revert only the current task's changes and rerun the focused test before proceeding.

## Acceptance Coverage

1. Every fitting entry point uses the common identifiability gate; insufficient uncensored data never produces parameter numbers.
2. Convergence, each boundary hit, sigma lower-bound hits, and profile assessment are explicit.
3. Import, fit, and export states are visible; export metadata includes version, settings, and seeds.
4. Node tests cover censored likelihood, Regoes equivalence, identifiability, bounds, and identifiable Table S1/S2 fixtures.
5. Teaching calibrations are machine-marked and excluded from research-use claims.
6. Method, assumption, limitation, changelog, checklist, and version are updated.
7. Real browser flow is observed end to end and re-open defaults are checked.
