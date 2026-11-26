# Expanded BW25113 Real-Data Validation Plan

**Goal:** Use checksum-verified authoritative BW25113 OD600 curves to independently compare Ecolab's direct-OD model selection and held-out trajectory scoring against R.

**Architecture:** A reproducible JavaScript benchmark reads the pinned Figshare workbooks, verifies their hashes, selects source-quality-passing curves from twelve evenly spaced conditions, and runs Ecolab's existing growth comparison without changing model code. A second larger same-condition cohort checks finite-sample resolution of simultaneous trajectory bands; base R independently refits and scores the exported observations. A short report records the source, split, scores, warnings, and limits.

**Tech Stack:** Node.js built-ins, Ecolab analysis modules, the repository XLSX reader, R 4.6.2 with readxl and base-R optim.

## Global Constraints

- Preserve all pre-existing staged, unstaged, and untracked workspace changes.
- Keep the raw Figshare workbooks under ignored `data/raw/`; do not alter original source values.
- Do not modify production model behavior unless the benchmark establishes a defect.
- Keep the analysis to untreated direct OD600; do not convert OD to CFU or infer antibiotic effects.
- Verify exact source hashes and use complete-trajectory splits.
- Run focused benchmark checks, `npm run check:syntax`, `npm run check:version`, and `npm run test:release` for source changes.

### Task 1: Cohort selection helper

**Files:** Create `scripts/benchmarks/validate-bw25113-expanded.js`; create `scripts/benchmarks/tests/validate-bw25113-expanded.test.js`.

- [ ] Test deterministic selection of quality-passing groups, minimum common time support, and exclusion of the previously analyzed condition.
- [ ] Run the test and verify it fails because the cohort helper is absent.
- [ ] Implement only the source-metadata parsing and deterministic cohort selection needed by the test.
- [ ] Run the focused test and verify it passes.

### Task 2: Ecolab JavaScript benchmark

**Files:** Extend `scripts/benchmarks/validate-bw25113-expanded.js`.

- [ ] Build complete-trajectory datasets for the twelve-condition cohort and larger Cond00003 cohort.
- [ ] Run `runGrowthModelComparison` with recorded seeds, bounds, folds, and optimizer budgets; export compact observations, model scores, held-out trajectory scores, and interval coverage summaries.
- [ ] Re-run the script and verify byte-stable outputs.

### Task 3: Independent R comparator

**Files:** Create `scripts/benchmarks/validate-bw25113-expanded.R`.

- [ ] Read the exported observations and JS score tables, independently fit the same candidates with bounded `optim`, and verify model rankings and held-out scores within declared tolerance.
- [ ] Verify condition splits, time grids, units, input hashes, and counts before fitting.
- [ ] Run the R script and resolve any material ranking or score mismatch before reporting.

### Task 4: Research report and repository checks

**Files:** Create `docs/research/2026-11-26-bw25113-expanded-real-data-validation.md`; update `package.json` syntax registration only for the new JavaScript benchmark.

- [ ] Report the source, eligibility counts, cohort rules, JavaScript/R agreement, interval finite-sample limits, warnings, and what this OD-only evidence cannot establish.
- [ ] Run focused tests, `npm run check:syntax`, `npm run check:version`, and `npm run test:release`.
- [ ] Confirm the final diff is limited to the new benchmark, report, plan, and one syntax-list entry.
