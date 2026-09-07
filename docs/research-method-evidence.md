# 数学模型、参数与论文证据 / Methods and evidence

更新：2026-09-07；应用 `6.0.0`，分析引擎 `2.0.0`，教学科学核心 `2.0.0`，教学模型 `1.0.0`。

本文区分**论文中的方法、项目实际实现、当前数据能支持的结论**。论文提供方法依据不等于完成了本项目的实验验证。真实计算及可用介绍见 [作品集案例](./portfolio-case-study.md)，运行工件见 [6.0.0 示例](../data/examples/ecolab-stage6-research-6.0.0.md)。

## 1. 教学层：Regoes 药效函数与分段种群动力学

对浓度 C，使用 Regoes et al. (2004) 四参数净增长函数：

```text
q(C) = (C / zMIC)^κ
ψ(C) = ψmax - (ψmax - ψmin) × q(C) / (q(C) - ψmin / ψmax)
```

- `C`、`zMIC`：mg/L；`κ`：无量纲；`ψmax`、`ψmin`：log10-fold/h。
- `ψ(0)=ψmax`，`ψ(zMIC)=0`，高浓度极限为 `ψmin`。
- `zMIC` 是该函数的零净增长浓度，不是临床断点，也不等同于二倍稀释实验 MIC。
- 实现采用代数等价的稳定表达，避免直接计算巨大幂。

项目把该净增长函数与密度约束结合：

```text
ψ(C) > 0:  dN/dt = ln(10) × ψ(C) × N × (1 - N/K)
ψ(C) ≤ 0:  d log10(N)/dt = ψ(C)
```

`N` 为潜在 CFU/mL，`K` 为承载量。正增长段解析解为 `N(t+Δt)=K/[1+(K/N(t)-1)exp(-ln(10)ψΔt)]`；非正增长段在 log10 状态中线性推进。浓度协议是单药分段常量，状态连续、边界浓度右连续。密度约束及协议封装是**本项目的建模组合**，不是声称逐项复刻 Regoes 的完整实验系统。

只模拟均质单种群；不包含耐药进化、持留亚群、联合用药、人体药代动力学或临床决策。检测限属于观测层，不截断潜在种群，也不能用净变化量冒充累计死亡数。

### 主要参数及来源

权威数值与逐项定位保存在 [参数注册表](../data/registry/parameter-sets.json)，来源索引在 [sources.json](../data/registry/sources.json)。

- **氨苄西林**：`zMIC=3.4 mg/L`，`κ=0.75`，`ψmin=-4 log10-fold/h`。
- **四环素**：`zMIC=0.67 mg/L`，`κ=0.61`，`ψmin=-8.1 log10-fold/h`。
- **环丙沙星**：`zMIC=0.017 mg/L`，`κ=1.1`，`ψmin=-6.5 log10-fold/h`。
- 上述三药参数来自 **Regoes Table 1，E. coli O18:K1:H7 CAB1 / LB**，迁移到项目 BW25113 目标，必须标记 `transferred_calibration`；不是 BW25113/M9 条件匹配估计。原文 broth-dilution MIC 分别为 `8`、`1`、`0.03 mg/L`，仅作来源上下文，未作为模型 zMIC 使用。
- 教学生长基线：倍增时间 `42 min`，`ψmax=log10(2)/0.7 ≈ 0.43004 log10-fold/h`，来自 BioNumbers 111767 / Campos et al. (2014)。注册表保留原报道的 `±12 min` 及其统计含义未核实的警告，不把它自动变成标准差或先验分布。
- `K=10^9 CFU/mL` 是明确声明的教学假设，不是测量或当前 OD 拟合的估计值。初始种群、时间和暴露协议是用户输入，进入运行清单。

参考：Regoes et al., *Pharmacodynamic Functions: a Multiparameter Approach to the Design of Antibiotic Treatment Regimens* (2004)，[公开全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC521919/)，[DOI](https://doi.org/10.1128/AAC.48.10.3670-3676.2004)。Campos et al. (2014)：[DOI](https://doi.org/10.1016/j.cell.2014.11.022)；[BioNumbers 111767](https://bionumbers.hms.harvard.edu/bionumber.aspx?id=111767)。

## 2. 数据：当前只有无药 OD600 校准与开发比较

准入数据为 Aida / Ying (2025)，`figshare-bw25113-growth-v1@1.0.0`：

- [Figshare 数据 DOI](https://doi.org/10.6084/m9.figshare.28342064.v1)，[Scientific Data 论文](https://doi.org/10.1038/s41597-025-05356-3)，`CC BY 4.0`。
- BW25113、无抗生素、化学定义培养基 `Cond00003`；原始**未扣空白** OD600，不平滑、不插值、不制造源 `t=0`。
- 12 条轨迹、528 点；0.5–22 h，每 0.5 h 一个观测。
- 训练 `Curve00025–Curve00032`：8 条、352 点。
- 原角色 `validation` 的 `Curve00033–Curve00036`：4 条、176 点。该部分已在之前版本中查看；6.0.0 明确改称 **development comparison（开发集比较）**，保留原始文件及角色字段以便追溯。
- 同管分孔的记录不能证明各轨迹是独立实验批次；`independentUnitId` 是拆分/汇总标识，不是独立性认证。`Cond00003` 也不能简写为目标补充 M9。

原始 XLSX、提取步骤、许可与哈希见 [准入审查](./data-candidate-review.md) 和 [数据卡](../data/datasets/figshare-bw25113-growth-v1/README.md)。规范 JSON 字节 SHA-256 为 `67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817`；规范对象 canonical fingerprint 为 `2c30ce8d5dcf43c35aeafff0b495da0e012aef6d6ed3c021acab69eaf2dfbbcc`。二者哈希对象不同，不能混用。

**这组数据不能估计/验证三药 zMIC、κ、ψmin，不能标定绝对 CFU，也不是外部验证集。**

## 3. 两类 OD 模型，不能混淆参数含义

### 3.1 潜在种群模型的观测层

```text
OD(t) = b + s × N(t)/K
```

现有校准只拟合无药 `ψmax` 与 pooled 模型时间零点 `log10(N0)`。边界分别为 `[0.05,0.8] log10-fold/h` 和 `[3,8.5] log10(CFU/mL)`；K 固定为教学值。每次训练目标评价用训练数据剖面化观测干扰参数 `b=baselineOd`、`s=scaleOd`，开发评价前冻结全部参数。

该层只是 OD 观测映射，不是 OD→CFU 实验校准。OD 的空白、散射及仪器依赖限制参考 Stevenson et al. (2016)，[DOI](https://doi.org/10.1038/srep38828)。

### 3.2 新增直接 OD 尺度的经验增长曲线

```text
Logistic: OD(t) = b + A / (1 + exp(-r × (t - ti)))
Gompertz: OD(t) = b + A × exp(-exp(-r × (t - ti)))
```

- `b`：基线 OD；`A>0`：OD 增幅；`r>0`：形状系数（1/h）；`ti`：拐点时间（h）。
- 最大 OD 斜率分别为 `A×r/4`、`A×r/e`。`r` **不是**种群比增长率 `μmax`，`ti` **不是**生理延滞期。
- 工作流默认预声明工程边界：`b∈[0,0.3]`、`A∈[0.001,1]`、`r∈[0.001,4]`、`ti∈[0,30]`；边界不是由开发观测反推的生理置信范围。

Zwietering et al. (1990)，*Modeling of the Bacterial Growth Curve*，[DOI](https://doi.org/10.1128/aem.56.6.1875-1881.1990)，提供增长曲线及参数化比较依据。**本项目是直接 OD 尺度的经验改写，不是原文 log-population / μmax / lag 参数化的逐式复现。**

## 4. 拟合、选模与评价

### 方法

- 有界 **Differential Evolution → Nelder–Mead**；保留重启、阶段预算、最佳已评价点、停止原因、失败候选及收敛标志。
- 潜在模型使用训练最小二乘，观测层只在训练侧求解。
- 新 OD 候选的目标为 `J(θ)=(1/U)Σu[(1/nu)Σj(yuj-fθ(tuj))²]`，即平均轨迹 MSE，避免较长轨迹获得隐含较大权重。
- 仅对训练轨迹进行整轨迹交叉验证；当前 8 条训练曲线默认 8 折留一曲线。绝不把同曲线不同时间点随机分到训练与评价。
- 候选包括精确时间上的训练均值基线 `training_mean`、Logistic、Gompertz。用 out-of-fold 每轨迹 RMSE 的算术均值选模；不是对不同大小折的分数无权平均。
- 在全局最低分绝对容差 `1e-10` 内，预声明优先级为 `training_mean → logistic → gompertz`。选择完成后在全部训练轨迹上拟合并冻结，才评价已查看开发集。有限但未收敛的候选分数保留供诊断，不能宣称已找到最优参数。

### 指标

令 `euj=yuj-ŷuj`：

```text
RMSEu      = sqrt(mean_j(euj²))
macro RMSE = mean_u(RMSEu)
pooled RMSE= sqrt(sum_uj(euj²) / sum_u(nu))
MAE        = sum_uj(abs(euj)) / sum_u(nu)
```

另保留平均残差、中位绝对误差、逐轨迹指标和相对预声明基线的有符号差值；RMSE/MAE 单位为 OD。`model - baseline > 0` 表示模型更差。点指标不会通过为删失值制造伪点残差而计算。

## 5. 参数扫描、敏感性及不确定性

当前组合工作流的扫描/敏感性输出是**冻结 OD 观测层下，潜在模型在 10 h 的预测 OD600**，不是新增 Logistic/Gompertz 的参数排名，也不是三药效应排名。

### 局部与 Morris

- Cartesian 参数网格扫描，保留两个生物参数的完整边界和每格预测。
- 局部有限差分估计变化率，记录实际步长及参数边界影响。
- Morris 在单位超立方体上定义 `EEi=[f(x+Δei)-f(x)]/Δ`，报告有符号 `μ`、绝对均值 `μ*` 和样本 `σ`。归一化分母使结果反映所声明**全范围**的效应，不是每物理单位导数。
- 网格与步长必须相容；只有一条轨迹时 σ 为 `null`，不能报告伪零不确定性。

参考 Morris (1991)，[DOI](https://doi.org/10.2307/1269043)。

### Sobol–Jansen

独立生成 A、B；`A_Bi` 保留 A 的其他列，仅第 i 列取 B。V 使用 A/B 输出合并后的样本方差：

```text
STi = Σk[f(Ak)-f(A_Bi,k)]² / (2nV)
S1i = 1 - Σk[f(Bk)-f(A_Bi,k)]² / (2nV)
```

- 当前工作流使用拟合点附近的独立三角工程范围，**不同于 Morris 的完整有界空间**。
- 对 A/B/各混合矩阵的对应行一起 bootstrap，保持配对关系；报告 R7 percentile 区间、区间宽度与尾部样本警告。
- 这是给定独立输入分布下的 Monte Carlo 估计误差，不涵盖模型误设或数据不确定性。原始负值及 `S1>ST` 不裁剪、不重排。
- 公共 API 限制 bootstrap 最多 2000 次，并检查 `2×B×n×参数数×输出数 ≤ 100,000,000`，超预算明确拒绝。

参考 Jansen (1999)，[DOI](https://doi.org/10.1016/S0010-4655(98)00154-4)；Saltelli et al. (2010)，[DOI](https://doi.org/10.1016/j.cpc.2009.09.018)。采用 Jansen 估计式不意味着使用 Sobol 低差异序列；这里随机数算法为 `xoshiro128ss-splitmix32-v1`。

### 两种不确定性不可混用

1. **工程范围 Monte Carlo**：独立三角参数范围传播到 10 h OD；是探索性模拟区间，不是从实测数据推得的置信区间。
2. **整训练轨迹联合 bootstrap**：有放回抽取完整轨迹，保留每条曲线内时间/观测配对；对冻结的选中模型重拟合，保留联合参数样本、曲线均值、收敛诊断及失败。区间条件于选中模型、边界及有限收敛重拟合，未包含选模不确定性或新观测噪声；不是同时置信带。

曲线交换性/独立性未得到充分实验证明；因此 bootstrap 区间明确是探索性的条件区间。联合样本不得拆成独立参数边际后冒充 Sobol 输入。选中无参数均值基线时，参数区间为空是正确语义，仍可报告均值曲线区间。

## 6. 可识别性与“稳定性”的可支持含义

局部 Jacobian、秩、条件数、相关性及多起点结果揭示局部病态风险。秩亏时校准协方差为 `null`；保留的伪逆仅作几何诊断，不是已识别参数的不确定性。

当前 `objectiveSlices` 扫描一个生物参数、固定其他生物参数，同时重新优化 OD 干扰参数。它是 **nuisance-profiled objective slice**，不是对全部其余参数重新优化的真正 profile likelihood，也不能把扫描端点当作置信限。旧 `profiles` 字段仅作兼容 alias。

Raue et al. (2009)，[DOI](https://doi.org/10.1093/bioinformatics/btp358)，用于区分真正 profile likelihood 与当前实现；本文**不声称已实现该论文的完整方法**。

系统分开报告 `completed`、`converged`、`identified`、`precisionAssessed`。数学回归测试通过与输入扰动分析只能支持相应实现/数值声明，不能证明实验预测稳定、参数唯一或临床有效。

## 7. 实现入口与可追溯性

- 教学模型契约：[科学核心](./scientific-core.md)；参数/来源：[registry](../data/registry/parameter-sets.json)。
- 最小二乘/优化：[`fitting.js`](../src/analysis/fitting.js)、[`optimizers.js`](../src/analysis/optimizers.js)。
- OD 观测层与旧校准组合：[`od-observation-model.js`](../src/analysis/od-observation-model.js)、[`research-workflow.js`](../src/analysis/research-workflow.js)。
- 新 OD 比较/CV/bootstrap：[`growth-comparison.js`](../src/analysis/growth-comparison.js)；版本化组合：[`research-upgrade.js`](../src/analysis/research-upgrade.js)。
- 指标与诊断：[`metrics.js`](../src/analysis/metrics.js)、[`identifiability.js`](../src/analysis/identifiability.js)。
- 敏感性：[`sensitivity-local.js`](../src/analysis/sensitivity-local.js)、[`sensitivity-morris.js`](../src/analysis/sensitivity-morris.js)、[`sensitivity-sobol.js`](../src/analysis/sensitivity-sobol.js)。
- 严格研究包检查及同版复算：[`research-replay.js`](../src/analysis/research-replay.js)；浏览器流程：[Research Workspace](./research-workspace.md)。

研究包嵌入精确源文本、拆分、解析模型、完整设置、版本、随机种子和科学输出；导入不执行代码、不联网获取依赖。哈希验证字节完整性，输入关联检查也**不证明数据真实、来源身份或科学结论一致**。精确兼容的内置软件可显式复算，同时比较科学投影与完整分析 manifest，防止单独重哈希一个矛盾清单后误报匹配；旧版缺输入的包只查看。数据自包含不等于可独立执行，也不保证无限跨版本复现。

跨运行时数值比较使用绝对 `1e-10`、相对 `1e-8` 的默认容差。若相关性 / 有限高条件数警告在两侧均逐字符合各自字段对应的封闭内置模板，其重复数值文本不另作字符串相等要求；结构化数值、code、source、parameters、所有其他字段及整个 manifest 仍参与比较。未知模板、文本与自身数值不符或被添加结论时继续严格拒绝。该兼容修复不改科学输出、哈希工件或容差；`matched` 表示所声明规则下等价，不表示字节相同或来源真实。

## English summary

The teaching layer combines the Regoes concentration–net-growth function with piecewise analytic density-limited growth/decline. Drug parameters are transferred from CAB1/LB, not validated for BW25113/M9. The admitted data contain untreated raw OD600 only. Research v2 adds empirical direct-OD Logistic/Gompertz curves, whole-training-trajectory CV and joint curve bootstrap; these are not the original paper's log-population physiological parameterization. Previously viewed holdout curves are development comparisons, not untouched evidence. Optimizer convergence, identification, sampling precision and task completion are distinct. Method adoption and software conformance do not establish antibiotic-effect or experimental validation.
