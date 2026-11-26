# Kill workflow v6 output and analysis contract

`schemas/kill-workflow-result.schema.json` records the workflow result shape. The fit result keeps three separate concepts:

- `converged`: optimizer termination outcome.
- `boundaryDiagnostics`: whether a point/interval/bootstrap mass reaches an allowed boundary.
- `profileLikelihoodDiagnostics[*].identifiability`: `identified`, `lower-unidentified`, or `upper-unidentified`, assigned from monotonicity of converged profile-likelihood values over the full allowed interval (0.05 NLL tolerance). A finite one-sided 95% profile crossing is reported where present.

A lower-unidentified `psiMin` is not a finite point estimate. `fittedParameters.psiMinLog10PerHour` is null; `parameterEstimates` carries the `≤` support statement. The optimizer limit may appear only in `predictionParameters` as an explicitly labeled value required to reproduce the optimizer's predicted curve. It must not be quoted as the biological estimate.

Bootstrap reports `optimizerConvergedReplicates`, `convergedAndIdentifiableReplicates`, `boundaryReplicates` and `boundaryReplicateFraction`. Confidence intervals use the requested number of optimizer-converged samples with all parameters strictly inside bounds. The count is an operational interior-sample rule; profile-based identifiability of the fitted data is separately shown and is not inferred solely from an interior bootstrap sample.

Cross-group comparison is restricted to per-group held-out RMSE and MAE. The censored Gaussian objective can be negative and is fit-specific, so it is not a cross-group score.

## Per-concentration-group growth-rate identifiability

`unitGrowthRateIdentifiability` answers a different question from the strain-level profiles: can one concentration group, on its own, pin down the net growth rate it was run at? The strain-level fit shares `psiMax`, `psiMin`, `zMIC` and `kappa` across all of a strain's groups, so it can be well identified while an individual group carries no rate information.

The diagnostic profiles `psi(C)` for each independent unit over `[-5, 2]` log10-fold/h in 0.1 steps, conditional on the strain-level `N0` and residual `sigma`. This shares the declared `psiMin` lower bound of −5. It uses the same censored Gaussian likelihood, the same monotonicity rule and the same 0.05 NLL tolerance as the strain-level profiles. No refit is involved: `psi(C)` is the only free quantity.

Two readings are computed and both are retained:

- `declaredCensoringStatus`: the data exactly as recorded.
- `exactAtLimitCensoredStatus`: values recorded as exact but equal to the unit's detection limit are treated as left-censored, because such a value cannot be distinguished from a censored observation.

`status` is the conservative combination — non-identified in either reading is non-identified. `basis` records which structure produced the verdict:

| `basis` | Meaning |
| --- | --- |
| `profile_interior_minimum` | Interior profile minimum with both tails above the 95% cutoff. |
| `profile_without_interior_minimum` | The profile never turns over inside the allowed interval. |
| `all_post_baseline_observations_at_detection_limit` | Every post-baseline observation is left-censored or sits on the limit. The likelihood is flat for any faster kill, so `psi(C)` has an upper bound only. |
| `exact_observation_at_detection_limit` | The declared reading identifies the rate but the at-limit reading does not. |

A non-identified group reports `unitProfileEstimateLog10PerHour: null`, `relation: "≤"` and `oneSided95Bound`; the model-implied `modelNetGrowthRateLog10PerHour` stays available because the fitted curve still needs it. `compatibleRange95` is the union of the two readings, so a model value is only called incompatible when neither reading accommodates it; `modelWithinUnitSupport95` flags exactly that case — a group-level lack-of-fit signal that makes derived parameter tables internally inconsistent.

Group-level verdicts do not replace the strain-level parameter profiles, and a group-level `identified` verdict does not prove that `psiMax` itself is identified from that group.

`fitAllRolesForOracle: true` is an analysis-only option. It fits both declared roles and returns `oracleMetrics` with `fitDataScope: all_roles_oracle_in_sample`; those values are in-sample model-form diagnostics, not external validation results.

## 6.1 fitting-status additions

Every strain requires at least seven exact training observations for the six free model parameters. A strain below that threshold returns `NOT_IDENTIFIABLE` with null parameter estimates. Eligible fits report optimizer convergence, every parameter at a boundary, σ lower-bound status, and profile-likelihood assessment independently. `psiMin` uses the common lower bound −5 log10/h; if its profile is open at that bound, the point estimate is withheld while the boundary value may be retained in `predictionParameters` solely to reproduce the fitted curve. Failed or unrun profiles are `NOT_ASSESSED`.
