# Portfolio case study / 作品集案例

## 中文摘要

### 问题

一个模型即使在训练数据上拟合良好，也可能在留出数据上不如简单基线。Ecolab 的作品集案例不隐藏这个风险，而是把数据来源、拟合、锁定、基线、能力等级和失败边界放进同一个可复现 artifact。

### 方法

版本化脚本运行内置 Figshare BW25113 原始 OD600 数据和 Research Workspace 的 `small` preset：

```bash
npm run example:research
```

固定条件：

- 应用 `5.0.0`；科学核心 `2.0.0`；分析引擎 `1.0.0`；
- 数据集 `figshare-bw25113-growth-v1@1.0.0`；
- 528 个观测：352 个训练、176 个验证；
- 8 条完整训练轨迹、4 条完整留出轨迹；
- 随机种子 `123456789`；
- 训练拟合 `psiMaxLog10PerHour` 和 pooled 初始状态；
- 训练数据剖面化 `baselineOd` 与 `scaleOd`；
- 验证前锁定所有参数，验证中不运行优化器或重新剖面化观测层。

### 实际结果

拟合值：

| 参数 | 值 |
| --- | ---: |
| `psiMaxLog10PerHour` | 0.42304736869534154 |
| `initialStates.pooled.log10PopulationDensity` | 4.619773667214655 |
| `baselineOd` | 0.08273059044421754 |
| `scaleOd` | 0.24634216504605064 |

锁定验证：

| 指标 | 模型 | 预声明训练均值基线 | 模型减基线 |
| --- | ---: | ---: | ---: |
| Macro RMSE | 0.008333855238427267 | 0.003047562725247655 | 0.005286292513179611 |
| Pooled RMSE | 0.008344901370085705 | 0.0031805851912959228 | 0.005164316178789782 |
| MAE | 0.006275964812029507 | 0.002392045454545456 | 0.003883919357484051 |

模型在 macro 与 pooled RMSE 上都差于预声明基线。这是案例的核心结论之一，而不是需要隐藏的失败。

### 能力结论

- **L3：通过。** 完成真实数据拟合、残差/可识别性诊断、固定种子不确定性和敏感性分析。
- **锁定留出程序：完成。** 无训练/验证完整轨迹泄漏；验证只调用一次预测；参数未改变。
- **L4：不合格。** `independentUnitsDocumented=false` 且 `heldOutValidationEligibleForL4=false`，因为源孔/板独立性记录不充分。
- **抗生素推断：没有。** 数据为未处理 OD600，不能用于药效参数验证。

机器可读和精简 Markdown artifact：

- [JSON artifact](../data/examples/ecolab-stage5-small-research-5.0.0.json)
- [Generated Markdown artifact](../data/examples/ecolab-stage5-small-research-5.0.0.md)

## English summary

### Question

A model may fit training data yet underperform a simple baseline on held-out data. This case study keeps provenance, fitting, locking, baseline comparison, capability assessment, and failure boundaries in one reproducible artifact instead of hiding the negative result.

### Method and result

`npm run example:research` runs the bundled raw OD600 dataset with the deterministic `small` preset and seed `123456789`. It fits two predeclared biological parameters, profiles two OD observation-layer nuisance parameters on training data, locks them, and evaluates four complete held-out trajectories without optimization or nuisance re-profiling.

The model's macro RMSE is `0.008333855238427267`, compared with `0.003047562725247655` for the predeclared training-mean baseline. Pooled RMSE is `0.008344901370085705`, compared with `0.0031805851912959228`. The model is therefore worse than the baseline on both measures.

The run demonstrates **L3 data calibration**. It does not qualify for L4 evidence because source well/plate independence is incompletely documented. The untreated OD600 data do not support antibiotic-effect inference. The generated [JSON](../data/examples/ecolab-stage5-small-research-5.0.0.json) and [Markdown](../data/examples/ecolab-stage5-small-research-5.0.0.md) preserve parameters, metrics, warnings, compute settings, versions, hashes, and the reproduction command.
