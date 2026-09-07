# Research Workspace / 研究工作区

## 定位与版本

Ecolab `6.0.0` 在 `#/research` 提供本地优先的真实数据工作区。分析引擎为 `2.0.0`，implementation `ecolab-research-analysis-v2`，稳定 ID 仍为 `ecolab.stage4.analysis`；教学科学核心 `2.0.0`、模型 `1.0.0` 不变。

新版保留现有潜在种群模型的 OD 校准，增加直接 OD Logistic/Gompertz 比较、整训练轨迹交叉验证及联合 bootstrap、严格研究包检查与同版显式复算。原留出曲线已在此前版本中查看，因此本版一律称**开发集比较**，不是未触碰测试或外部验证。功能完成、优化收敛、参数可识别性与统计精度分开报告。

科研能力标签按每次运行计算；L3 表示完成校准与诊断流程，不证明参数唯一、优化充分或预测有效。当前数据不具备 L4 独立验证资格，也不能验证三种抗生素药效。完整方程、参数、论文及方法差异见 [方法证据](./research-method-evidence.md)。

## 启动

```bash
npm run dev
# http://127.0.0.1:4173/#/research

# 或生成并预览生产产物
npm run build
npm run preview
```

要求 Node ≥20.19；无第三方运行时依赖。在线静态站点初次加载资源需要网络，用户导入数据不上传到分析服务器。当前运行与研究包回放不需要外部 API 密钥。

## 四段工作流

### 1. Data：准入与质量检查

- 延迟加载内置真实数据，严格导入前检查规范 JSON 精确 UTF-8 字节 SHA-256。
- 支持规范 JSON / CSV 导入；CSV 显式声明数据集 ID、标题和许可证。
- 检查 schema、字段、角色、完整轨迹、测量类型和条件元数据；逐字段显示菌株、培养基、观测层匹配。
- 泛型数据缺失的条件保持 `Unknown`，不继承 Figshare 的来源、许可或实验默认值。
- 只有通过精确注册表、哈希、观测数、角色和轨迹数合约的内置数据能启动一键研究工作流。泛型导入可 QC、保存、导出，不会自动套用该分析设计。
- 通过 QC 的源文本与数据记录可保存到 IndexedDB；原始 XLSX 不会随 Web 构建分发。

### 2. Design：预声明分析设计

潜在模型分支：无药分段解析 Logistic，K 固定，只拟合 `psiMaxLog10PerHour` 和 `initialStates.pooled.log10PopulationDensity`，训练侧剖面化 `baselineOd` / `scaleOd`。不拟合药效参数，不制造源 `t=0`。扫描与敏感性标量输出为冻结 OD 观测层下的 **10 h 预测 OD600**。

直接 OD 分支：训练均值基线、经验 Logistic、经验 Gompertz。四个曲线参数的默认工程边界是 `baselineOd:[0,0.3]`、`amplitudeOd:[0.001,1]`、`ratePerHour:[0.001,4]`、`timingHours:[0,30]`。形状系数与拐点时间不称为生理比增长率或延滞期。

按完整训练轨迹进行 CV，默认八折留一曲线；以 out-of-fold 每轨迹 RMSE 的算术均值选模。在最低分绝对容差 `1e-10` 内，固定优先级 `training_mean → logistic → gompertz`。随后在全部训练数据上拟合并冻结，再评价已查看开发集。

### 3. Analysis：Worker 计算

专用 module Web Worker 执行：

- Cartesian 二维参数扫描；
- 有界 Differential Evolution → Nelder–Mead 最小二乘拟合及停止诊断；
- 固定种子 Monte Carlo 工程范围传播；
- 局部有限差分、归一化 Morris、Sobol–Jansen 与配对行 bootstrap；
- 残差、macro / pooled 指标与预声明基线比较；
- 局部 Jacobian、秩、条件数、相关性和目标函数切片；
- 直接 OD 候选训练 CV、冻结选模、开发比较；
- 整训练轨迹有放回联合 bootstrap，保留重拟合结果、联合样本与失败；
- 能力标签、科学诊断、严格 manifest / research package 生成。

主线程只接收进度、结构化错误和结果；取消通过终止对应 Worker 保证，部分结果不会保存为完成分析。回放任务与当前分析状态隔离。

随机算法为 `xoshiro128ss-splitmix32-v1`；根种子与各任务子流种子、算法预算进入 manifest 和完整回放输入。工程三角范围 Monte Carlo 不是统计置信区间；Morris 全边界与 Sobol 独立三角范围不同，不能混为同一排名。整曲线 bootstrap 保留联合结构，不能拆成独立参数边际用于敏感性。

### 4. Results：如实展示结果

结果页展示训练 / 开发观测与预测、基线、残差、参数扫描、不确定性、三类敏感性、OD 模型比较以及数值和统计诊断。残差为 `observed - predicted`；macro RMSE 先逐轨迹计算再等权平均，pooled RMSE / MAE 则汇总全部观测点。轨迹汇总标识本身不认证生物学独立性。

`objectiveSlices` 固定其他生物参数、重新优化 OD 干扰参数，不是真 profile likelihood，不将端点解释为置信限。秩亏 covariance 为 `null`，伪逆仅是几何诊断。

本版固定种子 `small` 实际案例中，训练 CV 选择训练均值基线；开发 macro RMSE 为 `0.003047562725247655`，原潜在模型为 `0.008333855238427267`，后者更差且未收敛。整体 `completed=true`，但 `converged=false`、`identified=false`、`precisionAssessed=false`。准确预算、CV 分数、敏感性结果与解释见 [作品集案例](./portfolio-case-study.md)。

## 内置数据与角色保护

数据 `figshare-bw25113-growth-v1@1.0.0`：Aida / Ying (2025)，[数据 DOI](https://doi.org/10.6084/m9.figshare.28342064.v1)，[论文 DOI](https://doi.org/10.1038/s41597-025-05356-3)，`CC BY 4.0`。

- E. coli BW25113，无药，化学定义培养基 `Cond00003`，并非目标补充 M9。
- 37 °C、96 孔板、200 µL、567 rpm、1:1000 接种、Epoch2。
- 原始未扣空白 OD600；0.5–22 h，每 0.5 h 一次。
- 12 完整轨迹 / 528 点；训练 `Curve00025–Curve00032`，8 条 / 352 点。
- 已查看开发比较 `Curve00033–Curve00036`，4 条 / 176 点；原数据的 `validation` 角色字段原样保存供追溯。
- 同管分孔与曲线标签不能证明独立实验批次；`independentUnitsDocumented=false`，`eligibleAsValidationEvidence=false`。

规范 JSON artifact 字节 SHA-256：`67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817`。原始 XLSX 字节哈希与 normalized canonical fingerprint 是不同对象，见 [准入审查](./data-candidate-review.md) 和 [数据卡](../data/datasets/figshare-bw25113-growth-v1/README.md)。

同一轨迹不跨训练 / 开发；参数、OD 观测层、训练 CV 选择与 bootstrap 不使用开发观测值。开发预测不重新优化。精确时间均值基线也仅使用训练值。源 `validation` 字段及 legacy `lockedValidation` schema 标志仅保留角色来源及参数冻结契约，不能解释为本版未触碰验证资格。

观测层 `OD=b+s(N/K)` 不改变源值、不标定绝对 CFU。新经验 OD 模型同样不能估计药效、耐药进化或人体给药效果。

## 本地存储、恢复与中断

```text
IndexedDB: ecolab-local
version: 2
stores: projects, datasets, analyses
```

- 数据集与分析 revision 检查使用 `DATASET_REVISION_CONFLICT` / `ANALYSIS_REVISION_CONFLICT`。
- 恢复结果必须匹配数据集 **id + revision + contentHash**，不能把旧版本或其他数据结果挂到当前数据集。
- 初始化不支持、被阻塞或超时时可降级到内存，并显示原因；内存数据刷新后可能丢失。
- 运行时配额 / 事务失败明确报错，不静默切到另一数据库或宣称保存成功。
- 重载发现 `running` 的旧任务会标记 `interrupted`，而不是完成。
- 本地保存不等于备份；清除浏览器站点数据会删除 IndexedDB。列表仍读取完整记录，长期大量数据的分页与配额管理尚未优化。

## 导出、检查与显式复算

导出包括：

- `*.analysis-manifest.json`：严格运行清单，直接序列化实际 manifest，不添加根字段；
- `*.research-package.json`：严格研究包、内容寻址 inventory、精确源文本、规范数据、拆分、冻结计划、解析模型及完整计算设置；
- `*.normalized-dataset.csv`：保留源角色，并附来源 / 许可和已查看开发集披露；
- `*.predictions-residuals-metrics.csv`：预测、残差、指标与科学限定；
- `*.methods.md`：方法摘要；`*.research-dashboard.svg`：图表面板。

CSV 防电子表格公式注入，不承诺任意文本的字节级无损往返；JSON / 研究包是机器交换格式。Sandbox JSON 仍是运行清单，不是可编辑项目的文件导入格式。

研究包面板的流程：

1. 选择研究包 JSON；导入只发出 `research.package-inspect`，**不自动运行**。
2. 检查安全 JSON、严格结构、inventory、字节 / SHA 与输入关联。上限 32 MiB、64 artifacts、深度 64、100 万 JSON 值；参数 / 计算预算也有上限。
3. 完整输入且软件 / 模型精确兼容时，用户点击显式复算，发送 `research.package-replay`；只调用内置代码，不执行导入代码或联网获取依赖。
4. 同时比较完整科学投影与**完整分析 manifest**。默认数值容差为绝对 `1e-10`、相对 `1e-8`；类型、键、数组顺序及非数值字段精确比较。唯一文本例外是两侧均与自身结构化字段逐字相符的内置相关性 / 有限高条件数警告模板：数值仍按同一容差核对，避免跨运行时浮点尾差成为字符串误报。任意改写警告、超容差数值或更改其他字段仍会产生差异；重哈希本身不能证明科学匹配。
5. 结果为独立 `replayPreview`：只在内存中查看、不保存、不关联选中数据集，不覆盖当前分析，可取消，刷新后丢失。

数据自包含不等于独立可执行；精确依赖仍必需。旧包缺输入或版本不兼容时只检查查看，拒绝复算。哈希不证明来源真实性；`replayable` 表示允许尝试复算，不表示已经确认科学结论一致。

生成示例的 JSON 是 wrapper，不是研究包 schema；若从 [6.0.0 示例](../data/examples/ecolab-stage6-research-6.0.0.json) 导入，使用其中 `researchPackage` 字段。

## 复现与验证

```bash
npm run audit:data
npm run example:research
npm run build
npm run build:public
npm run check:reproducible
```

需要重建来源链时，可运行 `npm run data:acquire:figshare` 和 `npm run data:extract:figshare`；常规回放只需包内的规范源文本，不需联网或原始 XLSX。发布排除 `data/raw/`、`.xlsx` 和测试目录。

实际全量、发布与隔离浏览器验证记录见 [发布检查表](./release-checklist.md)。软件测试与确定性复算不替代独立实验、充分优化预算、统计精度或同行评议。

## English summary

Research v2 separates teaching dynamics from direct-OD model comparison. Training-only whole-trajectory CV selects a frozen candidate before evaluating previously viewed development curves. Joint trajectory bootstrap is conditional and exploratory; source independence is unverified. Completion, convergence, identification and precision remain separate.

Computation and qualified source text/results stay local. Initialization may fall back to volatile memory; runtime storage failures are explicit. Package import inspects only, exact-version replay requires an explicit action, and comparison includes both scientific output and the full manifest. Replay previews never overwrite saved analyses. Untreated OD600 supports no antibiotic-effect, absolute-CFU or clinical validation claim.
