# Evidence-led Research Upgrade Implementation Plan

**Approval:** User selected option B on 2026-09-07: preserve the teaching model, upgrade research in versioned layers, retain unsupported-claim warnings.

**Goal:** Fix verified software/numerical defects and deliver literature-informed, reproducible, development-only OD600 model comparisons without inventing antibiotic validation evidence.

**Architecture:** Retain the single-population Regoes/logistic scientific core and original data. Add a versioned research workflow that uses the existing audited import and calibration pipeline, plus training-only direct-OD model comparison and paired training-curve resampling. Content-addressed replay packages contain explicit computation settings and permit only built-in, exact-version implementations.

**Tech stack:** Native JavaScript ES modules, Node >=20.19, Web Workers, SVG, IndexedDB, node:test; no new runtime dependencies.

## Global constraints

- During the local implementation phase: no commits or branches. Do not discard user edits or overwrite original datasets / 5.0.0 example artifacts. After final verification, the user explicitly authorized committing and uploading these changes to the existing GitHub repository on 2026-09-07; that later publication authorization supersedes the earlier no-commit/no-push restriction, but not the data-preservation constraints.
- Preserve `src/app/tests/persistence.test.js` user expectations.
- Scientific core remains 2.0.0 and model 1.0.0; new analysis semantics use analysis 2.0.0 and application 6.0.0.
- Old published holdout has been inspected; new analysis reports development comparison, not untouched/external validation.
- No clinical, resistance-evolution, combination-therapy or CFU-from-OD claims.
- Only verified licensed data are bundled. Original XLSX exist on disk despite editor ignore filtering; their hashes were verified.
- Every production change follows failing-test → implementation → passing-test; no tests assert a preferred scientific result.

## 1. Repository and export correctness

Files: `src/app/persistence.js`, `src/app/research/export.js`, `src/app/research/controller.js`; matching tests in `src/app/tests/`.

- [x] Reproduce four existing persistence failures.
- [x] Add tests for memory revision conflict, defensive storage status, blocked/timeout reasons, generic source isolation, strict JSON export, restoration revision checks.
- [x] Implement status contract `{backend,persistent,state,fallbackReason,lastError}`; retain initialization-only fallback and explicit runtime failure.
- [x] Preserve JSON schema and hashes by exporting the actual manifest/package, not adding undeclared root properties.
- [x] Match stored results to dataset id + revision + content hash.
- [x] Run targeted persistence/export/controller tests and include them in the passing full build.

## 2. Numerical and statistical correctness

Files: `src/analysis/optimizers.js`, `sensitivity-morris.js`, `sensitivity-sobol.js`, `identifiability.js`; targeted tests.

- [x] Regression oracle: Nelder–Mead on `(x-.8)**2`, bounds [0,1], start .2, maxEvaluations 3 returns the best evaluated x=.3, value=.25, converged=false.
- [x] Regression oracle: Morris on `2*x-3*y+5`, x∈[0,2], y∈[0,10], returns normalized mu≈[4,-30]. Grid-compatible delta validated; effect scale marked.
- [x] Add paired-row bootstrap uncertainty for Jansen indices with fixed seeds; retain raw finite estimates and flag imprecision rather than clipping/reordering.
- [x] Report objective slices truthfully; retain deprecated aliases, avoid interpreting slice endpoints as likelihood confidence limits.
- [x] Preserve rank-deficiency warnings and do not report pseudoinverse covariance as fully identified parameter uncertainty.
- [x] Test linear/additive and Ishigami oracles, degenerate variance, deterministic bootstrap, incomplete optimizer budgets.
- [x] Independent-review hardening: limit Sobol bootstrap to 2000 replicates and 100 million scalar squared differences, with regression coverage.

## 3. Literature-informed OD comparison

New modules: `src/analysis/growth-comparison.js`, `src/analysis/tests/growth-comparison.test.js`.

- [x] Direct-OD logistic and explicitly OD-scale Gompertz curves with baseline, positive amplitude/rate, and timing parameter; no hidden CFU conversion or unsupported physiological lag interpretation.
- [x] Fit by bounded optimizer using training observations only; retain all convergence diagnostics.
- [x] Select candidates using complete-curve training-only cross-validation; preserve exact-time training-mean baseline and deterministic tie policy.
- [x] Evaluate the selected frozen candidate on the previously viewed development curves; never use their values to choose bounds or models.
- [x] Resample complete training trajectories with replacement, refit selected model and retain joint parameter samples, failures and conditional exploratory intervals. Independence remains unverified.
- [x] Test synthetic mathematical recovery separately from real-data metrics; test that development-value changes cannot alter training fits, selection or bootstrap.

References: Zwietering 1990 DOI 10.1128/aem.56.6.1875-1881.1990; Stevenson 2016 DOI 10.1038/srep38828; Aida/Ying 2025 DOI 10.1038/s41597-025-05356-3. Gompertz on OD is an explicitly empirical observation-scale adaptation, not the paper's log population variable.

## 4. Versioned research workflow and replay

New modules: `src/analysis/research-upgrade.js`, `src/analysis/research-replay.js`; targeted tests. Integrate `src/analysis/index.js`, Worker dispatch and browser research controller/view/state.

- [x] New workflow wraps existing calibration, adds OD comparisons, and labels observed holdout as development. Distinguish completed/converged/identified/precision assessed.
- [x] Emit complete computation inputs, source text/hash, resolved model, algorithm versions, RNG seeds and scientific-result reference as package artifacts.
- [x] Reject oversized input, malformed inventory, artifact tampering, unsafe paths, duplicate IDs, unsupported replay versions or missing replay input. Never execute imported code or fetch dependencies.
- [x] Legacy packages without replay inputs are inspect-only; exact-version packages can replay via Worker and compare scientific outputs under declared tolerances.
- [x] Test package round trip, tamper rejection, version refusal, cancellation and source association.
- [x] Independent-review fix: compare the complete analysis manifest as well as scientific output during explicit replay, so a separately rehashed contradictory report cannot produce matched=true.

## 5. Release, evidence and presentation

Files: `package.json`, `src/app/version.js`, `src/analysis/version.js`, generation/release scripts and tests; README and existing docs; add method evidence review.

- [x] Freeze historical 5.0.0 examples, create 6.0.0 example from actual computation, preserve negative results and explicit convergence/precision warnings.
- [x] Update bilingual privacy, development-validation labels, methods and replay UI; no visual framework rewrite.
- [x] Document verified paper/data status, source limitations and implementation differences. No unverified candidate data is admitted.
- [x] Run targeted tests, full tests/data audit, full/public build and reproducibility audit; isolated Chromium smoke executed. Final records are maintained in release-checklist.md.
- [x] Independent code review; fix material findings, including standalone CSV development disclosure and full-manifest replay comparison; retain residual scientific/browser limitations.

## Initial validation

2026-09-07 baseline: `npm test` 251 tests, 247 pass, 4 persistence failures. Three source XLSX byte hashes match acquisition declarations. Git initially has only user changes in `src/app/tests/persistence.test.js`.

## Continuation record

### 2026-09-07 final verification handoff (before publication authorization)

- **Goal:** finish the approved B upgrade, with honest project introductions and evidence.
- **State:** all implementation/documentation steps above and final validation complete. No commit, branch, push or deployment.
- **Context:** application 6.0.0 / analysis 2.0.0; teaching core 2.0.0 and model 1.0.0 unchanged. Old viewed holdout is development only; no new antibiotic dataset admitted.
- **Changed files:** analysis growth/composite/replay modules and tests; numerical, storage, Worker, state/view/export corrections; release scripts/schema/example; README/docs/blueprints. Original user persistence tests and historical artifacts preserved.
- **Validation:** targeted regression red→green; final npm test 500/500; full/public builds, data audit and 59 release tests passed; two clean builds identical across 157 files. Final real Chromium smoke 24/24; full-manifest and CSV review findings independently fixed/rechecked. Exact commands, hashes and browser evidence are in [release checklist](./release-checklist.md).
- **Next:** user may review the project-introduction draft and confirm personal contribution scope. Manual cross-browser/accessibility/P95 and any future independent experimental validation remain separate follow-up work, not blockers hidden as completed.
- **Pitfalls:** editor filtering hides real source XLSX; wrapper JSON is not itself a research package; integrity inspection is not scientific matching; small baseline selection/nonconvergence is not parametric model improvement; no untouched or independent antibiotic validation claim.

### 2026-09-07 GitHub publication authorization

After the local handoff above, the user explicitly requested uploading all of this update to their GitHub and providing a detailed introduction. Publication targets the existing `main` branch of `Keng0nion/ecolab-antibiotic-modeling`, using the installed, authenticated GitHub CLI and normal Git push without history rewriting. The existing Pages workflow is triggered by that push. Raw workbooks, local browser evidence, credentials and generated build directories remain excluded from Git. See [6.0.0 release notes](./release-notes-6.0.0.md) for the publication scope and links to the authoritative remote commit / Actions records.
