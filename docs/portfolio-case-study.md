# Ecolab 项目介绍与真实结果 / Portfolio case study

当前案例：应用 `6.0.0`，分析引擎 `2.0.0`；2026-09-07。

## 可用于简历 / 作品集的三条介绍草稿

> 以下“负责”表述供项目作者核对使用。代码能证明功能存在，但不能证明个人历史分工；请仅保留本人实际设计、实现或维护的范围。公开数据来自 Aida / Ying，不应写成本人采集；公开数学模型应注明引用，而非声称原创。

- **大肠杆菌–抗生素计算模拟：**负责将 Regoes 四参数浓度–净增长模型与分段解析 Logistic 种群动力学组合实现，搭建浏览器教学沙盒，支持氨苄西林、四环素、环丙沙星单药暴露协议及种群轨迹分析。建立带单位、版本、论文定位及条件匹配标记的参数注册表，明确区分 CAB1/LB 文献药效参数的跨条件迁移与 BW25113 的真实数据分析。
- **参数分析与真实数据评价：**负责参数扫描、有界差分进化结合 Nelder–Mead 拟合、整轨迹训练交叉验证、Morris/Sobol–Jansen 敏感性、Monte Carlo 与整轨迹联合 bootstrap 模块。以公开的 12 条 BW25113 无药 OD600 轨迹、528 个观测验证分析流程；固定种子快速示例中，训练 CV 选择均值基线，已查看开发集 macro RMSE 为 **0.003048 OD**，原潜在模型为 **0.008334 OD**，如实报告模型未优于基线、优化未收敛及敏感性精度不足，未将开发比较包装为独立验证。
- **本地优先与可复现工作区：**负责 Learn / Sandbox 与真实数据 Research Workspace 双模式、Web Worker 异步计算及取消、IndexedDB 数据/结果持久化和 revision 冲突检查；实现记录源数据 SHA-256、模型快照、算法版本、参数边界和随机种子的研究包，支持严格导入校验与精确兼容版本的显式复算。用户数据不上传分析服务器；存储不可用时提示易失内存，运行时配额失败明确报错。

这三条避免了“完成三药实测验证”“证明模型稳定”“所有环境永久完整复现”等超出证据的声明。若篇幅有限，可以删去方法枚举，但不要删除数据类型、开发集角色或跨条件迁移的限定。

## 数学模型、主要参数与来源

教学模型为：

```text
q(C) = (C/zMIC)^κ
ψ(C) = ψmax - (ψmax-ψmin) × q(C)/(q(C)-ψmin/ψmax)
ψ(C)>0: dN/dt = ln(10) × ψ(C) × N × (1-N/K)
ψ(C)≤0: d log10(N)/dt = ψ(C)
```

三药参数 `(zMIC mg/L, κ, ψmin log10-fold/h)` 分别为氨苄西林 `(3.4,0.75,-4)`、四环素 `(0.67,0.61,-8.1)`、环丙沙星 `(0.017,1.1,-6.5)`，来自 Regoes et al. (2004) Table 1 的 CAB1/LB 条件：[公开全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC521919/)。教学生长倍增时间 `42 min` 来自 [BioNumbers 111767](https://bionumbers.hms.harvard.edu/bionumber.aspx?id=111767) / [Campos 2014](https://doi.org/10.1016/j.cell.2014.11.022)，承载量 `10^9 CFU/mL` 是教学假设。

真实数据层保留 `OD=b+s(N/K)` 校准，并增加直接 OD 的 Logistic 与 Gompertz；采用 [Zwietering 1990](https://doi.org/10.1128/aem.56.6.1875-1881.1990) 的增长曲线比较思想，但不冒充原文的 log-population / 生理 lag 参数化。完整方程、单位、边界、算法和源码索引见 [方法证据](./research-method-evidence.md)。

## 实际运行条件与数据角色

复现命令：

```bash
npm run example:research
```

- 数据：`figshare-bw25113-growth-v1@1.0.0`，Aida / Ying (2025)，[DOI](https://doi.org/10.6084/m9.figshare.28342064.v1)，`CC BY 4.0`。
- BW25113、无药、`Cond00003`、原始未扣空白 OD600；与目标补充 M9 不完全匹配，不转换为 CFU。
- 训练 `Curve00025–32`：8 曲线 / 352 点；开发比较 `Curve00033–36`：4 曲线 / 176 点。
- 后四条源角色仍保存为 `validation`，但此前已查看，因此当前研究不是 untouched test。曲线标签不证明独立生物实验批次。
- `small`、根种子 `123456789`，科学随机算法 `xoshiro128ss-splitmix32-v1`。
- 潜在模型：DE 80 次 + NM 80 次评价、population 8、restart 1；直接 OD：每次 DE 120 + NM 80、population 8、restart 1。
- Morris 2 条轨迹 / 4 levels；Sobol 基础样本 8、配对行 bootstrap 40；增长曲线 bootstrap 20。

这是可快速重复的工程示例，不是充分预算的参数估计研究。不能因它输出了指标就称拟合成功。

## 真实结果及正确解读

### 训练交叉验证与冻结选模

8 折整训练轨迹 CV 的 macro RMSE：

- `training_mean`：**0.0038482670745189043**；被选中。
- Logistic：**0.014889438648207414**；0/8 折报告收敛。
- Gompertz：**0.017664751867487005**；0/8 折报告收敛。

参数化模型在当前预算内未收敛，因此这些数值不能证明其充分优化后仍不如基线。当前能说的是：**本次预声明预算与选择规则选中了训练均值基线**，不是“Logistic/Gompertz 提升了预测效果”。

### 已查看开发集比较

冻结的选中模型恰好就是基线：

- macro RMSE：**0.003047562725247655 OD**。
- pooled RMSE：**0.0031805851912959228 OD**。
- MAE：**0.002392045454545456 OD**。
- 选中模型减基线 macro RMSE：**0**。

原潜在种群模型的冻结 OD 校准：

- macro RMSE：**0.008333855238427267 OD**。
- pooled RMSE：**0.008344901370085705 OD**。
- MAE：**0.006275964812029507 OD**。
- macro RMSE 相对基线差值：**+0.005286292513179611 OD**，即更差。

该潜在模型完成 160 次评价，但停止原因是 `maximum_evaluations`、`converged=false`。流程能力标签 L3 代表完成校准/诊断步骤，不证明参数已识别、优化充分或泛化有效。

### 哪个参数影响最大？

输出为潜在模型 10 h 预测 OD600，观测层冻结；只比较 `ψmax` 与 `log10(N0)`，不是比较三药参数。

- 全参数边界的 **Morris** 中，`log10(N0)` 的观察 `μ*` 最大：**0.11151687725288119**，`σ=0.1525358391895307`。只有 2 条轨迹，不能据此宣称稳健排名。
- 拟合点附近独立三角范围的 **Sobol–Jansen** 中，`ψmax` 的观察指数最大：`S1=0.9017016648896881`、`ST=0.4417230674421621`。
- 对应 95% 配对 bootstrap 区间：S1 **[0.7199217910353869, 0.968749179296953]**，ST **[0.1970655289276893, 0.8725470045625012]**。样本不足且出现 `S1>ST`，界面保留警告，不裁剪成表面合理结果。

两种方法的输入范围不同；它们不能拼成一个通用生物学结论。准确说法是“实现并报告了探索性参数影响筛选，同时识别到当前采样精度不足”，而非“证明某参数最重要 / 模型稳定”。

### 不确定性与完成状态

20 次整训练曲线 bootstrap 均成功；选中的是无参数均值基线，所以参数区间为空、均值曲线区间存在。95% 区间每侧期望尾样本仅约 0.5，分辨率不足；曲线独立性也未核实，不能声称可靠置信覆盖率。

本次整体状态：

```text
completed=true
converged=false
identified=false
precisionAssessed=false
validationEvidence=previously_viewed_development_only
eligibleForL4=false
```

## 可复现工件与个人贡献核对

- [当前 JSON](../data/examples/ecolab-stage6-research-6.0.0.json)；[当前自动生成的方法/结果](../data/examples/ecolab-stage6-research-6.0.0.md)。
- 科学结果 canonical SHA-256：`6c4657779363edb4d9d3cbe33c15520378eb5a62469f9caff7b52da54cafb84e`。
- JSON 是示例 wrapper；浏览器研究包导入应使用其中 `researchPackage`，不是整个 wrapper。研究包数据自包含，但依赖精确兼容的内置软件；哈希只证明完整性，不证明真实性。
- [历史 5.0.0 JSON](../data/examples/ecolab-stage5-small-research-5.0.0.json) 与 [历史 Markdown](../data/examples/ecolab-stage5-small-research-5.0.0.md) 原样保留；旧文案仅代表当时记录，不延续为本版的未触碰验证声明。

可核对的贡献范围：模型/单位与注册表、分析算法与测试、前端状态/Worker/存储、数据导入与许可审计、回放与发布工程。请结合个人提交记录、设计记录或合作分工确认，不能仅凭当前源码将所有工作归于一个人。

工程验证状态以 [发布检查表](./release-checklist.md) 为准；软件测试不替代实验复现和同行评议。

## English summary

Ecolab combines a referenced Regoes pharmacodynamic function with piecewise analytic population dynamics in a bilingual local-first teaching sandbox. Its separate research workspace analyzes admitted untreated BW25113 OD600 data, adds bounded DE→Nelder–Mead fitting, whole-trajectory training CV, Morris/Sobol–Jansen screening and conditional joint trajectory bootstrap, and supports integrity-checked exact-version replay.

The deterministic small example selects the training-mean baseline. Development macro RMSE is 0.00304756 OD; the legacy latent-model calibration scores 0.00833386 OD and remains nonconverged. Parameter identification and statistical precision are not established. Previously viewed data are not untouched validation, and untreated OD cannot validate antibiotic effects. First-person contribution claims require the author's confirmation of actual responsibility.
