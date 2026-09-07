# Ecolab 6.0.0 development research example

Actual deterministic computation on bundled raw, unblanked BW25113 OD600 data. No preferred winner or direction of change is required to generate this artifact. Completion is not convergence, identification, precision, or validation success.

## Reproduce and inspect

```bash
npm run example:research
# Optional output destinations (space-separated or equals form):
node scripts/generate-example-research.js --json-out /tmp/ecolab-example.json --markdown-out /tmp/ecolab-example.md
```

The researchPackage is data-self-contained, not a standalone executable: it embeds exact source text, resolved inputs, settings and scientific output, but replay requires the declared exact built-in software. No imported code or network fetch is used. Extract researchPackage for package inspection/replay; the example wrapper is not itself a research-package schema document.

- Application: `6.0.0`; analysis: `2.0.0`; scientific core engine: `2.0.0`; teaching model: `1.0.0`.

- Stable analysis ID: `ecolab.stage4.analysis`; analysis implementation: `ecolab-research-analysis-v2`; workflow: `ecolab-research-development-v2`.

- Current Research Workspace preset: `small`; root seed: `123456789`. The fixed createdAt=`2026-09-07T12:00:00.000Z` is reproducibility metadata, not the wall-clock execution time.

- Scientific result: `scientific-result`; canonical SHA-256: `6c4657779363edb4d9d3cbe33c15520378eb5a62469f9caff7b52da54cafb84e`.

- Software dependency: `ecolab-research-analysis-v2@2.0.0` (exact). Built-in analysis implementation containing this development-only workflow and direct-OD comparison.

- Software dependency: `regoes-logistic-piecewise-analytic-v1@1.0.0` (exact). Built-in model implementation for the embedded resolved snapshot; no registry resolution.

## Source, roles and integrity

Aida, Honoka; Ying, Bei-Wen (2025). Bacterial growth profiles across one-thousand chemical-defined media. figshare. Dataset. https://doi.org/10.6084/m9.figshare.28342064.v1

- Data license: `CC-BY-4.0`.

- Dataset: `figshare-bw25113-growth-v1@1.0.0`; 528 observations (352 training, 176 previously viewed development).

- Original source role `validation` is labeled `development_comparison` in this revision: not untouched or external validation. The original data and source labels are not rewritten.

- Bundled normalized JSON artifact byte SHA-256: `67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817`.

- Normalized canonical dataset fingerprint: `2c30ce8d5dcf43c35aeafff0b495da0e012aef6d6ed3c021acab69eaf2dfbbcc`.

- Checksums document byte SHA-256: `cc9f1e54fb90805dcf36718d7cd9aef207ad2fd26008d44614b9da9747aacbae`.

Original workbook hashes are provenance declarations copied from checksums.json, not recomputed by this generator. Original XLSX bytes are not embedded or needed for replay of the normalized input.

- Original workbook provenance: `data/raw/figshare-bw25113-growth-v1/BW25113_Growth_Round01.xlsx`, SHA-256 `d81c738fdf7885195203de9b8b28bc221cf81992dffe1288c42b81aa6876d921`.

- Original workbook provenance: `data/raw/figshare-bw25113-growth-v1/BW25113_Medium composition.xlsx`, SHA-256 `e3d82236c0f9a65cff55bebf1d5478b15a0972111422c32a3395deb5c5509cdd`.

- Original workbook provenance: `data/raw/figshare-bw25113-growth-v1/BW25113_GrowthDataEvaluation.xlsx`, SHA-256 `2ae299c04f6a4de7401d3896413030db050b28691764be7940da471f351e03b1`.

## Training-only cross-validation and frozen selection

CV source role=`training`; unit=`whole_trajectory`; metric=`macroRmse`. Arithmetic mean of out-of-fold per-trajectory RMSEs, not an unweighted mean of fold scores.

- training_mean: score=`0.0038482670745189043`; eligible=`true`; folds=`8`; converged folds=`8`.

- logistic: score=`0.014889438648207414`; eligible=`true`; folds=`8`; converged folds=`0`.

- gompertz: score=`0.017664751867487005`; eligible=`true`; folds=`8`; converged folds=`0`.

Selected model=`training_mean`; selected score=`0.0038482670745189043`; frozenBeforeDevelopment=`true`. Within absolute tolerance of the global minimum, prefer training_mean, then logistic, then gompertz.

## Previously viewed development comparison

- Frozen selected OD candidate: macroRmse=`0.003047562725247655`; pooledRmse=`0.0031805851912959228`; mae=`0.002392045454545456`.

- Exact-time training-mean baseline: macroRmse=`0.003047562725247655`; pooledRmse=`0.0031805851912959228`; mae=`0.002392045454545456`.

- Selected minus baseline macro RMSE: `0`.

- Legacy latent-model OD calibration: macroRmse=`0.008333855238427267`; pooledRmse=`0.008344901370085705`; mae=`0.006275964812029507`.

- Legacy predeclared baseline: macroRmse=`0.003047562725247655`; pooledRmse=`0.0031805851912959228`; mae=`0.002392045454545456`.

- Legacy model minus baseline: {"macroRmse":0.005286292513179611,"pooledRmse":0.005164316178789782,"mae":0.003883919357484051,"meanResidual":5.285485590866834e-18,"medianAbsoluteError":0.0021338946120245186}.

Deltas are reported with their actual signs, not interpreted as untouched validation or a required model victory. OD600 is not CFU/mL. No antibiotic, clinical, resistance-evolution or combination-therapy inference is supported.

## Paired training-trajectory bootstrap

- Requested=`20`; successful=`20`; failures=`0`; resampling unit=`whole_training_trajectory`; paired=`true`.

- Independence assumption=`unverified`; jointSamplesRetained=`true`. Joint samples, refit parameters, optimizer diagnostics and failures are retained in the scientific result.

Intervals are conditional and exploratory, not established coverage or independent parameter marginals for sensitivity analysis.

```json
{
  "kind": "exploratory_conditional_percentile_intervals",
  "status": "available",
  "level": 0.95,
  "quantileMethod": "R7",
  "successfulSampleCount": 20,
  "expectedTailSamples": 0.5000000000000004,
  "minimumExpectedTailSamples": 5,
  "tailResolutionAdequate": false,
  "precisionAssessed": false,
  "conditioning": "Frozen selected model, explicit bounds, observed training trajectories, and converged finite refits only; resampling assumes exchangeable trajectories but their independence is unverified.",
  "includesModelSelectionUncertainty": false,
  "includesObservationNoise": false,
  "parameterIndependenceAssumed": false,
  "predictionInterpretation": "Pointwise fitted-mean OD curve intervals on training times; not simultaneous bands or new-observation prediction intervals.",
  "parameters": {},
  "predictions": [
    {
      "timeHours": 0.5,
      "lower": 0.081434375,
      "median": 0.08206250000000001,
      "upper": 0.082690625
    },
    {
      "timeHours": 1,
      "lower": 0.081434375,
      "median": 0.0821875,
      "upper": 0.08294062499999999
    },
    {
      "timeHours": 1.5,
      "lower": 0.081375,
      "median": 0.0819375,
      "upper": 0.08275625
    },
    {
      "timeHours": 2,
      "lower": 0.081375,
      "median": 0.0819375,
      "upper": 0.08275625
    },
    {
      "timeHours": 2.5,
      "lower": 0.081434375,
      "median": 0.0821875,
      "upper": 0.08294062499999999
    },
    {
      "timeHours": 3,
      "lower": 0.08125,
      "median": 0.08206250000000001,
      "upper": 0.08288124999999999
    },
    {
      "timeHours": 3.5,
      "lower": 0.081434375,
      "median": 0.0821875,
      "upper": 0.08294062499999999
    },
    {
      "timeHours": 4,
      "lower": 0.081375,
      "median": 0.0819375,
      "upper": 0.08275625
    },
    {
      "timeHours": 4.5,
      "lower": 0.081434375,
      "median": 0.0821875,
      "upper": 0.08294062499999999
    },
    {
      "timeHours": 5,
      "lower": 0.082,
      "median": 0.0825,
      "upper": 0.08312499999999999
    },
    {
      "timeHours": 5.5,
      "lower": 0.082434375,
      "median": 0.0831875,
      "upper": 0.08394062499999999
    },
    {
      "timeHours": 6,
      "lower": 0.08343437499999999,
      "median": 0.0841875,
      "upper": 0.08494062499999998
    },
    {
      "timeHours": 6.5,
      "lower": 0.08574999999999998,
      "median": 0.08631249999999999,
      "upper": 0.08700624999999998
    },
    {
      "timeHours": 7,
      "lower": 0.08987499999999998,
      "median": 0.09031249999999999,
      "upper": 0.09119687499999998
    },
    {
      "timeHours": 7.5,
      "lower": 0.09662499999999999,
      "median": 0.09712499999999999,
      "upper": 0.09788124999999999
    },
    {
      "timeHours": 8,
      "lower": 0.1092375,
      "median": 0.11031250000000001,
      "upper": 0.11125625
    },
    {
      "timeHours": 8.5,
      "lower": 0.12602812500000002,
      "median": 0.12787500000000002,
      "upper": 0.13014375
    },
    {
      "timeHours": 9,
      "lower": 0.1419875,
      "median": 0.1429375,
      "upper": 0.144190625
    },
    {
      "timeHours": 9.5,
      "lower": 0.15936875,
      "median": 0.16025,
      "upper": 0.161190625
    },
    {
      "timeHours": 10,
      "lower": 0.18318437499999998,
      "median": 0.18424999999999997,
      "upper": 0.18519687499999998
    },
    {
      "timeHours": 10.5,
      "lower": 0.210434375,
      "median": 0.2116875,
      "upper": 0.21339375
    },
    {
      "timeHours": 11,
      "lower": 0.22318437500000002,
      "median": 0.22506250000000003,
      "upper": 0.22669062500000003
    },
    {
      "timeHours": 11.5,
      "lower": 0.249,
      "median": 0.2515625,
      "upper": 0.253190625
    },
    {
      "timeHours": 12,
      "lower": 0.288309375,
      "median": 0.2910625,
      "upper": 0.29334062499999997
    },
    {
      "timeHours": 12.5,
      "lower": 0.310309375,
      "median": 0.3125,
      "upper": 0.31476875000000004
    },
    {
      "timeHours": 13,
      "lower": 0.32961875,
      "median": 0.33125000000000004,
      "upper": 0.333275
    },
    {
      "timeHours": 13.5,
      "lower": 0.33310625,
      "median": 0.3343125,
      "upper": 0.337203125
    },
    {
      "timeHours": 14,
      "lower": 0.33230312500000003,
      "median": 0.3335,
      "upper": 0.33639375
    },
    {
      "timeHours": 14.5,
      "lower": 0.330796875,
      "median": 0.332375,
      "upper": 0.33531562500000006
    },
    {
      "timeHours": 15,
      "lower": 0.32899375000000003,
      "median": 0.33087500000000003,
      "upper": 0.33406562500000003
    },
    {
      "timeHours": 15.5,
      "lower": 0.32767812500000004,
      "median": 0.32956250000000004,
      "upper": 0.33275625000000003
    },
    {
      "timeHours": 16,
      "lower": 0.32799375000000003,
      "median": 0.3296875,
      "upper": 0.332571875
    },
    {
      "timeHours": 16.5,
      "lower": 0.325790625,
      "median": 0.32799999999999996,
      "upper": 0.33138125
    },
    {
      "timeHours": 17,
      "lower": 0.32461249999999997,
      "median": 0.327125,
      "upper": 0.33044062500000004
    },
    {
      "timeHours": 17.5,
      "lower": 0.323921875,
      "median": 0.3256875,
      "upper": 0.32881562500000006
    },
    {
      "timeHours": 18,
      "lower": 0.3227375,
      "median": 0.3248125,
      "upper": 0.328065625
    },
    {
      "timeHours": 18.5,
      "lower": 0.321684375,
      "median": 0.323625,
      "upper": 0.326940625
    },
    {
      "timeHours": 19,
      "lower": 0.3211125,
      "median": 0.32337499999999997,
      "upper": 0.327065625
    },
    {
      "timeHours": 19.5,
      "lower": 0.32018437499999997,
      "median": 0.3223125,
      "upper": 0.325815625
    },
    {
      "timeHours": 20,
      "lower": 0.319625,
      "median": 0.32175,
      "upper": 0.32512500000000005
    },
    {
      "timeHours": 20.5,
      "lower": 0.31923749999999995,
      "median": 0.3213750000000001,
      "upper": 0.324815625
    },
    {
      "timeHours": 21,
      "lower": 0.317921875,
      "median": 0.31975,
      "upper": 0.3229
    },
    {
      "timeHours": 21.5,
      "lower": 0.31829687500000003,
      "median": 0.32025000000000003,
      "upper": 0.323565625
    },
    {
      "timeHours": 22,
      "lower": 0.31637499999999996,
      "median": 0.31881249999999994,
      "upper": 0.322334375
    }
  ]
}
```

## Sensitivity and identifiability

Morris and Sobol use declared independent engineering ranges, not independently mixed marginals of the joint growth bootstrap. Raw finite estimates, intervals and precision issues are retained without clipping or reordering.

### Morris

```json
{
  "effectScale": "output_per_unit_normalized_coordinate",
  "delta": 0.6666666666666666,
  "byParameter": {
    "psiMaxLog10PerHour": {
      "parameter": "psiMaxLog10PerHour",
      "transform": "identity",
      "outputs": {
        "predictedOdAt10Hours": {
          "count": 2,
          "mu": 0.10765103828168716,
          "muStar": 0.10765103828168716,
          "μ": 0.10765103828168716,
          "μ*": 0.10765103828168716,
          "sigma": 0.059968427394641706,
          "σ": 0.059968427394641706,
          "sigmaEstimable": true
        }
      },
      "count": 2,
      "mu": 0.10765103828168716,
      "muStar": 0.10765103828168716,
      "μ": 0.10765103828168716,
      "μ*": 0.10765103828168716,
      "sigma": 0.059968427394641706,
      "σ": 0.059968427394641706,
      "sigmaEstimable": true
    },
    "initialStates.pooled.log10PopulationDensity": {
      "parameter": "initialStates.pooled.log10PopulationDensity",
      "transform": "identity",
      "outputs": {
        "predictedOdAt10Hours": {
          "count": 2,
          "mu": 0.11151687725288119,
          "muStar": 0.11151687725288119,
          "μ": 0.11151687725288119,
          "μ*": 0.11151687725288119,
          "sigma": 0.1525358391895307,
          "σ": 0.1525358391895307,
          "sigmaEstimable": true
        }
      },
      "count": 2,
      "mu": 0.11151687725288119,
      "muStar": 0.11151687725288119,
      "μ": 0.11151687725288119,
      "μ*": 0.11151687725288119,
      "sigma": 0.1525358391895307,
      "σ": 0.1525358391895307,
      "sigmaEstimable": true
    }
  }
}
```

### Sobol–Jansen with paired-row bootstrap

```json
{
  "bootstrap": {
    "method": "paired_row_percentile",
    "resamplingUnit": "paired_rows_A_B_A_Bi",
    "quantileMethod": "R7",
    "seed": 3184534991,
    "replicates": 40,
    "confidenceLevel": 0.95,
    "precisionTolerance": 0.2,
    "minimumTailSamples": 5,
    "interpretation": "Monte Carlo sampling uncertainty conditional on independent input distributions and the evaluator; not model or data uncertainty. Percentile coverage is approximate."
  },
  "byParameter": {
    "initialStates.pooled.log10PopulationDensity": {
      "parameter": "initialStates.pooled.log10PopulationDensity",
      "outputs": {
        "predictedOdAt10Hours": {
          "firstOrder": 0.4590453019513989,
          "totalOrder": 0.07563513286313484,
          "first": 0.4590453019513989,
          "total": 0.07563513286313484,
          "S1": 0.4590453019513989,
          "ST": 0.07563513286313484,
          "firstOrderInterval": [
            -0.003886060762112016,
            0.7967139580997566
          ],
          "totalOrderInterval": [
            0.026802372056035733,
            0.2544622945671625
          ],
          "firstOrderStandardError": 0.22317640840170924,
          "totalOrderStandardError": 0.06968183367881704,
          "precision": {
            "assessed": true,
            "imprecise": true,
            "validReplicates": 40,
            "invalidReplicates": 0,
            "tailSampleCount": 1.0000000000000009,
            "intervalWidths": {
              "firstOrder": 0.8006000188618687,
              "totalOrder": 0.2276599225111268
            },
            "tolerance": 0.2,
            "issues": [
              "LOW_BOOTSTRAP_TAIL_COUNT",
              "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
              "WIDE_BOOTSTRAP_INTERVAL"
            ]
          }
        }
      },
      "firstOrder": 0.4590453019513989,
      "totalOrder": 0.07563513286313484,
      "first": 0.4590453019513989,
      "total": 0.07563513286313484,
      "S1": 0.4590453019513989,
      "ST": 0.07563513286313484,
      "firstOrderInterval": [
        -0.003886060762112016,
        0.7967139580997566
      ],
      "totalOrderInterval": [
        0.026802372056035733,
        0.2544622945671625
      ],
      "firstOrderStandardError": 0.22317640840170924,
      "totalOrderStandardError": 0.06968183367881704,
      "precision": {
        "assessed": true,
        "imprecise": true,
        "validReplicates": 40,
        "invalidReplicates": 0,
        "tailSampleCount": 1.0000000000000009,
        "intervalWidths": {
          "firstOrder": 0.8006000188618687,
          "totalOrder": 0.2276599225111268
        },
        "tolerance": 0.2,
        "issues": [
          "LOW_BOOTSTRAP_TAIL_COUNT",
          "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
          "WIDE_BOOTSTRAP_INTERVAL"
        ]
      }
    },
    "psiMaxLog10PerHour": {
      "parameter": "psiMaxLog10PerHour",
      "outputs": {
        "predictedOdAt10Hours": {
          "firstOrder": 0.9017016648896881,
          "totalOrder": 0.4417230674421621,
          "first": 0.9017016648896881,
          "total": 0.4417230674421621,
          "S1": 0.9017016648896881,
          "ST": 0.4417230674421621,
          "firstOrderInterval": [
            0.7199217910353869,
            0.968749179296953
          ],
          "totalOrderInterval": [
            0.1970655289276893,
            0.8725470045625012
          ],
          "firstOrderStandardError": 0.0712688503720911,
          "totalOrderStandardError": 0.1840868864750632,
          "precision": {
            "assessed": true,
            "imprecise": true,
            "validReplicates": 40,
            "invalidReplicates": 0,
            "tailSampleCount": 1.0000000000000009,
            "intervalWidths": {
              "firstOrder": 0.24882738826156614,
              "totalOrder": 0.675481475634812
            },
            "tolerance": 0.2,
            "issues": [
              "LOW_BOOTSTRAP_TAIL_COUNT",
              "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
              "WIDE_BOOTSTRAP_INTERVAL"
            ]
          }
        }
      },
      "firstOrder": 0.9017016648896881,
      "totalOrder": 0.4417230674421621,
      "first": 0.9017016648896881,
      "total": 0.4417230674421621,
      "S1": 0.9017016648896881,
      "ST": 0.4417230674421621,
      "firstOrderInterval": [
        0.7199217910353869,
        0.968749179296953
      ],
      "totalOrderInterval": [
        0.1970655289276893,
        0.8725470045625012
      ],
      "firstOrderStandardError": 0.0712688503720911,
      "totalOrderStandardError": 0.1840868864750632,
      "precision": {
        "assessed": true,
        "imprecise": true,
        "validReplicates": 40,
        "invalidReplicates": 0,
        "tailSampleCount": 1.0000000000000009,
        "intervalWidths": {
          "firstOrder": 0.24882738826156614,
          "totalOrder": 0.675481475634812
        },
        "tolerance": 0.2,
        "issues": [
          "LOW_BOOTSTRAP_TAIL_COUNT",
          "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
          "WIDE_BOOTSTRAP_INTERVAL"
        ]
      }
    }
  }
}
```

Objective slices hold other biological parameters fixed and reoptimize OD nuisance parameters; they are not profile-likelihood confidence limits. Full slices and covariance/rank diagnostics are retained in the scientific result.

## Completion, convergence, identification and precision

- completed=`true`.

- converged=`false`.

- identified=`false`.

- precisionAssessed=`false`.

```json
{
  "completed": true,
  "converged": false,
  "identified": false,
  "precisionAssessed": false,
  "validationEvidence": "previously_viewed_development_only",
  "untouched": false,
  "eligibleForL4": false,
  "convergence": {
    "legacyTraining": false,
    "growthTrainingAndCrossValidationFits": false,
    "growthBootstrapFailureCount": 0,
    "criterion": "All reported best training/CV fits must be finite and converged, with no failed requested bootstrap refits; individual stage diagnostics remain authoritative. This is not proof of a global optimum."
  },
  "identification": {
    "status": "not_established",
    "legacyLocalFullRank": true,
    "covarianceStatus": "unscaled_local_geometry",
    "calibratedParameterUncertainty": false,
    "growthIdentifiabilityAssessed": false,
    "interpretation": "Local geometry and conditional curve resampling do not establish full parameter identification; absolute CFU scale is not identified by raw OD600 and growth structural/practical identifiability is not assessed here."
  },
  "precision": {
    "sobolAssessed": true,
    "sobolImprecise": true,
    "sobol": [
      {
        "parameter": "initialStates.pooled.log10PopulationDensity",
        "output": "predictedOdAt10Hours",
        "assessed": true,
        "imprecise": true,
        "validReplicates": 40,
        "invalidReplicates": 0,
        "tailSampleCount": 1.0000000000000009,
        "intervalWidths": {
          "firstOrder": 0.8006000188618687,
          "totalOrder": 0.2276599225111268
        },
        "tolerance": 0.2,
        "issues": [
          "LOW_BOOTSTRAP_TAIL_COUNT",
          "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
          "WIDE_BOOTSTRAP_INTERVAL"
        ]
      },
      {
        "parameter": "psiMaxLog10PerHour",
        "output": "predictedOdAt10Hours",
        "assessed": true,
        "imprecise": true,
        "validReplicates": 40,
        "invalidReplicates": 0,
        "tailSampleCount": 1.0000000000000009,
        "intervalWidths": {
          "firstOrder": 0.24882738826156614,
          "totalOrder": 0.675481475634812
        },
        "tolerance": 0.2,
        "issues": [
          "LOW_BOOTSTRAP_TAIL_COUNT",
          "FIRST_ORDER_EXCEEDS_TOTAL_ORDER",
          "WIDE_BOOTSTRAP_INTERVAL"
        ]
      }
    ],
    "growthBootstrapAssessed": false,
    "growthBootstrapTailResolutionAdequate": false,
    "interpretation": "Sobol precision concerns Monte Carlo sampling under declared independent engineering ranges only. Growth percentile intervals are conditional and exploratory; tail resolution alone does not establish precision or coverage."
  }
}
```

- Legacy training converged=`false`; all optimizer restart/stage termination diagnostics are retained.

- training_mean training: finite=`true`; converged=`true`.

- logistic training: finite=`true`; converged=`false`.

- gompertz training: finite=`true`; converged=`false`.

- Capability level=`L3`; heldOutValidationEligibleForL4=`false`. Previously viewed development data is not L4 validation evidence.

## Exact computation settings and RNG substreams

```json
{
  "applicationVersion": "6.0.0",
  "computationSettings": {
    "differentialEvolution": {
      "crossoverRate": 0.9,
      "mutationFactor": 0.8,
      "objectiveTolerance": 1e-10,
      "tolerance": 1e-7
    },
    "growthComparison": {
      "crossValidationMetric": "macroRmse",
      "developmentRole": "validation",
      "implementationId": "direct-od-growth-comparison-v1",
      "independentParameterMarginalsForSensitivity": false,
      "intervalRefits": "finite_converged_only",
      "minimumExpectedTailSamples": 5,
      "objective": "mean_trajectory_mse_od600",
      "optimizerConstants": {
        "crossoverRate": 0.9,
        "initialStep": 0.05,
        "mutationFactor": 0.8
      },
      "quantileMethod": "R7",
      "resamplingUnit": "whole_training_trajectory",
      "seedDerivation": "deriveSeed(root, direct-od-growth-comparison-v1, phase, model, index); restart and stage substreams",
      "tieOrder": [
        "training_mean",
        "logistic",
        "gompertz"
      ]
    },
    "identifiability": {
      "boundaryTolerance": 0.01,
      "conditionWarning": 1000000,
      "correlationWarning": 0.95,
      "nearOptimumAbsoluteTolerance": 1e-8,
      "nearOptimumParameterSeparation": 0.001,
      "nearOptimumRelativeTolerance": 0.0001,
      "objectiveSlices": {
        "flatRelativeTolerance": 0.0001,
        "maxParameters": 2,
        "points": 3
      },
      "rankTolerance": 1e-8,
      "relativeStep": 0.0001
    },
    "localSensitivity": {
      "roundoffRelativeStep": 1.4901161193847656e-8,
      "scheme": "auto",
      "spanRelativeStep": 0.00001,
      "stepRule": "min(span, max(span * spanRelativeStep, roundoffRelativeStep * max(1, abs(transformedCenter))))"
    },
    "monteCarlo": {
      "propagateObservationError": false,
      "quantileProbabilities": [
        0.025,
        0.5,
        0.975
      ]
    },
    "morris": {
      "delta": 0.6666666666666666
    },
    "nelderMead": {
      "initialStep": 0.05,
      "objectiveTolerance": 1e-12,
      "tolerance": 1e-8
    },
    "observationLayer": {
      "minimumScaleOd": 1e-12,
      "profilingRole": "training"
    },
    "scalarOutputTimeHours": 10,
    "sobol": {
      "independentInputs": true,
      "minimumTailSamples": 5,
      "quantileMethod": "R7"
    },
    "training": {
      "bounds": {
        "initialStates.pooled.log10PopulationDensity": [
          3,
          8.5
        ],
        "psiMaxLog10PerHour": [
          0.05,
          0.8
        ]
      },
      "drugIds": [],
      "initialParameters": {
        "initialStates.pooled.log10PopulationDensity": 5.75,
        "psiMaxLog10PerHour": 0.4300428509485446
      },
      "initialStateSeriesIds": [
        "pooled"
      ],
      "method": "least_squares",
      "parameterPolicy": "scientific",
      "parameterWhitelist": [
        "psiMaxLog10PerHour",
        "initialStates.pooled.log10PopulationDensity"
      ]
    }
  },
  "contentHash": "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817",
  "createdAt": "2026-09-07T12:00:00.000Z",
  "datasetFormat": "json",
  "datasetVersion": "1.0.0",
  "developmentComparison": true,
  "growthComparison": {
    "bootstrap": {
      "intervalLevel": 0.95,
      "samples": 20
    },
    "bounds": {
      "amplitudeOd": [
        0.001,
        1
      ],
      "baselineOd": [
        0,
        0.3
      ],
      "ratePerHour": [
        0.001,
        4
      ],
      "timingHours": [
        0,
        30
      ]
    },
    "crossValidation": {
      "folds": [
        [
          "Curve00025|Round01_0025"
        ],
        [
          "Curve00026|Round01_0026"
        ],
        [
          "Curve00027|Round01_0027"
        ],
        [
          "Curve00028|Round01_0028"
        ],
        [
          "Curve00029|Round01_0029"
        ],
        [
          "Curve00030|Round01_0030"
        ],
        [
          "Curve00031|Round01_0031"
        ],
        [
          "Curve00032|Round01_0032"
        ]
      ],
      "tieTolerance": 1e-10
    },
    "optimizer": {
      "differentialEvolutionMaxEvaluations": 120,
      "nelderMeadMaxEvaluations": 80,
      "objectiveTolerance": 1e-12,
      "populationSize": 8,
      "restarts": 1,
      "tolerance": 1e-7
    }
  },
  "identifiabilityProfilePoints": 3,
  "includeMonteCarloSamples": false,
  "monteCarloSamples": 8,
  "morrisLevels": 4,
  "morrisTrajectories": 2,
  "optimizer": {
    "differentialEvolutionMaxEvaluations": 80,
    "nelderMeadMaxEvaluations": 80,
    "populationSize": 8,
    "restarts": 1
  },
  "packageId": "ecolab-stage6-research-6.0.0-research-package",
  "planId": "figshare-bw25113-growth-v1-development-plan-v2",
  "returnedMonteCarloSamples": 8,
  "runId": "ecolab-stage6-research-6.0.0",
  "scalarOutputTimeHours": 10,
  "scanPointsPerAxis": 3,
  "seed": 123456789,
  "seeds": {
    "analysis": 123456789,
    "growthComparison": 574448951,
    "monteCarlo": 2757129103,
    "morris": 3164847285,
    "optimizer": 2171745068,
    "sobol": 411805874,
    "sobolBootstrap": 3184534991
  },
  "sobolBootstrapReplicates": 40,
  "sobolBootstrapSeed": 3184534991,
  "sobolConfidenceLevel": 0.95,
  "sobolPrecisionTolerance": 0.2,
  "sobolSamples": 8,
  "uncertaintyRangeFraction": 0.1
}
```

The omitted source text and resolved model above are fully embedded in research-replay-input, not external dependencies. The teaching model and dataset versions are separate from the application and analysis versions.

## Warnings

- `OD600_NOT_CFU`: OD600 is an optical-density measurement and is not CFU/mL; no numeric equivalence with CFU/mL is claimed.

- `RAW_OD_ABSOLUTE_SCALE_NOT_IDENTIFIED`: Raw OD600 does not identify an absolute CFU scale or the carrying capacity.

- `CARRYING_CAPACITY_FIXED`: Carrying capacity is fixed from the resolved model and is not estimated from raw OD600.

- `OD_OBSERVATION_NUISANCE_PARAMETERS`: baselineOd and scaleOd are observation-layer nuisance parameters; they map latent N/K to OD600 and do not alter source measurements.

- `NO_TREATMENT_INFERENCE`: The protocol is constant no-drug exposure and no treatment or antibiotic parameter is inferred.

- `EXPLORATORY_PARAMETER_INTERVALS`: Monte Carlo triangular ranges are exploratory parameter-uncertainty simulation inputs, not confidence intervals.

- `INDEPENDENT_UNIT_DOCUMENTATION_INCOMPLETE`: Previously viewed development curves are not untouched validation; source plate/well independence is incompletely documented and this evidence is not eligible for L4.

- `SOURCE_AND_NORMALIZED_HASHES_DISTINCT`: The normalized JSON artifact byte hash and normalized canonical dataset fingerprint are recorded separately; original workbook hashes are separate provenance records.

- `UNSCALED_INFORMATION_NOT_PARAMETER_UNCERTAINTY`: Inverse normalized information is unscaled local geometry, not calibrated parameter uncertainty.

- `OBJECTIVE_SLICES_NOT_PROFILE_LIKELIHOOD`: Objective slices hold other supplied parameters fixed. Neither their endpoints nor their minima define likelihood confidence limits.

- `STRONG_PARAMETER_CORRELATION`: psiMaxLog10PerHour and initialStates.pooled.log10PopulationDensity have strong inverse-information geometry correlation -0.9936582411628538; this is not calibrated parameter uncertainty.

- `OD600_NOT_CFU`: Both curves are empirical direct OD600 models; no CFU conversion or physiological lag/population-rate interpretation.

- `DEVELOPMENT_ALREADY_VIEWED`: Development curves were previously viewed and are not untouched or external validation evidence.

- `TRAJECTORY_INDEPENDENCE_UNVERIFIED`: Complete-trajectory resampling preserves within-trajectory pairing; between-trajectory independence and exchangeability remain unverified.

- `EXPLORATORY_CONDITIONAL_INTERVALS`: Bootstrap intervals condition on a selected model, bounds, training data and successful refits; precision, coverage and identification are not established. Do not mix marginal samples into independent-input sensitivity analyses.

- `LOW_OPTIMIZER_BUDGET`: Reduced optimizer budget; completion does not establish convergence or a global optimum.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `OPTIMIZER_NOT_CONVERGED`: A bounded fit did not converge; its finite estimate remains provisional.

- `OPTIMIZER_STAGE_NOT_CONVERGED`: At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.

- `LOW_BOOTSTRAP_SAMPLE_COUNT`: Fewer than 200 requested resamples; interval precision is not established (zero disables resampling).

- `BOOTSTRAP_TAILS_UNRESOLVED`: Fewer than five expected successful samples per percentile tail; interval endpoints are poorly resolved. Passing this heuristic would still not establish precision or coverage.

- `LEGACY_OPTIMIZER_NOT_CONVERGED`: The legacy training fit exhausted its bounded search without establishing convergence; completion is not numerical success.

- `LEGACY_OPTIMIZER_STAGE_NOT_CONVERGED`: At least one legacy optimizer stage did not converge; all bounded-stage termination diagnostics are retained.

- `LOW_LEGACY_OPTIMIZER_BUDGET`: The legacy calibration uses a reduced engineering computation budget; a finite fit does not establish convergence or a global optimum.

- `SOBOL_IMPRECISE`: Sobol paired-row bootstrap precision is insufficient or unassessed; raw estimates and their issues are retained, not clipped or reordered.

- `SOBOL_IMPRECISE`: Sobol paired-row bootstrap precision is insufficient or unassessed; raw estimates and their issues are retained, not clipped or reordered.

- `GROWTH_BOUNDS_PREDECLARED`: Direct-OD bounds are explicit engineering constraints, not inferred from development values or claimed as physiological confidence ranges.

- `SENSITIVITY_NOT_BOOTSTRAP_MARGINALS`: Legacy sensitivity uses separately declared independent exploratory biological-parameter ranges, never marginal distributions of joint growth-bootstrap samples. Trajectory independence remains unverified.

## Frozen historical artifacts

These Stage 5 files remain byte-for-byte historical records, not current-method outputs or new validation evidence. This command never regenerates them, even when passed their paths explicitly.

- `data/examples/ecolab-stage5-small-research-5.0.0.json`; SHA-256 `f3365e5c616597c042aa87eb76040b620955f4ea9e8865c77b83e5245acc41b8`.

- `data/examples/ecolab-stage5-small-research-5.0.0.md`; SHA-256 `05ca4c25a2327f81119ee7af609d2536c1ec7072f35a4532f32319406f416bbd`.

The unmodified research package, actual scientific fields and replay inputs are in [the companion JSON](ecolab-stage6-research-6.0.0.json).
