# Ecolab project overview / 项目概览

Ecolab 6.0.0 是本地优先的大肠杆菌种群建模项目，包含教学与研究两个用途，使用原生 JavaScript ES Modules、SVG、Web Worker 和 IndexedDB，无第三方运行时依赖。

## 两个工作区

- **Learn / Sandbox**：七步中英文课程和自由实验沙盒。采用 Regoes 浓度–净增长率函数，正增长用 Logistic，零或负增长在 log10 空间解析推进；覆盖氨苄西林、四环素、环丙沙星的单药分段恒定暴露。参数为跨菌株/培养基迁移探索，不是经过匹配条件验证的预测器。
- **Research Workspace**：真实数据导入/QC、训练拟合、参数扫描、敏感性、探索性不确定性、OD 模型比较、完整训练轨迹交叉验证与 bootstrap、开发集比较、研究包校验和同版复算。泛型数据可质控、保存和导出；一键研究仍只支持精确核验的内置数据合约。

## 版本与证据边界

应用 `6.0.0`；分析引擎 `2.0.0` / `ecolab-research-analysis-v2`；教学核心 `2.0.0`；模型 `1.0.0`。分析算法变更不再冒用旧分析版本。历史 5.0.0 工件保持原样。

内置数据来自 Aida 与 Ying 的公开 Figshare 数据，含 12 条无药 BW25113 `Cond00003` 原始 OD600 曲线、528 个点。8 条用于训练；原先留出的 4 条已被查看，本次升级中仅作为开发比较。完整曲线隔离并不证明独立实验重复，当前不具备 L4 独立验证证据。不能由 OD600 推导绝对 CFU 或验证抗生素参数。

当前小预算案例完成了计算，但参数模型未收敛，也未建立参数可识别性或区间精度。训练交叉验证选中了逐时间均值基线，开发 macro RMSE 为 `0.003047562725247655`；原潜在模型为 `0.008333855238427267`。这不是药效验证或参数模型改进的证据。

## 本地与可复现

合格数据源文本和结果存入 IndexedDB；内存降级模式关闭页面后可能丢失。研究包嵌入源文本、数据、拆分、模型快照、完整计算设置、种子及科学结果，校验字节数、SHA-256 与交叉引用后，只调用精确同版内置算法复算。包不执行导入代码、不联网补依赖；哈希证明内容一致性，不证明来源真实性。

## English

Ecolab combines a bilingual teaching sandbox with an auditable research workspace. Version 6 preserves its single-population teaching dynamics and introduces analysis v2: numerical fixes, empirical OD Logistic/Gompertz comparisons, training-only whole-trajectory CV/bootstrap, development evaluation and integrity-checked exact-version replay.

The bundled data are untreated OD600, not antibiotic-response or absolute-CFU validation data. Previously viewed holdout curves are development data; uncertain experimental independence remains explicit. The quick example selects the training-mean baseline, not a converged parametric growth model. Local IndexedDB persistence can fall back to volatile memory at initialization; exported packages require compatible built-in software and do not execute imported code.

## 继续阅读

- [方程、参数与论文](./research-method-evidence.md)
- [项目介绍与实际结果](./portfolio-case-study.md)
- [研究工作区](./research-workspace.md)
- [架构](./architecture.md)
- [限制](./limitations.md)
- [验证记录](./release-checklist.md)
