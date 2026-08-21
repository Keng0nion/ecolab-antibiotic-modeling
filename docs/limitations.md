# Limitations and claim boundaries / 局限性与声明边界

## 中文

### 当前可以支持的声明

- Learn / Sandbox 可用于教学、模型探索和可复现的 L1 演示。
- Research Workspace 可执行真实数据质量检查、训练拟合、诊断、不确定性、敏感性和锁定留出评价。
- 版本化作品集案例证明当前内置运行达到 L3 数据校准。
- 软件测试证明实现符合已声明的数学、数据和发布契约。

### 当前不能支持的声明

- 不能用于临床决策、患者给药或临床 S/I/R 分类。
- 不能声称是通用或条件匹配的 *E. coli* 实验预测器。
- 不能把 OD600 当作 CFU/mL，或声称存在通用 OD→CFU 转换。
- 不能用当前未处理数据拟合或验证任何抗生素 `zMIC`、`kappa` 或 `psiMin`。
- 不能把形式正确的留出拆分自动称为 L4：实验独立性证据仍不充分。
- 不能把探索性 Monte Carlo 区间称为置信区间。

### 模型范围

当前模型只覆盖单一均质种群、无药逻辑斯蒂增长和单药分段恒定浓度协议。它不包含：

- 耐药进化或突变；
- 持留菌、异质亚群或适应性耐受；
- 联合用药；
- 人体药代动力学；
- 空间扩散、生物膜或菌落结构；
- 宿主免疫；
- 临床断点或治疗建议。

`zMIC` 始终表示药效函数的零净增长浓度；不能简写成未经限定的普通 MIC。

### 数据与验证边界

内置 Figshare 子集包含 12 条 BW25113、未处理、原始未扣空白 OD600 轨迹。它与补充 M9 目标条件不完全匹配，也不含抗生素暴露。当前工作流：

- 只在训练数据上拟合两个预声明生物参数；
- 通过 `OD600 = baselineOd + scaleOd × (N/K)` 连接潜在模型与观测；
- 在验证前锁定生物参数和观测层参数；
- 按完整轨迹执行留出评价；
- 保留验证差于预声明训练均值基线的负面结果；
- 因孔/板独立性记录不足而保持 L4 不合格。

### 尚未完成的发布验证

- 尚未测量并通过浏览器交互延迟 P95；发布预算只审计静态文件字节数。
- 本次环境没有完成 Chrome、Firefox、Safari 的人工跨浏览器矩阵。
- Safari WebDriver 仍要求本机启用 Allow remote automation。
- 自动化发布检查不能替代科学同行评议、实验重复或外部验证。
- Sandbox JSON 是运行清单而非可导入项目包；spreadsheet-safe CSV 不承诺任意字符串的无损往返。
- IndexedDB 列表当前仍会读取完整保存记录；大量长期积累的数据集/分析需要后续分页 metadata 与配额管理优化。

## English

### Supported claims

- Learn / Sandbox supports teaching, model exploration, and reproducible L1 demonstrations.
- Research Workspace performs real-data quality control, training fit, diagnostics, uncertainty and sensitivity analysis, and locked held-out evaluation.
- The versioned portfolio artifact demonstrates L3 data calibration for the bundled run.
- Software tests establish conformance to declared mathematical, data, and release contracts.

### Unsupported claims

- No clinical decision support, patient dosing, or clinical S/I/R classification.
- No claim of a general or condition-matched *E. coli* experimental predictor.
- OD600 is not CFU/mL, and no universal OD-to-CFU conversion is established.
- The untreated dataset cannot fit or validate antibiotic `zMIC`, `kappa`, or `psiMin` parameters.
- A formally correct holdout does not automatically qualify as L4; experimental independence evidence is incomplete.
- Exploratory Monte Carlo intervals are not confidence intervals.

The model excludes resistance evolution, persisters, heterogeneous subpopulations, combination therapy, human pharmacokinetics, spatial or biofilm dynamics, host immunity, clinical breakpoints, and treatment recommendations. `zMIC` always means the pharmacodynamic zero-net-growth concentration, not an unqualified conventional MIC.

The bundled OD600 workflow retains the negative finding that validation is worse than its predeclared training-mean baseline. It remains L4-ineligible because source well/plate independence is incompletely documented.

Browser interaction P95 has not been measured or passed. This release audits static byte budgets, not browser latency. A manual Chrome/Firefox/Safari matrix was not completed in the recorded environment, and automated checks do not replace peer review, experimental replication, or external validation. Sandbox JSON is a run manifest rather than an importable project package, spreadsheet-safe CSV is not promised as an arbitrary-string lossless exchange format, and IndexedDB listing still loads complete saved records rather than paginated metadata.
