# 真实数据候选与准入审查

审核更新：2026-08-21

## 结论

第 4 步选择并内置了一个许可明确、可直接下载、可校验且能确定性提取的真实数据集：

```text
DOI: 10.6084/m9.figshare.28342064.v1
Title: Bacterial growth profiles across one-thousand chemical-defined media
Authors: Honoka Aida, Bei-Wen Ying
License: CC-BY-4.0
Article DOI: 10.1038/s41597-025-05356-3
```

内置数据支持 BW25113 在精确 `Cond00003` 条件下的未处理 OD600 分析、导入/QC 测试和显式 OD 观测层开发。它**不支持**：

- 把 OD600 当作 CFU/mL；
- 声称匹配当前补充 M9 目标；
- 推断任何抗生素效应；
- 声称当前 CFU 模型已得到直接独立验证；
- 在孔/板独立性记录不足时授予 L4。

## 已准入的 Figshare 数据

### 身份与许可

- 数据集稳定 ID：`figshare-bw25113-growth-v1@1.0.0`
- Figshare DOI：<https://doi.org/10.6084/m9.figshare.28342064.v1>
- 相关文章 DOI：<https://doi.org/10.1038/s41597-025-05356-3>
- 作者：Honoka Aida、Bei-Wen Ying
- 许可证：Creative Commons Attribution 4.0 International
- 许可 URL：<https://creativecommons.org/licenses/by/4.0/>
- 再分发状态：允许在署名条件下再分发与改编
- 署名文本保存在 `data/datasets/figshare-bw25113-growth-v1/checksums.json` 和数据卡中

### 原始文件与校验和

原始文件保存在本地复现目录：

```text
data/raw/figshare-bw25113-growth-v1/
```

| 文件 | SHA-256 |
|---|---|
| `BW25113_Growth_Round01.xlsx` | `d81c738fdf7885195203de9b8b28bc221cf81992dffe1288c42b81aa6876d921` |
| `BW25113_Medium composition.xlsx` | `e3d82236c0f9a65cff55bebf1d5478b15a0972111422c32a3395deb5c5509cdd` |
| `BW25113_GrowthDataEvaluation.xlsx` | `2ae299c04f6a4de7401d3896413030db050b28691764be7940da471f351e03b1` |

发布构建明确排除 `data/raw/` 和 `.xlsx`；程序内只分发标准化数据、数据卡和校验和。

### 提取子集

从 `BW25113_Growth_Round01.xlsx` 的 `Sheet1` 纳入：

- `Curve00025`–`Curve00036`；
- 12 条完整轨迹；
- 0.5–22.0 h；
- 30 分钟间隔；
- 每条 44 个观测；
- 共 528 个观测。

完整轨迹拆分：

```text
training:   Curve00025–Curve00032
validation: Curve00033–Curve00036
```

统计：

- 训练：8 个单元、352 个观测；
- 验证：4 个单元、176 个观测；
- 禁止按行随机拆分同一轨迹。

### 实验条件

- 生物种：*Escherichia coli*
- 菌株：BW25113
- 处理：未处理，无抗生素
- 培养基：化学定义 `Cond00003`
- K₂HPO₄：61.5 mM
- 温度：37 °C
- 容器：96 孔板
- 体积：200 µL
- 振荡：567 rpm
- 接种：1:1000
- 仪器：Epoch2 plate reader
- 测量：原始、未扣空白 OD600
- 首个源时间：0.5 h；没有源 `t = 0`

源工作簿拼写 `ZuSO4` 被原样保留；它可能是笔误，但提取流程不会静默改成 `ZnSO4`。

### 标准化产物

```text
data/datasets/figshare-bw25113-growth-v1/
├── figshare-bw25113-growth-v1.json
├── figshare-bw25113-growth-v1.csv
├── README.md
└── checksums.json
```

标准化 JSON SHA-256：

```text
67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817
```

标准化 CSV SHA-256：

```text
03e137484b717970cd4cc47be88c52224e08cbb0713b7d6b4456b91c63985188
```

### 获取与提取方法

- 获取脚本：`scripts/acquire-figshare-bw25113.js`
- 提取脚本：`scripts/extract-figshare-bw25113.js`
- XLSX 读取器：`scripts/lib/xlsx-reader.js`

读取器只使用 Node 内置模块处理 ZIP central directory、deflate、XML 和 shared strings，没有引入外部 XLSX 依赖。

复现命令：

```bash
npm run data:acquire:figshare
npm run data:extract:figshare
npm run audit:data
```

提取过程：

1. 按字节数、MD5 和 SHA-256 验证原始文件；
2. 读取精确工作表与缓存数值；
3. 按 `Label` 连接生长、培养基组成和评价表；
4. 核对 `Assay ID`、`Condition ID`、`K_info`、`r_info` 和 K₂HPO₄；
5. 不扣空白、不平滑、不插值、不制造 `t = 0`、不进行 OD→CFU 换算；
6. 按完整曲线赋予训练/验证角色；
7. 确定性写出 JSON、CSV、数据卡和校验和。

## 允许用途

- 在保留 CC BY 4.0 署名的前提下进行数据导入和准入测试；
- 分析该精确 `Cond00003` 条件下的未处理 BW25113 OD600 轨迹；
- 开发、测试或展示明确的 OD600 观测模型；
- 在训练数据上拟合预声明的无药生物参数并报告诊断；
- 执行形式上锁定、无泄漏、未触碰的留出评价，同时明确它不具备 L4 证据资格。

## 禁止用途与条件不匹配

### OD600 不是 CFU/mL

源数据没有 OD–CFU 校准。程序保留 `measurementType = od600`，并使用显式观测层：

```text
OD600 = baselineOd + scaleOd × (N/K)
```

该层的干扰参数只在训练数据上剖面化，但不能由此声称得到了普适的绝对 CFU 转换。

### 培养基不匹配

菌株与当前 BW25113 生长目标一致，但 `Cond00003` 不等于当前参数集的补充 M9：

```text
M9 salts + 0.1% casamino acids + 0.2% glucose
```

因此条件状态必须保留为培养基不匹配，不能称为条件匹配验证。

### 没有抗生素证据

全部轨迹为：

```text
drugId = none
concentrationMgPerL = 0
```

不能用它们拟合或验证氨苄西林、四环素、环丙沙星的 `zMIC`、`kappa` 或 `psiMin`。

### 独立性记录不足

训练和验证确实按完整曲线标签分开，验证值没有参与拟合或观测层剖面化。但准入表没有充分记录：

- 孔之间是否可作为生物学独立单元；
- 曲线是否来自同一或不同板；
- 板身份和层级结构。

所以当前运行只能达到 L3，不能以“留出集”名义自动升级为 L4。

## 为什么没有首先内置 Dryad 候选

曾审查：

```text
Dryad DOI: 10.5061/dryad.s1rn8pkb1
version: 6
license: CC0-1.0
reported file SHA-256: a0756e4b0af763b799dca3922c9b996e9b8fa1391450acaf400795da968f6b4c
```

元数据、许可证和文件列表可以核实，但自动化环境无法合法取得源归档：

- API 下载返回 401；
- 旧文件流返回 Anubis/WAF challenge HTML，而不是 ZIP；
- 返回内容约 4.3 KB，不能作为源数据；
- 项目没有尝试绕过或自动解决挑战。

因此不能声称 Dryad 数据已下载、验证或内置。Figshare 数据具有直接可下载、可独立校验、许可明确和可重复提取的优势，适合作为首个数据包。

## 其他仍保留的候选与来源

### Campos et al. 2014 / BioNumbers 111767

- DOI：<https://doi.org/10.1016/j.cell.2014.11.022>
- BioNumbers：<https://bionumbers.hms.harvard.edu/bionumber.aspx?id=111767>
- 菌株：BW25113
- 用途：补充 M9 无药最大增长率锚点
- 限制：单细胞稳态标量，不是批量 CFU/OD 时间序列

### Regoes et al. 2004

- DOI：<https://doi.org/10.1128/AAC.48.10.3670-3676.2004>
- 菌株：E. coli CAB1
- 条件：LB、37°C、200 rpm
- 用途：三种目标药物的转移药效参数
- 限制：菌株和培养基不匹配，底层可再分发时间序列许可未确认

### 后续候选

| 候选 | 潜在用途 | 当前状态 |
|---|---|---|
| Li et al. 2021 | BW25113 无药批量增长对照 | 方法、机器可读控制曲线与许可证仍需核实 |
| Otoupal et al. 2021 | BW25113 单药对照 | 需确认未扰动野生型、测量类型和许可 |
| Vaisbourd et al. 2025 | 现代浓度—效应数据 | 需确认 E. coli 菌株、三药覆盖和可复用文件 |
| Broughton et al. 2025 | ciprofloxacin/tetracycline 单药动态 | 需从组合实验中确认独立单药对照和许可 |

## 当前仍存在的证据缺口

- 没有同一菌株、同一培养基下覆盖无药增长和三种抗生素暴露的内置时间序列；
- 没有匹配当前补充 M9 目标的 OD/CFU 动态数据；
- 没有经过验证的 OD600→绝对 CFU/mL 转换；
- 当前承载量不能由内置 OD 数据识别；
- 当前孔/板独立性记录不足；
- 当前真实数据没有抗生素处理；
- 当前未获得独立来源外部验证数据；
- 当前药物参数仍是 CAB1/LB 转移校准。

这些限制必须随结果和导出保留，不能因为拟合按钮、漂亮图表或留出拆分而弱化。
