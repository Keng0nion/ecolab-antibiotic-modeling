# Figshare BW25113 growth baseline v1 / Figshare BW25113 生长基线 v1

## English

### Identity and attribution

- Dataset ID/version: `figshare-bw25113-growth-v1@1.0.0`
- Normalized files: `figshare-bw25113-growth-v1.json` and `figshare-bw25113-growth-v1.csv`
- Source: Aida, Honoka; Ying, Bei-Wen (2025), “Bacterial growth profiles across one-thousand chemical-defined media,” Figshare Dataset, https://doi.org/10.6084/m9.figshare.28342064.v1
- Related article: Aida H, Ying B-W, “Population Dynamics of Escherichia coli Growing under Chemically Defined Media,” Scientific Data, https://doi.org/10.1038/s41597-025-05356-3
- Data license: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- Attribution requirement: retain the source authors, dataset title, DOI, and license notice when redistributing or adapting these data.

### Admitted data

This bundle contains 12 complete untreated OD600 well trajectories from `BW25113_Growth_Round01.xlsx`, `Sheet1`: `Curve00025` through `Curve00036`. Each trajectory has the 44 observed times from 0.5 through 22.0 hours at 30-minute intervals, for 528 observations total. `Curve00025`–`Curve00032` are training units (352 observations); `Curve00033`–`Curve00036` are validation units (176 observations). A whole well/curve is assigned to only one role.

The composition and evaluation workbooks were joined by exact `Label` and checked for matching `Assay ID` and `Condition ID`. Every admitted curve is `Cond00003`, has source `K_info = 0` and `r_info = 0`, and has `K2HPO4 = 61.5 mM`.

### Experimental conditions

- Organism/strain: *Escherichia coli* BW25113
- Medium: chemically defined `Cond00003`; full composition below
- Temperature: 37 °C
- Format/volume: 96-well plate, 200 µL
- Shaking: 567 rpm
- Inoculation: 1:1000
- Reader: Epoch2 plate reader
- Sampling: 30 minutes; the first available point is 0.5 h
- Treatment: untreated; `drugId = none`, `concentrationMgPerL = 0`
- Measurement: raw, unblanked OD600; no blank correction and no OD-to-CFU conversion were applied

### Full source composition

The source workbook spelling is retained exactly in `sourceHeader`, including the apparent `ZuSO4` typo; it is not silently changed to `ZnSO4`.

| Source header | Concentration (mM) |
|---|---:|
| `K2HPO4\r\n(mM)` | 61.5 |
| `KH2PO4\r\n(mM)` | 22 |
| `Na2HPO4\r\n(mM)` | 42.3 |
| `Glucose\r\n(mM)` | 2 |
| `(NH4)2SO4\r\n(mM)` | 1 |
| `NH4Cl\r\n(mM)` | 1 |
| `Alanine\r\n(mM)` | 0.02 |
| `Arginine/HCl\r\n(mM)` | 0.02 |
| `Asparagine/H2O\r\n(mM)` | 0.02 |
| `AsparticAcid\r\n(mM)` | 0.02 |
| `Cystine/HCl/H2O\r\n(mM)` | 0.02 |
| `GlutamicAcid/HCl\r\n(mM)` | 0.02 |
| `Glutamine\r\n(mM)` | 0.02 |
| `Glycine\r\n(mM)` | 0.02 |
| `Histidine/HCl/H2O\r\n(mM)` | 0.02 |
| `Isoleucine\r\n(mM)` | 0.02 |
| `Leucine\r\n(mM)` | 0.02 |
| `Lysine/HCl\r\n(mM)` | 0.02 |
| `Methionine\r\n(mM)` | 0.02 |
| `Phenylalanine\r\n(mM)` | 0.02 |
| `Proline\r\n(mM)` | 0.02 |
| `Serine\r\n(mM)` | 0.02 |
| `Threonine\r\n(mM)` | 0.02 |
| `Tryptophan\r\n(mM)` | 0.02 |
| `Tyrosine\r\n(mM)` | 0.01 |
| `Valine\r\n(mM)` | 0.02 |
| `KCl\r\n(mM)` | 0.2 |
| `NaCl\r\n(mM)` | 0.1 |
| `MgSO4/7H2O\r\n(mM)` | 0.1 |
| `MgCl2/6H2O\r\n(mM)` | 0.1 |
| `CaCl2/2H2O\r\n(mM)` | 0.01 |
| `CaSO4/2H2O\r\n(mM)` | 0.005 |
| `Na3C6H5O7/2H2O\r\n(mM)` | 0.02 |
| `Na2S2O3/5H2O\r\n(mM)` | 0.5 |
| `FeSO4/7H2O\r\n(mM)` | 0.0005 |
| `CuSO4/5H2O\r\n(mM)` | 0.00001 |
| `Na2MoO4/2H2O\r\n(mM)` | 0.001 |
| `ZuSO4/7H2O\r\n(mM)` | 0.0001 |
| `Thiamine/HCl\r\n(mM)` | 0.001 |
| `Pyridoxine\r\n(mM)` | 0.002 |
| `FolicAcid\r\n(mM)` | 0.00005 |
| `Riboflavin\r\n(mM)` | 0.0005 |
| `H3BO3\r\n(mM)` | 0.008 |
| `AminobenzoicAcid\r\n(mM)` | 0.001 |

### Transformation history

1. Verify each original XLSX by exact byte count, MD5, and SHA-256.
2. Read XLSX ZIP/XML using the repository’s Node-built-in-only reader.
3. Select `Sheet1`, times 0.5–22.0 h, and labels `Curve00025`–`Curve00036`.
4. Join composition and evaluation rows by exact label and verify assay/condition identifiers and source quality flags.
5. Parse each numeric OD cell directly from its cached worksheet token; perform no subtraction, blank correction, smoothing, interpolation, unit conversion, or OD-to-CFU model.
6. Assign complete trajectories to training or validation and serialize deterministic JSON/CSV.

Normalized JSON SHA-256: `67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817`  
Normalized CSV SHA-256: `03e137484b717970cd4cc47be88c52224e08cbb0713b7d6b4456b91c63985188`

### Intended and prohibited interpretations

Allowed uses include testing OD600 import/admission code, developing an explicit OD observation model, and analyzing untreated BW25113 growth under this exact medium with attribution. Do not use this bundle as direct CFU/mL observations, as evidence of antibiotic effects, as matched M9-medium validation, or as independent validation of the current CFU-based model without an explicit OD-to-model observation layer.

### Known limitations

- OD600 is not CFU/mL.
- Source OD values are raw and unblanked; no blank wells were inferred or subtracted.
- A `t = 0` observation is absent; the first admitted point is 0.5 h.
- Independence among wells and plate identity are not fully documented in the admitted source tables.
- Changing K2HPO4 can affect buffering, pH, and osmolality, not only a single nutrient axis.
- These are untreated curves and provide no evidence about antibiotic effects.
- The strain matches the current BW25113 growth baseline, but the chemically defined medium differs from the current model’s M9 target, and OD600 is incompatible with direct CFU observation without an explicit model.

## 中文

### 身份与署名

- 数据集 ID/版本：`figshare-bw25113-growth-v1@1.0.0`
- 标准化文件：`figshare-bw25113-growth-v1.json` 与 `figshare-bw25113-growth-v1.csv`
- 来源：Aida, Honoka；Ying, Bei-Wen（2025），《Bacterial growth profiles across one-thousand chemical-defined media》，Figshare 数据集，https://doi.org/10.6084/m9.figshare.28342064.v1
- 相关文章：Aida H, Ying B-W，《Population Dynamics of Escherichia coli Growing under Chemically Defined Media》，Scientific Data，https://doi.org/10.1038/s41597-025-05356-3
- 数据许可：CC BY 4.0，https://creativecommons.org/licenses/by/4.0/
- 再分发或改编时必须保留作者、数据集标题、DOI 与许可声明。

### 纳入的数据

本数据包从 `BW25113_Growth_Round01.xlsx` 的 `Sheet1` 纳入 12 条完整的未处理 OD600 孔轨迹：`Curve00025` 至 `Curve00036`。每条轨迹包含 0.5 至 22.0 小时、间隔 30 分钟的 44 个观测点，共 528 个观测。`Curve00025`–`Curve00032` 为训练单元（352 个观测），`Curve00033`–`Curve00036` 为验证单元（176 个观测）；同一孔/曲线不会跨集合拆分。

培养基组成表和评价表按精确的 `Label` 连接，并核对 `Assay ID` 与 `Condition ID`。全部曲线均为 `Cond00003`，源字段 `K_info = 0`、`r_info = 0`，且 `K2HPO4 = 61.5 mM`。

### 实验条件与处理

菌株为 *Escherichia coli* BW25113；化学成分明确的 `Cond00003` 培养基；37 °C；96 孔板；200 µL；567 rpm；1:1000 接种；Epoch2 酶标仪；每 30 分钟采样；未使用抗生素。标准化数据保持 `drugId = none`、浓度 0、`measurementType = od600`。原始 OD 未扣空白，未推断空白孔，也未进行任何 OD 到 CFU 的换算。

完整培养基组成见上表。源表中的拼写（包括疑似笔误 `ZuSO4`）被原样保留，没有静默改成 `ZnSO4`。

### 转换历史

1. 按字节数、MD5 和 SHA-256 精确校验三个原始 XLSX。
2. 仅使用 Node 内置模块解析 XLSX 的 ZIP/XML。
3. 精确选择工作表、时间范围和曲线标签。
4. 按标签连接并核验组成表、评价表和质量标志。
5. 直接解析工作表缓存的数值；不扣空白、不平滑、不插值、不换单位、不进行 OD→CFU 建模。
6. 按完整轨迹划分训练/验证，并确定性写出 JSON/CSV。

### 允许用途、禁止用途与局限

可用于验证 OD600 数据导入流程、开发明确的 OD 观测模型，以及在署名条件下分析该精确培养基中的未处理 BW25113 生长。不得把这些数值直接当作 CFU/mL，不得据此声称抗生素效应，不得视为匹配 M9 条件的数据，也不得在缺少明确 OD 观测模型时声称其独立验证当前基于 CFU 的模型。

局限包括：OD600 不等于 CFU；原始 OD 未扣空白；没有 `t=0`；孔间独立性和板身份记录不完整；K2HPO4 变化会同时影响缓冲、pH 与渗透压；数据不含抗生素处理。菌株与当前 BW25113 生长基线一致，但培养基不同，测量尺度也不兼容直接观测。
