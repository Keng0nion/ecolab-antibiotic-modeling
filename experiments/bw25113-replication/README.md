# BW25113 Cond00003 生长参数复现实验 / Growth-parameter replication experiment

## 中文

### 这个实验做什么

用项目自带的真实数据（Aida & Ying 2025，Figshare CC BY 4.0）做一次「小型复现实验」：从 12 条已发布的 BW25113 OD600 生长曲线出发，独立重算作者公布的**最大生长速率 r** 与**承载量 K**，与作者自己的数值逐条比较；再把 r 换算为倍增时间，与权威文献锚点（BioNumbers 111767；Campos et al. 2014，补加 M9 单细胞 42 ± 12 分钟）做对照。实验报告按 IB IA 格式撰写，见 `report/bw25113-replication-report.pdf`。

### 数据来源与许可（全部为真实已发表数据）

1. 项目内置归一化数据集：`data/datasets/figshare-bw25113-growth-v1/`（仓库内，SHA-256 `67b5fc27…f03817`）。
2. Figshare 数据集 28342064（CC BY 4.0）的三个原始工作簿，存放于 `data/`：
   - `BW25113_GrowthDataEvaluation.xlsx`：作者计算的 K 与 r（对照值来源），SHA-256 `2ae299c0…3b1`；
   - `BW25113_Growth_Round01.xlsx`：Round 01 原始 OD600 记录（含 36 个不生长对照孔的背景证据），SHA-256 `d81c738f…921`；
   - `BW25113_Medium_composition.xlsx`：曲线与培养基组成映射，SHA-256 `e3d82236…cdd`。
   - 工作簿由 `extract-reference.py` 在读取前逐字节校验哈希；`.xlsx` 按仓库 `.gitignore` 惯例属于本地溯源输入。
3. 文献锚点：BioNumbers 111767 / Campos et al. (2014)，`Cell` 159:1433，补加 M9 单细胞倍增时间 42 ± 12 分钟（统计含义未核实，报告中有明确声明）。

### 目录结构

```
extract-reference.py    对照值与背景证据提取（Python + openpyxl）
run-experiment.js       主实验（Node ESM，使用项目科学核心与项目种子 RNG）
make-figures.py         四张报告图（matplotlib）
report/                 报告源码（report.source.html）、填充版（report.html）、成品 PDF
report/build-report.py  报告构建（分阶段：--fill / --toc / --stamp）
data/                   三个 Figshare 工作簿（本地溯源输入）
derived/                结果（results.json、per-curve.csv、reference-values.json、background-evidence.json）
figures/                四张 200 dpi 图
```

### 复现步骤

```bash
python3 extract-reference.py        # 校验哈希 → 提取对照 K/r 与背景证据
node run-experiment.js              # 三背景情景复现 + 稳健变体 + 种子 bootstrap（确定性）
python3 make-figures.py             # 重新生成四张图
```

报告重建（浏览器渲染由外部命令执行，构建脚本本体不启动任何子进程）：

```bash
python3 report/build-report.py --fill
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-first-run --no-pdf-header-footer --user-data-dir=/tmp/ecolab-report-chrome \
  --print-to-pdf="$PWD/report/draft.pdf" "file://$PWD/report/report.html"
python3 report/build-report.py --toc
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --no-first-run --no-pdf-header-footer --user-data-dir=/tmp/ecolab-report-chrome \
  --print-to-pdf="$PWD/report/bw25113-replication-report.pdf" "file://$PWD/report/report.html"
python3 report/build-report.py --stamp
```

### 关键结果（详见报告与 `derived/results.json`）

- **K 复现**：12 井平均绝对相对偏差 0.77 %（最大 2.5 %），对背景情景不敏感。
- **r 字面复现失败**：平均绝对相对偏差 38.6 %，两井坍缩为 0；机制是 0.001 OD 量化在低信号区产生的单步闪烁（斜率可达 1.39 h⁻¹）。
- **r 稳健变体**：滑窗均值最大读法偏差降到 13.8 %（最大 20.2 %）。
- **中升段速率**：倍增时间 70.5 分钟（种子 bootstrap 95 % CI 68.6–72.4）。
- **与文献对照**：作者 r 隐含 33.7 ± 3.0 分钟，稳健暂态读法 39.0 ± 1.8 分钟，均落在锚点带上沿附近；中升段均值明显更慢。

### 边界

本实验是对已发表数据的独立再分析，不构成新的湿实验验证；OD600 不是 CFU，不得用于抗生素效应或 M9 匹配验证的推断（沿用数据集文档的 use 限制）。文献锚点为单细胞异培养基测量，报告中按「尺度一致」而非「精确验证」表述。

---

## English

A small replication study inside the Ecolab workspace: recompute the published maximum growth rate r and carrying capacity K for the twelve released Cond00003 curves of *E. coli* BW25113 (Aida & Ying 2025, figshare 28342064, CC BY 4.0), compare against the authors' own deposited values, and place the implied doubling times against the literature anchor (BioNumbers 111767 / Campos et al. 2014; 42 ± 12 min, supplemented M9, single cell). Result summary: K replicates to 0.77 % mean absolute relative deviation; the literal r definition does not replicate (38.6 %, quantization-driven collapses); a stabilized reading recovers it to 13.8 %; the resolved middle of the rise gives 70.5 min (95 % CI 68.6–72.4). The IA format report is `report/bw25113-replication-report.pdf`. All steps are deterministic and rerunnable with the commands above; the three figshare workbooks are local provenance inputs checked by SHA-256 before use.
