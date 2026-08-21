# Research Workspace / 研究工作区

## 定位

Ecolab 5.0.0 在 `#/research` 提供本地优先的研究工作区，用于真实数据准入、质量检查、参数探索、训练拟合、锁定验证和可复现导出。Stage 5 更新应用发布线；科学核心引擎仍为 `2.0.0`，分析引擎仍为 `1.0.0`。它与 `Learn / Sandbox` 共用版本化科学模型，但使用独立的分析引擎、Worker 任务和研究数据存储。

科研能力按**每次运行**评估，而不是给整个应用永久贴等级。当前内置 Figshare 工作流可达到 **L3 — 数据校准**；虽然执行了锁定、无泄漏、未触碰的留出评价，但源数据没有充分记录孔/板之间的独立性，因此不具备 L4 验证证据资格。

本工作区不是临床工具，也不能把当前结果描述为经过条件匹配验证的 E. coli 抗生素预测器。

## 进入方式

启动源码应用：

```bash
npm run dev
```

打开 `http://127.0.0.1:4173/#/research`。

生产构建：

```bash
npm run build
npm run preview
```

## 四段工作流

### 1. Data

- 延迟加载内置真实数据；
- 在严格导入前验证内置规范 JSON artifact 精确 UTF-8 字节的 SHA-256；原始 XLSX 各自使用独立来源校验和；
- 导入规范 JSON 或 CSV；
- CSV 必须显式填写数据集 ID、标题和许可证；
- 执行 schema、字段、角色、独立单元、测量类型和条件元数据质控；
- 逐字段显示菌株、培养基和测量层匹配，不使用单一总分掩盖关键差异；
- 泛型导入缺少的条件保持 `Unknown`，不会继承内置数据默认值；
- 只有精确匹配注册表、哈希、观测数、角色和独立单元数的内置数据合约可以启动一键研究工作流。

### 2. Design

当前内置工作流预先声明：

- 潜在模型：现有无药分段解析逻辑斯蒂模型；
- 固定量：来自解析模型的承载量；
- 自由生物参数：
  - `psiMaxLog10PerHour`
  - `initialStates.pooled.log10PopulationDensity`
- 单一输出：10 h 时由观测层得到的预测 OD600；
- 训练/验证按完整轨迹拆分，禁止按行随机拆分；
- 不制造源数据中不存在的 `t = 0`；
- 不拟合任何抗生素参数；
- 参数拟合默认执行科学参数白名单，任意对象路径不能进入生产拟合。

### 3. Analysis

分析在专用 Web Worker 中执行，主线程只接收进度、结果或结构化错误。任务可以取消；取消通过终止 Worker 保证，部分结果不会被保存为已完成分析。

可用分析包括：

- 二维参数扫描；
- 固定种子的 Monte Carlo 参数不确定性传播；
- 局部敏感性；
- Morris 全局筛选；
- Sobol–Jansen 敏感性；
- 有界差分进化后接 Nelder–Mead 的参数拟合；
- 残差和训练/验证指标；
- 参数相关性、秩和条件数等可识别性诊断；
- 预先声明基线比较；
- 每次运行独立计算 L1–L5 能力等级。

所有科学随机分析使用：

```text
xoshiro128ss-splitmix32-v1
```

根种子和各分析子流种子都进入结果与 manifest。Monte Carlo 区间是探索性的**参数不确定性模拟区间**，不是置信区间。Sobol–Jansen 结果明确依赖输入参数相互独立的假设。

### 4. Results

结果页展示：

- 训练观测与模型叠加；
- 验证观测、单次锁定预测和预声明基线；
- 残差图；
- 参数扫描；
- Monte Carlo 区间；
- 局部、Morris 和 Sobol–Jansen 敏感性；
- 训练与验证指标；
- 优化和可识别性诊断；
- 当前运行的能力等级、门槛证据和警告。

残差统一定义为：

```text
residual = observed - predicted
```

指标同时报告 pooled 与按独立单元先计算再平均的 macro 结果，避免观测点较多的单元不透明地主导结论。

## 内置真实数据

数据集：

```text
figshare-bw25113-growth-v1@1.0.0
```

来源：

- Aida, Honoka; Ying, Bei-Wen (2025)
- *Bacterial growth profiles across one-thousand chemical-defined media*
- Dataset DOI: `10.6084/m9.figshare.28342064.v1`
- Article DOI: `10.1038/s41597-025-05356-3`
- License: `CC-BY-4.0`

纳入子集：

- *Escherichia coli* BW25113；
- 未处理的 `Cond00003` 化学定义培养基；
- 37 °C、96 孔板、200 µL、567 rpm、1:1000 接种、Epoch2；
- 原始未扣空白 OD600；
- `Curve00025`–`Curve00036`；
- 0.5–22.0 h，每 0.5 h 一次；
- 528 个观测、12 条完整轨迹；
- 训练：8 个单元、352 个观测；
- 验证：4 个单元、176 个观测。

内置规范 JSON artifact 字节 SHA-256：

```text
67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817
```

完整数据卡、原始文件校验和、转换历史和许可证见：

- `data/datasets/figshare-bw25113-growth-v1/README.md`
- `data/datasets/figshare-bw25113-growth-v1/checksums.json`
- `docs/data-candidate-review.md`

## OD600 观测模型

源数据保持原始 OD600 语义，未扣空白，也未执行 OD→CFU 换算。潜在 CFU 模型通过显式观测层连接到 OD600：

```text
OD600 = baselineOd + scaleOd × (N/K)
```

其中：

- `N/K` 是潜在逻辑斯蒂种群相对承载量；
- `baselineOd` 与 `scaleOd` 是观测层干扰参数；
- 两者只在训练数据上剖面化；
- 验证前锁定；
- 验证时不重新剖面化、不重新优化；
- 这个观测层不证明 OD600 与绝对 CFU/mL 的普适转换关系。

因此当前数据可以支持在明确条件下的 OD600 校准分析，但不能直接验证 CFU 绝对尺度或抗生素效应。

## 训练与验证保护

数据按完整曲线标签拆分：

```text
training:   Curve00025–Curve00032
validation: Curve00033–Curve00036
```

工作流保证：

1. 同一完整轨迹不跨训练和验证；
2. 生物参数只看训练值；
3. OD 观测层参数只看训练值；
4. 验证计划、参数、误差模型、排除规则、指标和基线在评价前锁定；
5. 验证只调用一次预测，不运行优化器；
6. 基线是每个精确源时间上训练单元 OD600 的算术均值，不使用验证值；
7. 训练表现和验证表现分开报告。

一次已验证的真实 Worker 运行得到 L3，并显示验证模型表现差于预声明训练均值基线。该负面结果必须保留；它不能被包装成预测成功。版本化 small-preset 运行及精确指标见 [Portfolio case study](./portfolio-case-study.md)。

## L3 与 L4 边界

当前运行满足 L3，因为它完成了：

- 固定种子的不确定性与敏感性分析；
- 条件描述明确的真实数据拟合；
- 残差、优化和可识别性诊断。

当前运行不满足 L4，尽管验证程序是锁定、无泄漏且未触碰的。L4 还要求：

- 独立单元身份与独立性有充分来源记录；
- 运行被明确标记为有资格承担验证证据。

当前数据的孔独立性和板身份记录不完整，因此：

```text
independentUnitsDocumented = false
eligibleAsValidationEvidence = false
capability = L3
```

这一区分防止用形式正确的留出拆分替代真实的实验独立性证据。

## 本地存储与中断语义

IndexedDB：

```text
ecolab-local
version 2
stores: projects, datasets, analyses
```

数据集和分析使用 revision 检查，冲突代码包括：

- `DATASET_REVISION_CONFLICT`
- `ANALYSIS_REVISION_CONFLICT`

不支持 IndexedDB 时自动退化为内存存储。应用重载后仍标记为 `running` 的分析会恢复为 `interrupted`，不会伪装成完成结果。

## 导出

完成运行后可以导出：

- `*.analysis-manifest.json`：分析 manifest；
- `*.research-package.json`：带内容寻址 artifact inventory、嵌入数据/拆分/锁定计划/模型快照和显式软件依赖的研究包；
- `*.normalized-dataset.csv`：规范数据；
- `*.predictions-residuals-metrics.csv`：验证预测、残差和指标；
- `*.methods.md`：自动生成的方法摘要；
- `*.research-dashboard.svg`：研究图表面板。

CSV 导出会防止电子表格公式注入，因此它是面向电子表格查看的安全格式，不承诺对以 `= + - @` 开头的任意文本做字节级无损往返；规范 JSON/研究包是机器交换与审计的权威格式。分析 manifest 是运行审计记录，不能恢复一个可编辑 Sandbox 项目。研究包不无条件声称 self-contained：它嵌入规范数据、拆分、完整锁定计划和解析模型快照，并明确列出重放所需的分析与模型软件 implementation。manifest 与研究包记录应用、模型、参数集、数据、两类哈希、拆分、计划、算法、边界、停止条件、随机种子、失败候选、收敛、指标、残差、能力等级和警告。

## 数据获取与复现命令

重新获取并验证 Figshare 原始文件：

```bash
npm run data:acquire:figshare
```

从已验证 XLSX 确定性提取标准化数据：

```bash
npm run data:extract:figshare
```

审计注册表、许可证、哈希和内置数据：

```bash
npm run audit:data
```

运行检查、构建与发布审计：

```bash
npm run check
npm run build
npm run audit:release
npm run check:reproducible
npm run example:research
```

发布构建包含标准化数据、数据卡、校验和与 schema，但明确排除 `data/raw/` 和所有 `.xlsx` 原始工作簿。

## 已知限制

- 数据为 OD600，不是 CFU/mL；
- 原始 OD600 未扣空白；
- 源数据没有 `t = 0`；
- 培养基 `Cond00003` 与当前补充 M9 目标不同；
- 承载量固定，绝对 CFU 尺度不可由该数据识别；
- 数据不含抗生素处理，不能推断三种药物的效应；
- 当前药物参数仍是 CAB1/LB 到 BW25113/M9 目标的转移校准；
- 孔/板独立性记录不足，不具备 L4 资格；
- 参数区间是探索范围，不是统计置信区间；
- 两个生物参数可能强相关，必须查看可识别性警告；
- 当前工作流只支持这一精确、经过哈希验证的内置数据合约；泛型导入可质控、保存和导出，但不能自动启动该工作流。
