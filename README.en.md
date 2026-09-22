**Contents:**

- [Chinese](README.md)
- [English](README.en.md)
- [Japanese](README.ja.md)

# Ecolab 6.0.0

![Screenshot of the Ecolab learning interface](./docs/screenshot.png)

Ecolab is a local-first, auditable, and reproducible *E. coli*–antibiotic population modeling project, with a bilingual Learn / Sandbox and a real-data Research Workspace.

> For teaching, model exploration, and research-grade analysis; not a clinical decision tool, and not a condition-matched validated general-purpose experiment predictor.

## Reading guide

- [Online website](#online-website) · [Version contract](#version-contract) · [Commands](#commands)
- [How the code works](#how-the-code-works)
  - [1. Layered structure and call chain](#1-layered-structure-and-call-chain)
  - [2. Teaching model and piecewise analytic computation](#2-teaching-model-and-piecewise-analytic-computation)
  - [3. Real-data import and the observation layer](#3-real-data-import-and-the-observation-layer)
  - [4. Fitting optimization and model comparison](#4-fitting-optimization-and-model-comparison)
  - [5. Parameter sweeps and sensitivity analysis](#5-parameter-sweeps-and-sensitivity-analysis)
  - [6. Uncertainty and identifiability](#6-uncertainty-and-identifiability)
  - [7. Browser rendering and task execution](#7-browser-rendering-and-task-execution)
  - [8. Local storage and recovery](#8-local-storage-and-recovery)
  - [9. Research package validation and explicit replay](#9-research-package-validation-and-explicit-replay)
  - [10. Build tests and source reading order](#10-build-tests-and-source-reading-order)
- [Documentation](#documentation) · [License and data attribution](#license-and-data-attribution)

## Online website

- GitHub Pages: https://keng0nion.github.io/ecolab-antibiotic-modeling/
- On every push to `main`, `.github/workflows/deploy-pages.yml` runs `npm run build:public`, validates the public repository materials, and automatically publishes `dist/web/`.

## Version contract

- App: `6.0.0`
- Scientific core: `2.0.0` (teaching dynamics unchanged)
- Analysis engine: `2.0.0` (numeric fixes, OD model comparison, and same-version replay)
- Model: `ecolab.single-population.regoes-logistic@1.0.0`

The root `package.json` is the authoritative source for the app release version. The new release keeps the teaching Regoes/Logistic model and adds direct OD-scale Logistic/Gompertz, whole-curve cross-validation on training data, joint whole-curve bootstrap, and checksum-verified same-version replay of research packages. The previously held-out data has been viewed; new results are explicitly labeled as development-set comparisons, not an untouched test set or external validation.

In the actual `small` example, training cross-validation selected the mean-per-time baseline, with a development macro RMSE of `0.00304756`; the original latent population model scored `0.00833386`, still worse than the baseline. Warnings that the parameter model did not converge, and that identifiability and statistical precision are insufficient, are all preserved. Unprocessed OD600 data cannot validate the efficacy of the three antibiotics, nor identify absolute CFU.

## Commands

Requires Node.js 20.19 or newer; there are no third-party runtime dependencies.

```bash
npm start
npm run dev
npm run test:release
npm run build
npm run build:public
npm run audit:release
npm run check:reproducible
npm run example:research
npm run preview
```

**When running from the public GitHub repository for the first time, prefer `npm run build:public`, then `npm run preview`**; `npm run dev` serves the source directory directly, without a build or full checks. `npm start` runs the full `build`, then starts the server and opens the default browser, but its data audit requires local raw data materials — do not assume that cloning the public repository alone provides them. See [Data candidate review](./docs/data-candidate-review.md) for the concrete acquisition and audit steps.

Press `Ctrl+C` in the terminal to stop the server. Default outputs are `dist/core/` and `dist/web/`; both build scripts accept `--out-dir` to specify an isolated output directory. `npm run example:research` generates versioned example files — after changing the algorithms, do not regenerate examples to mask historical regression differences.

## How the code works

The following explains the actual data flow, mathematical computation, and engineering constraints of the current `6.0.0` source. Links point to concrete implementations; the papers explain the methodological basis and cannot replace this project's condition-matched experimental validation. The app does not depend on React, third-party optimizers, or remote compute services — it uses native JavaScript ES Modules, DOM/SVG, Web Workers, and IndexedDB.

### 1. Layered structure and call chain

The code separates "what the model is", "how analysis is done", and "how interaction and saving work":

```text
src/model.js                  Teaching science API entry
src/model/                    Units, efficacy functions, piecewise protocol, analytic advance, observation marks
src/registry/resolve.js        Resolves the sourced parameter registry into a frozen model snapshot
src/experiment/run-manifest.js Teaching run manifest
src/analysis.js               Research analysis API entry
src/analysis/                 Fitting, sweeps, sensitivity, uncertainty, research workflow, and replay
src/app/main.js               Page startup, routing, teaching interaction, and rendering
src/app/research/              Research state, controllers, import, charts, and export
src/app/workers/               JSON task protocol, dispatch client, and compute entry
src/app/persistence.js         IndexedDB and volatile in-memory repository
```

**Teaching path**: page action → `experiment.js` updates the project → `compileSimulationRequest()` compiles the exposure protocol → `simulatePiecewise()` returns the trajectory → SVG charts, data tables, and formula explanations. The scientific core never reads the DOM or accesses the database; callers explicitly provide the model and inputs; the same API can be called by Node.js tests and the browser.

**Research path**: import source text → Worker parses and runs quality checks → controller saves qualified data → `TaskClient` starts a research Worker → `runEcolabResearchWorkflow()` → results, diagnostics, and research package → page display and local persistence.

The internal order of the current research combination entry is:

```text
runEcolabResearchWorkflow()                  research-upgrade.js
  ├─ Normalize full settings, model snapshot, input hashes, and seeds
  ├─ runEcolabStage4ResearchWorkflow()       research-workflow.js
  │    Data checks → OD calibration of the latent population → local identifiability diagnostics
  │    → Freeze development comparison → Parameter sweeps → MC → Local / Morris / Sobol
  ├─ runGrowthModelComparison()             growth-comparison.js
  │    Whole-curve training CV → Model selection → Full training-set refit
  │    → Whole-curve bootstrap of the selected model → Frozen development comparison
  └─ Summarize evidence status, warnings, manifest, and research package
```

The old `runEcolabStage4ResearchWorkflow()` remains as a compatibility entry; it is not the full v2 workflow with growth-curve comparison. Ordinary data import, the general analysis API, and the built-in one-click BW25113 research flow are also not the same admission scope.

Source: [science entry](./src/model.js), [analysis entry](./src/analysis/index.js), [teaching project](./src/app/experiment.js), [research combination entry](./src/analysis/research-upgrade.js), [research controller](./src/app/research/controller.js).

### 2. Teaching model and piecewise analytic computation

#### 2.1 Parameters resolved first, units unified first

`resolveModelFromRegistries()` looks up the model definition and parameter set by exact `id + version`, rejects duplicate, missing, or mismatched references, checks parameter units and source provenance, and then produces a deeply frozen `ResolvedModel`. Parameter exploration uses copies and never writes back to the literature parameter registry.

Internal units are unified to time `h`, concentration `mg/L`, population `log10(CFU/mL)`, and net growth rate `log10-fold/h`. Minutes in input are converted to hours; `µg/mL` is numerically equal to `mg/L`; linear CFU/mL must be positive, and unknown units raise an error directly — no guessing or silent conversion.

- `psiMaxLog10PerHour = log10(2) / doublingTimeHours`; with the current teaching doubling time of `42 min`, this gives about `0.43004 log10-fold/h`.
- `carryingCapacityLog10CfuPerMl = 9`, i.e. `K = 10^9 CFU/mL`, a teaching assumption.
- Each drug's `zMicMgPerL`, `hillKappa`, and `psiMinLog10PerHour` correspond to the `zMIC`, `κ`, and `ψmin` below.
- Ampicillin's three parameters are `(3.4, 0.75, -4)`; tetracycline `(0.67, 0.61, -8.1)`; ciprofloxacin `(0.017, 1.1, -6.5)`, in units of `mg/L`, dimensionless, and `log10-fold/h` respectively.

The three-drug values reference the **CAB1/LB** conditions of [Regoes et al. (2004), Table 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC521919/). The growth baseline comes from [BioNumbers 111767](https://bionumbers.hms.harvard.edu/bionumber.aspx?id=111767) / [Campos et al. (2014)](https://doi.org/10.1016/j.cell.2014.11.022). The project keeps cross-condition migration markers and cannot be called an efficacy parameter estimate under BW25113/M9.

Source: [registry resolution](./src/registry/resolve.js), [unit conversion](./src/model/units.js), [parameter registry](./data/registry/parameter-sets.json), [source index](./data/registry/sources.json).

#### 2.2 How concentration becomes net growth rate

For a single-drug concentration `C`, `evaluateRegoesNetGrowth()` implements:

```text
q(C) = (C / zMIC)^κ
ψ(C) = ψmax - (ψmax - ψmin) × q(C) / (q(C) - ψmin / ψmax)
```

This function satisfies `ψ(0)=ψmax` and `ψ(zMIC)=0`, and approaches `ψmin` at high concentrations. `zMIC` is the model's zero-net-growth concentration, not a clinical breakpoint, and not equal to the source paper's broth-dilution MIC; the latter is kept only as source context.

The implementation does not directly compute huge powers that could overflow; for `C>0` it rewrites to:

```text
a = κ × ln(C/zMIC) - ln(-ψmin/ψmax)
w = sigmoid(a)
ψ = ψmax × (1-w) + ψmin × w
```

`sigmoid()` computes the exponential by positive/negative branches; zero concentration returns `ψmax` separately, and results with absolute value below `1e-14` are zeroed to avoid rounding residue at the zero-net-growth boundary. Here `ψ` is the net change rate; the code does not estimate birth and death rates separately, so the net population decline cannot be called cumulative deaths.

Source: [efficacy function and numerically stable expression](./src/model/regoes-logistic-v1.js).

#### 2.3 How the population advances, and why it is not Euler integration

In an interval with constant concentration and duration `Δt`, `advancePopulationAnalytically()` uses piecewise analytic formulas:

```text
ψ > 0：dN/dt = ln(10) × ψ × N × (1 - N/K)
       N(t+Δt) = K / [1 + (K/N(t)-1) × exp(-ln(10) × ψ × Δt)]

ψ ≤ 0：d log10(N)/dt = ψ
       log10(N(t+Δt)) = log10(N(t)) + ψ × Δt
```

`ln(10)` converts the decimal-log growth rate into a natural exponential growth rate. Only the positive-growth branch carries the carrying-capacity constraint; the negative branch is not multiplied by `1-N/K`, otherwise when the population is exactly K a density factor would wrongly stop the decline.

To reduce underflow at very low populations and cancellation error near K, positive growth actually advances in the log-odds coordinates of `N/K`, then recovers the log population via stable expressions such as `softplus`, `expm1`, and `log1p`, rather than repeatedly computing linear CFU. Zero growth or zero duration keeps the state as-is; an initial population above K is rejected.

`simulatePiecewise()` chains multiple intervals together:

1. Validates that the protocol starts at 0, each segment has positive duration, and adjacent intervals are continuous and non-overlapping; one protocol allows only one drug.
2. Validates that sample times are unique, strictly increasing, within the protocol, and completes the simulation start and end.
3. For each target sample time, advances to the earlier of the "sample time" and the "current interval end"; if it crosses segments, it keeps advancing — it never jumps across a concentration change and computes with a single constant.
4. Intervals use `[start,end)`, and the final end is included. Population is continuous at boundaries; the concentration and `ψ` at boundary outputs use the right-side newly-exposed condition.
5. `observePopulation()` attaches `belowDetectionLimit` separately; the detection limit only marks observations and never truncates the latent population to the detection limit or zero.

Therefore, sampling interval controls output density and is not an Euler/RK time step; the same constant exposure split into multiple intervals should keep the same final state within floating-point tolerance. The simulation is still a continuous density model and contains no single-cell stochastic extinction, resistance evolution, or persisting subpopulations.

In the teaching interaction, "add drug" first forms a `pendingAction`, committed as an interval only when time advances; adjacent same-concentration segments can be merged, and the action history is still kept. "Dilute/wash" changes only the drug concentration, not the bacteria count or culture volume.

Source: [protocol validation](./src/model/protocol.js), [piecewise dispatch](./src/model/simulate-piecewise.js), [analytic advance](./src/model/regoes-logistic-v1.js), [observation layer](./src/model/observe.js), [boundary and detection-limit tests](./src/tests/model.test.js).

#### 2.4 Minimal runnable science API example

The following ES module example uses the repository root as the working directory and can be executed via Node.js `--input-type=module` standard input. It resolves the model from the actual registries and simulates 1 h of drug-free growth followed by 1 h at `4 × zMIC` ciprofloxacin; these are teaching protocol inputs, not dosing advice.

```js
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries, simulatePiecewise } from "./src/model.js";

const [modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all(
  ["model-definitions", "parameter-sets", "sources"].map(async (name) =>
    JSON.parse(await readFile(`data/registry/${name}.json`, "utf8")),
  ),
);
const model = resolveModelFromRegistries({
  modelRegistry,
  parameterRegistry,
  sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const zMic = model.parameters.drugs.ciprofloxacin.zMicMgPerL;
const result = simulatePiecewise(model, {
  initialState: { populationDensity: { value: 1e6, unit: "CFU/mL" } },
  protocol: {
    kind: "piecewise_constant",
    drugId: "ciprofloxacin",
    segments: [
      {
        start: { value: 0, unit: "h" },
        end: { value: 1, unit: "h" },
        concentration: { value: 0, unit: "mg/L" },
      },
      {
        start: { value: 1, unit: "h" },
        end: { value: 2, unit: "h" },
        concentration: { value: 4 * zMic, unit: "mg/L" },
      },
    ],
  },
  sampleTimes: [0, 0.5, 1, 1.5, 2].map((value) => ({ value, unit: "h" })),
  observation: { detectionLimit: { value: 10, unit: "CFU/mL" } },
});
console.table(result.trajectory);
```

Each returned row contains `timeHours`, `concentrationMgPerL`, `netGrowthLog10PerHour`, `latentLog10PopulationDensity`, and the detection-limit mark. The population in the 1 h row has already completed the first hour of drug-free growth, but that row's concentration is the newly-set `0.068 mg/L`; this is exactly "state continuous, concentration right-continuous" — not computing the previous interval with the new drug concentration in advance.

### 3. Real-data import and the observation layer

#### 3.1 From file to analyzable data

The CSV parser in `dataset-import.js` is a character state machine, handling quotes, escaped double quotes, commas, CRLF, and BOM, and checking the required column set, finite numbers, and nested JSON. Import has file-size, row/column-count, field-length, and nesting-depth limits; it does not guess units, auto-smooth, or fill in points. Browser CSV import requires the user to explicitly provide `datasetId`, title, and license; the underlying public import API's license field is optional, but provenance and license are never auto-inferred from filenames.

The browser import chain is `file.text()` → `dataset.parse` Worker → normalized `observation-dataset` → QC → data record. Only QC-qualified data is persisted. Generic imports are marked as unversioned file provenance and do not automatically inherit Figshare attribution, license proof, or built-in research eligibility.

Built-in data loading also validates the exact registry version, the normalized JSON source text SHA-256, observation counts, and splits. The current one-click research targets BW25113 drug-free raw OD600 and requires curves with complete exact-time support; this does not mean an arbitrary CSV can run the same combination workflow.

Source: [strict import](./src/analysis/dataset-import.js), [quality checks](./src/analysis/dataset-quality.js), [browser data loading and admission](./src/app/research/dataset-loader.js), [normalized data and source conditions](./data/datasets/figshare-bw25113-growth-v1/README.md).

#### 3.2 Drug-free OD cannot directly become absolute CFU

The real data comes from [Aida / Ying (2025), Figshare](https://doi.org/10.6084/m9.figshare.28342064.v1): 12 curves, 528 points, 0.5–22 h, one observation every 0.5 h, all drug-free, blank-uncorrected OD600. Training uses 8 curves / 352 points; the viewed development comparison uses 4 curves / 176 points; curve labels cannot prove independent biological experiment batches.

Latent population calibration introduces an observation mapping:

```text
OD(t) = b + s × N(t)/K
```

Each training objective evaluation first generates `N(t)/K` with the biological parameters, then `profileOdObservationLayer()` analytically solves the constrained OD nuisance parameters `b≥0`, `s≥1e-12`: it compares the feasible unconstrained linear regression solution and boundary candidates and takes the one with the minimal training SSE. This avoids making the numerical optimizer search four parameters simultaneously. `b`, `s`, and all biological parameters are frozen before development evaluation; the development observations are not used for re-calibration.

This mapping is not an experimentally calibrated OD→CFU conversion; K is fixed to the value in the passed `resolvedModel` snapshot, not estimated from OD data, and the current default snapshot uses the teaching values above. The current source data has no t=0; the model can advance from the initial state at time zero to the first observation, but it will not fabricate a source t=0 measurement. The blank and instrument dependence of OD references [Stevenson et al. (2016)](https://doi.org/10.1038/srep38828).

Source: [OD observation mapping and analytic nuisance solving](./src/analysis/od-observation-model.js), [training and frozen evaluation](./src/analysis/research-workflow.js).

### 4. Fitting optimization and model comparison

#### 4.1 Two models, two objective functions

**Latent population calibration** searches only `psiMaxLog10PerHour` and `initialStates.pooled.log10PopulationDensity`, with ranges `[0.05,0.8]` and `[3,min(8.5,Klog10−0.1)]` where `Klog10` is the log carrying capacity in the snapshot; the current default initial-state range is `[3,8.5]`. Each evaluation re-solves the training OD observation layer and minimizes the training-observation SSE. It does not fit the three drugs' `zMIC`, `κ`, or `ψmin`.

**Direct OD comparison** uses three candidates: the training mean baseline at exact observation times, Logistic, and Gompertz. The parameterized curves are:

```text
Logistic：f(t) = b + A / (1 + exp(-r × (t-ti)))
Gompertz：f(t) = b + A × exp(-exp(-r × (t-ti)))

J(θ) = (1/U) × Σu [(1/nu) × Σj (yuj - f(tuj;θ))²]
```

`U` is the number of trajectories, `nu` the number of observations of trajectory u. The objective is the **equal-weight average of per-trajectory MSE**, not directly minimizing macro RMSE. The default declared engineering boundaries are `b∈[0,0.3]`, `A∈[0.001,1]`, `r∈[0.001,4]`, `ti∈[0,30]`, not physiological ranges reverse-engineered from development data.

`r` is the shape coefficient, `ti` the inflection time; the maximum OD slopes are `A×r/4` and `A×r/e` respectively. `b` is the lower asymptote, not necessarily `OD(0)`. The growth-curve comparison idea references [Zwietering et al. (1990)](https://doi.org/10.1128/aem.56.6.1875-1881.1990), but does not pretend to be its log-population / physiological-rate / lag parameterization.

`training_mean` optimizes no parameters: it takes the mean only at exact training times without interpolation; if an evaluation time has no training support, it does not silently skip that point. The general `fitParameters()` additionally provides censored Gaussian likelihood with explicit error scale, but the current drug-free OD combination flow uses least squares — the API's supported capability should not be written as the method this example actually uses.

Source: [general fitting](./src/analysis/fitting.js), [censored likelihood](./src/analysis/likelihood.js), [direct OD fitting and model selection](./src/analysis/growth-comparison.js).

#### 4.2 Why combine DE with Nelder–Mead

`optimizers.js` implements bounded optimization itself, without calling third-party black-box solvers:

1. **DE global exploration**: initialize the population within boundaries, pick three distinct candidates for a target vector, construct `xa + F × (xb-xc)`; binomial crossover forces at least one mutated coordinate, out-of-range coordinates are clipped to the boundary, and the candidate is accepted when the objective is not worse. Defaults `F=0.8`, `CR=0.9`; the population updates immediately upon acceptance.
2. **NM local refinement**: build a simplex from the DE best point, performing reflection, expansion, contraction, and shrink; candidates remain boundary-constrained.
3. **Budget and restarts**: each phase has an evaluation-count cap, with configurable multi-start restarts; phase seeds, failed candidates, best-evaluated points, and stop reasons are preserved. Even if NM just found a better point before the budget was exhausted, that point is not lost just because it was not yet written into the simplex.
4. **Convergence is not guaranteed**: DE uses population-spread and objective-spread criteria, NM uses simplex-spread and objective-spread criteria; `maximum_evaluations` means the budget is exhausted and cannot be interpreted as having found the global optimum.

Both fitting paths combine DE→NM, but latent calibration goes through `fitParameters()`／`optimizeBounded()`, while direct OD comparison has its own phase-result selection logic — not the same wrapper function. The optimizers search in the passed parameter coordinates; the log transform supported by local sensitivity/Morris is not automatically applied to the optimizers, so this cannot be summarized as "all algorithms run in the same normalized space".

Source: [DE, NM, and best-point recording](./src/analysis/optimizers.js), [parameter whitelist and transforms](./src/analysis/parameter-space.js).

#### 4.3 How time-point leakage is avoided and models evaluated

`crossValidate()` defaults to leave-one-trajectory-out over the training trajectories; you can also explicitly provide trajectory IDs as folds, but all training trajectories must be held out exactly once. Each fold's three candidates use only that fold's training part, and the mean baseline is recomputed — it cannot borrow the full-training-set mean.

Evaluation first computes each trajectory's errors, then aggregates:

```text
euj         = yuj - ŷuj
RMSEu       = sqrt(mean_j(euj²))
macro RMSE  = mean_u(RMSEu)
pooled RMSE = sqrt(ΣuΣj euj² / Σu nu)
MAE         = ΣuΣj |euj| / Σu nu
```

Model selection uses the macro RMSE of all out-of-fold trajectories, not an unweighted average of scores from differently-sized folds. When scores are within the default absolute `1e-10` tolerance of the global minimum (configurable via `crossValidation.tieTolerance`), the pre-declared priority is `training_mean → logistic → gompertz`. Scoreable but non-converged candidates still keep their diagnostic scores, so "being compared" does not mean "fully optimized".

After the frozen selection, candidates are refit on all training trajectories; the selected model gets a bootstrap, and finally development data is evaluated together with the training mean baseline. The source keeps the historical `validation` role field, but current results are explicitly `previously_viewed_development_only`, not an untouched test set.

Actual record for fixed `small`, seed `123456789`: CV selected the mean baseline; development macro RMSE **0.00304756 OD**, MAE **0.00239205 OD**; the original latent model's macro RMSE was **0.00833386 OD**, non-converged. Direct Logistic/Gompertz also did not converge in each CV fold, so this is not evidence of the new models improving prediction accuracy.

Source: [CV and frozen comparison](./src/analysis/growth-comparison.js), [metric aggregation](./src/analysis/metrics.js), [versioned actual results](./data/examples/ecolab-stage6-research-6.0.0.md).

### 5. Parameter sweeps and sensitivity analysis

The analysis algorithms receive a "parameters → finite numeric output" mapping through an evaluator, rather than operating on charts directly. **The current combination workflow's parameter sweeps, MC, and local/Morris/Sobol sensitivity analyses all examine the latent model's predicted OD600 at 10 h, with the training-derived OD observation layer frozen**; they are not a unified ranking of the new Logistic/Gompertz's four parameters or of the three drugs.

- **Parameter sweep**: `parameter-scan.js` enumerates the Cartesian combinations of a declared grid, covering a model copy point by point and recording outputs; it is response-surface exploration, not automatic optimization or confidence intervals.
- **Local finite differences**: `localSensitivity()` picks step sizes in the specified transformed coordinates, preferring central differences, switching to one-sided differences near boundaries; the actual step size and difference direction are recorded. The result is a local derivative, not an automatically normalized elasticity or global importance.
- **Morris**: builds a grid over the transformed parameter range mapped to the `[0,1]` unit cube; each trajectory randomly permutes the parameter visit order and changes one parameter at a time; k parameters need `k+1` evaluations per trajectory. Elementary effects are `EEi = Δf / (±Δ)`, the denominator is the normalized step size, and the signed mean `μ`, absolute mean `μ*`, and sample standard deviation `σ` are reported. With a single trajectory `σ=null`, not zero.
- **Sobol–Jansen**: generates A, B from declared independent input distributions and replaces A's i-th column with B to get `A_Bi`; the base computation is `n×(k+2)` evaluator calls. V is the sample variance of the merged A/B outputs; the estimators are:

```text
STi = Σj [f(Aj) - f(A_Bi,j)]² / (2nV)
S1i = 1 - Σj [f(Bj) - f(A_Bi,j)]² / (2nV)
```

Sobol rejects correlated inputs; pseudo-random sampling is used here, not Sobol low-discrepancy sequences. Paired-row bootstrap uses the same row indices for the A/B/fully-mixed matrices, re-estimating the indices without calling the model again. Output keeps negative indices, `S1>ST`, interval widths, and tail-sample warnings, does not clip results into surface plausibility, and does not auto-append samples due to insufficient precision.

Resource checks apply at different layers: e.g. the public Sobol API limits bootstrap to at most 2000 repetitions and checks `2×B×n×parameters×outputs ≤ 100,000,000`; the workflow separately limits sweep, MC, and trajectory budgets. These are compute constraints, not wall-clock guarantees.

Source: [sweep](./src/analysis/parameter-scan.js), [local](./src/analysis/sensitivity-local.js), [Morris](./src/analysis/sensitivity-morris.js), [Sobol–Jansen](./src/analysis/sensitivity-sobol.js). Method basis: [Morris 1991](https://doi.org/10.2307/1269043), [Jansen 1999](https://doi.org/10.1016/S0010-4655(98)00154-4), [Saltelli 2010](https://doi.org/10.1016/j.cpc.2009.09.018).

### 6. Uncertainty and identifiability

#### 6.1 Three kinds of resampling answer different questions

**Engineering-range Monte Carlo** samples from the declared parameter distributions and propagates to model outputs. `runMonteCarlo()` uses Welford's algorithm to aggregate successful samples' mean and sample variance, saves values and sorts them for R7 quantiles; evaluator failures are recorded, and with all failures it refuses to return statistics. The current workflow's independent triangular ranges are engineering exploration, not data-estimated parameter posteriors, and do not automatically generate observation noise. This implementation keeps results and quantile samples and is not a constant-memory algorithm.

**Sobol paired bootstrap** estimates the Monte Carlo index sampling error under the given input distribution and evaluator; it does not cover data error or model misspecification.

**Whole-curve training bootstrap** samples complete trajectories with replacement, keeping each curve's time–observation pairing and repeat-draw counts, and refits the fixed selected model. It saves joint parameter vectors, mean curves, seeds, convergence, and failures; only finite, converged, fully-predictive refits enter the R7 percentile intervals. The intervals are exploration results under the fixed model, boundaries, and successful-refit conditions; they exclude model-selection uncertainty and new observation noise, and are not simultaneous confidence bands.

When the parameterless mean baseline is selected, the parameter intervals are empty; with at least two successful and fully-predictive bootstrap refits, pointwise mean-curve intervals can still be generated. With bootstrap disabled or insufficient successful samples, no intervals are generated. The current example bootstraps 20 times; under a 95% interval, each tail expects only 0.5 samples; even with 20/20 success, reliable confidence coverage cannot be claimed. Curve independence is not yet sufficiently confirmed, and the joint parameter samples cannot be split into independent marginals and passed off as Sobol inputs.

Source: [MC and R7 quantiles](./src/analysis/monte-carlo.js), [distribution sampling](./src/analysis/distributions.js), [whole-curve bootstrap](./src/analysis/growth-comparison.js).

#### 6.2 Identifiability is not a goodness-of-fit score

`numericalJacobian()` estimates parameters' response on outputs by finite differences, normalized by parameter-boundary span and output scale. `analyzeIdentifiability()` constructs `JᵀJ`, obtains rank, singular values, and condition number diagnostics via symmetric eigendecomposition, and checks boundary hits, near-optimal multi-start parameter separation, and local correlations.

When rank-deficient, the parameter covariance/correlation matrix is unavailable; the kept pseudo-inverse serves only as a geometric diagnostic. Even at full rank, the inverse information matrix in the compatible fields is not noise-calibrated and cannot be treated as a reliable parameter covariance or confidence interval.

The current `objectiveSlices` sweeps one parameter while fixing the remaining biological parameters and re-solving the OD nuisance parameters; this is a **nuisance-profiled objective slice**. It is not a full profile likelihood with all other parameters fully optimized, the sweep endpoints are not confidence limits; the old `profiles` is a compatibility alias only. The distinction references [Raue et al. (2009)](https://doi.org/10.1093/bioinformatics/btp358).

The system therefore records `completed`, `converged`, `identified`, and `precisionAssessed` separately. The current growth comparison has not yet established parameter identifiability and interval coverage; a normal workflow end cannot automatically flip these labels to true.

Source: [Jacobian, rank, and objective slices](./src/analysis/identifiability.js), [overall evidence status](./src/analysis/research-upgrade.js).

#### 6.3 How stochastic processes are reproduced

`random.js` implements `xoshiro128ss-splitmix32-v1`: a uint32 root seed is expanded into state via SplitMix32, then random numbers are generated by xoshiro128**. `deriveSeed()` derives sub-seeds from the root seed and a stable identifier, without consuming the parent stream's state.

MC derives sub-streams by "sample index ＋ parameter name", Morris by trajectory, Sobol by "matrix ＋ row ＋ parameter", and fitting/bootstrap by stage, avoiding results depending on one implicit global random call order. The research package records the root seed, derived seeds, and algorithm identifiers. A fixed seed still requires the same input, budget, boundaries, and compatible implementation; it is not cryptographic randomness, and it does not guarantee byte-identical results across arbitrary software versions or runtimes.

Source: [random numbers and sub-streams](./src/analysis/random.js).

### 7. Browser rendering and task execution

#### 7.1 How the page updates

`main.js` holds the teaching project, research state, and view state; the root node delegates `click/change/keydown` events, dispatches actions via `data-action`, and Hash routing distinguishes Learn, Sandbox, and Research. The main rendering approach is HTML-template DOM rebuild followed by SVG drawing — not virtual DOM diff; `main.js` restores focus, and `ui-state.js` helps restore scroll positions with stable keys.

The research page is divided among controller / state / view / charts. Progress messages update only the progress bar and text, avoiding rebuilding the whole page per message. Views escape text and attributes, and source links are restricted to HTTP(S).

**Teaching compute and research compute run on different threads**: teaching `deriveScientificView()` calls the analytic simulation on the main thread, and teaching playback advances the project per sampling interval; research data parsing, analysis, and research package replay use Workers. Switching pages stops teaching playback, but this cannot be taken as a promise that leaving Research automatically cancels research tasks.

Source: [page entry](./src/app/main.js), [scroll state](./src/app/ui-state.js), [research state](./src/app/research/state.js), [research view](./src/app/research/view.js), [research charts](./src/app/research/charts.js).

#### 7.2 How tasks queue, cancel, and prevent late messages from overwriting

`TaskClient.run()` validates and copies the JSON task, assigns a `taskId`, enqueues, and returns a handle with Promise and cancel, supporting `AbortSignal`. The generic client defaults to concurrency 2, the research UI sets 1; each running task creates its own module Worker, not a reused resident worker pool, with a default run timeout of 5 minutes.

The research UI actually submits `dataset.parse`, `analysis.research-workflow`, `research.package-inspect`, and `research.package-replay`. The generic protocol also provides fitting, sweep, MC, and sensitivity task types, which does not mean the UI has corresponding separate submission entries.

Workers call the built-in API via `dispatchTask()`, returning progress/result/error envelopes. The protocol rejects functions, loops, dangerous object keys, and non-finite JSON; package tasks accept only input text, not arbitrary executable code. The client checks the envelope, task ID, and run status; late messages for already-settled tasks are ignored.

Canceling a queued task removes it from the queue; canceling a running task directly `terminate()`s the Worker and rejects the Promise with `TASK_CANCELLED`. Success, error, cancellation, and timeout all clean up timers, listeners, and the Worker, freeing the concurrency slot. The analysis API has its own cooperative checkpoints, but browser cancellation does not depend on one long synchronous loop handling cancel messages in time, nor does it save partial computation as success.

Source: [task client](./src/app/workers/task-client.js), [JSON protocol](./src/app/workers/task-protocol.js), [Worker dispatch](./src/app/workers/analysis-worker.js), [research Worker entry](./src/app/research/research-worker.js).

### 8. Local storage and recovery

`createProjectRepository()` uses the IndexedDB database `ecolab-local`, database version 2, with three object stores — `projects`, `datasets`, `analyses` — all keyed by `id`.

- **Startup degradation**: an actual read/write probe runs first. When IndexedDB is unavailable, blocked, fails to initialize, or times out, a Map-based in-session repository is returned and a volatile-storage status is exposed to the UI. If a runtime quota error occurs after IndexedDB has been in use, `PERSISTENCE_QUOTA_EXCEEDED` is explicitly raised — it does not silently switch to memory and claim the save succeeded.
- **Concurrent writes**: updating a record requires matching the existing `revision`, incremented after success; IndexedDB completes read, compare, and write in the same readwrite transaction. Conflicts error out — no automatic merging or last-write-wins.
- **Teaching projects**: save the initial state, protocol segments, actions, references, and timestamps; recovery explicitly selects the most recent project and re-computes with the currently loaded model. It does not auto-restore running tasks, nor guarantee teaching archives replay precisely across versions.
- **Research data**: saves the exact `sourceText`, format, content hash, normalized data, provenance, QC, and revision. Same ID/content hash can be reused, avoiding meaningless revision bumps.
- **Research results**: saves completed results with `datasetRef`. Recovery must match `id + revision + contentHash` together, otherwise old results are not attached to new data; in-progress records are treated as interrupted and do not support resuming computation.

The association checks of storage recovery are not a recomputation of data hashes or scientific replay. Clearing site data, browser storage eviction, or a refresh after in-memory degradation can all lose records; important work should be exported as a research package. CSV is more suitable as data-exchange/viewing material; the current export with sourced preamble and formula guards cannot be promised to re-import losslessly.

Source: [repository and migration](./src/app/persistence.js), [research record construction and recovery matching](./src/app/research/controller.js), [export](./src/app/research/export.js).

### 9. Research package validation and explicit replay

#### 9.1 What the package stores

`buildArtifacts()` aggregates the normalized observation data, split, locked analysis plan, resolved model snapshot, complete replay input, and scientific results. The replay input contains the exact source text and hash, format, model, full settings and budgets, root/derived seeds, and version identifiers; function callbacks are never serialized.

The manifest records software and implementation versions, parameters/provenance, data and split fingerprints, algorithm settings, stop settings and budgets, failure and convergence info, diagnostics, evidence status, and warnings; each phase's actual `terminationReason` is kept in the scientific results' optimization diagnostics. `buildResearchPackage()` generates an `id/role/path/mediaType/SHA-256/UTF-8 byteLength` inventory for each content.

Strings hash by the original text; JSON hashes by canonical serialization with recursively sorted object keys and preserved array order. **The original workbook hash, the normalized JSON file-text hash, and the canonical object fingerprint are hashes of different objects** and must not be mixed. SHA-256 uses WebCrypto or a pure JavaScript fallback; no content is uploaded.

Source: [artifact assembly](./src/analysis/research-upgrade.js), [manifest and package build](./src/analysis/analysis-manifest.js), [canonical JSON and hashing](./src/analysis/fingerprint.js).

#### 9.2 Why import does not start computing directly

`inspectResearchPackage()` performs strict checks first:

1. JSON/schema, field, and resource limits, e.g. at most 32 MiB, 64 artifacts.
2. Content hash and UTF-8 length, unique IDs, case-insensitive unique paths, one-to-one inventory-to-content correspondence; path traversal and URL-style paths are rejected. In-package paths are only labels and are never used to read files or download from the network.
3. Identity/fingerprint associations of normalized data, split, model snapshot, locked plan, and manifest.
4. Complete replay input, source text SHA, consistency of the re-parsed source text with the normalized data, and seed, settings, and version associations.

Old-style packages (missing versioned replay input) that pass the applicable structure, integrity, and association checks, or packages incompatible in version/implementation, may be viewed only; packages declaring the new replay that lack required artifacts or options are rejected. The current replayable whitelist requires exact app/engine/model/workflow implementation and dependency declarations, not loose semver. A package carries data and configuration but no executable software; the current build explicitly declares `selfContained:false` and will not install dependencies or execute in-package code.

The UI import only inspects; the user then explicitly clicks replay. The package preview is separate from current data and saved results; it does not auto-write to the repository or replace the current research.

#### 9.3 How replay decides a match

`replayResearchPackage()` checks the package again, calls the built-in `runEcolabResearchWorkflow()` to recompute, and compares simultaneously: **the scientific results projection and the complete analysis manifest**. Not just a few summary metrics; re-hashing a modified convergence conclusion or error list alone will not automatically pass the actual replay.

The default numeric comparison rule is:

```text
|a-b| ≤ 1e-10 + 1e-8 × max(|a|, |b|)
```

Object keys, types, array length/order, and other non-numeric values are still compared strictly. The scientific projection excludes `createdAt`, but the complete manifest still participates; the Methods text passes an integrity check and is not compared semantically against regenerated copy, so `matched` does not mean the whole package is byte-identical.

The cross-runtime patch only handles duplicate numeric text for closed warning templates that both sides strictly conform to in their structured fields: two strong-correlation warnings of known provenance, and the finite-high-condition-number warning. Only when templates match exactly is the duplicate `message` string comparison skipped; structured numeric, code/source/parameter, and other fields are still checked as usual; unknown templates, appended conclusions, or removed restriction wording are not exempted.

Therefore the distinctions are mandatory: **integrity passing ≠ provenance real; replayable ≠ replay matched; replay matched ≠ scientifically valid or parameters identified.** `replayable` only means it can be attempted; `matched` means the results agree under the specified comparison rules.

When importing a versioned example in the browser, use the `researchPackage` inside the [6.0.0 example JSON](./data/examples/ecolab-stage6-research-6.0.0.json), not the outer example wrapper; research packages exported by the browser itself can be imported directly.

Source: [strict checks, compatibility decisions, and replay comparison](./src/analysis/research-replay.js), [closed numeric warning templates](./src/analysis/replay-warning-equivalence.js).

### 10. Build tests and source reading order

#### 10.1 How the same source is published as Core and Web

The build scripts do not use a bundler to transpile; they copy native ES modules, registries, normalized data, and schemas along the publish boundaries, excluding tests and raw XLSX:

- `build-core.js` generates `dist/core/`, writing the package entry and the `./model` and `./analysis` subpaths, actually importing the check API.
- `build-web.js` generates `dist/web/`, keeping relative asset paths for the GitHub Pages subdirectory, checking entries and Workers, rejecting raw data and test files.
- `audit-release.js` checks versions, Markdown local links, release size budgets, strict example imports, and real replay, and generates a sorted SHA-256 file inventory.
- `check-reproducible-build.js` builds in two independent temporary directories, then compares every artifact path, byte count, and SHA-256; "reproducible build" and "results reproduce within tolerance" are two different contracts.

Public deployment runs `build:public`, using publicly obtainable materials for release tests and audits; the full `build` also includes local raw-data audits and the full test suite. GitHub Pages serves static files and runs no Node.js backend; Pages does not apply `_headers`, so the existence of the file does not mean the custom security header took effect.

Source: [Core build](./scripts/build-core.js), [Web build](./scripts/build-web.js), [release audit](./scripts/audit-release.js), [reproducible build](./scripts/check-reproducible-build.js), [Pages workflow](./.github/workflows/deploy-pages.yml).

#### 10.2 What the tests prove

The tests use Node.js built-in `node:test`, organized mainly by module boundary:

- [Scientific core tests](./src/tests/): units, registry, Regoes zero/limits, analytic advance composability, protocol boundaries, and detection limit.
- [Analysis tests](./src/analysis/tests/): objective functions, optimization budgets, sensitivity normalization/pairing, diagnostics, CV/bootstrap, package checks, and replay negative cases.
- [App tests](./src/app/tests/): project actions, state, task protocol/cancellation, storage conflicts, and recovery associations.
- [Release tests](./scripts/tests/): versions, build boundaries, frozen historical examples, release audits, and repeat builds.

`npm test` runs everything; `npm run test:release` runs the release subset; `npm run audit:release` checks existing build artifacts; `npm run check:reproducible` independently verifies repeat builds. Software tests cannot prove strain/culture-condition matching, experimental generalization, confidence coverage, or clinical validity; historical execution results and unfinished manual browser/accessibility/performance verification are in the [release checklist](./docs/release-checklist.md).

Suggested reading order for first-time readers:

1. [Parameter registry](./data/registry/parameter-sets.json) → [resolve.js](./src/registry/resolve.js): understand units, provenance, and the model snapshot.
2. [regoes-logistic-v1.js](./src/model/regoes-logistic-v1.js) → [simulate-piecewise.js](./src/model/simulate-piecewise.js): understand concentration to population trajectory.
3. [research-workflow.js](./src/analysis/research-workflow.js) → [growth-comparison.js](./src/analysis/growth-comparison.js) → [research-upgrade.js](./src/analysis/research-upgrade.js): distinguish latent model calibration, direct OD comparison, and the final combination.
4. [Research controller](./src/app/research/controller.js) → [TaskClient](./src/app/workers/task-client.js) → [persistence.js](./src/app/persistence.js): understand the browser lifecycle and saving.
5. [analysis-manifest.js](./src/analysis/analysis-manifest.js) → [research-replay.js](./src/analysis/research-replay.js): understand the difference between integrity checks and actual scientific replay.

## Documentation

- [Detailed update notes for this release](./docs/release-notes-6.0.0.md)
- [Project overview](./docs/project-overview.md)
- [System architecture](./docs/architecture.md)
- [Scientific core](./docs/scientific-core.md)
- [Learn / Sandbox](./docs/interactive-app.md)
- [Research Workspace](./docs/research-workspace.md)
- [Limitations](./docs/limitations.md)
- [Project introduction and real results](./docs/portfolio-case-study.md)
- [Equations, parameters, and paper evidence](./docs/research-method-evidence.md)
- [Deployment](./docs/deployment.md)
- [Maintenance, versions, and data updates](./docs/maintenance.md)
- [Release checklist](./docs/release-checklist.md)
- [Data candidate review](./docs/data-candidate-review.md)
- [Technical blueprints](./blueprints/README.md)

## License and data attribution

Ecolab's own code is released under the [MIT License](./LICENSE), copyright © 2026 Kengo Kubota. Third-party data, papers, and source materials in the repository are not relicensed by the code license; the built-in Figshare BW25113 data continues to follow the original `CC BY 4.0` license and the attribution and provenance requirements in its data card.

Versioned generated examples:

- [Current 6.0.0 Markdown](./data/examples/ecolab-stage6-research-6.0.0.md)
- [Current 6.0.0 JSON](./data/examples/ecolab-stage6-research-6.0.0.json)
- [Frozen historical 5.0.0 Markdown](./data/examples/ecolab-stage5-small-research-5.0.0.md)
- [Frozen historical 5.0.0 JSON](./data/examples/ecolab-stage5-small-research-5.0.0.json)

Research data parsing, analysis, and replay run in local Workers; teaching analytic simulation runs on the browser main thread; qualified data source text and research results are stored in IndexedDB. When initialization is unavailable, volatile memory is used, and runtime quota failures raise explicit errors. The research package contains data and full inputs but requires exactly matching built-in software — it is not a standalone executable. Old packages can be validated and viewed; replay is refused when full inputs are missing or versions are incompatible. Initial loading of static assets still requires access to the deployed site; user data is not uploaded to analysis servers.

## Further reading

More projects and articles are on my personal site: [keng0nion.github.io](https://keng0nion.github.io/).
