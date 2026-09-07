# Ecolab 6.0.0 更新说明 / Release notes

日期：2026-09-07。应用 `6.0.0`，分析引擎 `2.0.0`；教学科学核心 `2.0.0`、模型 `1.0.0` 保持不变。

本次采用分层升级方案：保留三药教学模型和历史数据，修复数值与工程问题，为真实数据工作区增加论文支持的 OD 曲线比较、训练交叉验证、联合重采样与可核对的同版复算。**这是软件能力与证据表达的升级，不是已经完成三药实验验证或证明预测精度提高。**

## 1. 这次更新解决了什么

此前项目已具备教学模拟和研究工作区，但需要进一步保证：

- 优化预算耗尽时仍返回正确的最佳已评价点，而不是丢失最后一次改进。
- 敏感性结果的单位、步长、配对关系及采样精度能够被正确解释。
- 已查看的数据不再被描述为未触碰的验证集。
- 存储失败、恢复错配和版本冲突不会被成功状态掩盖。
- 研究包通过哈希检查不被等同于科学结论已经复现。
- 项目介绍能够给出实际方程、参数、论文、公开数据和真实结果，而不作超出证据的归因。

本版围绕这些问题补齐实现、回归测试、浏览器集成和文档，而不是重写教学动力学或引入新的生物机制。

## 2. 保留教学模型，补齐方法与参数来源

教学沙盒继续支持氨苄西林、四环素、环丙沙星的单药、分段恒定浓度协议。模型将 Regoes 浓度–净增长函数与分段种群动力学组合：

```text
q(C) = (C/zMIC)^κ
ψ(C) = ψmax - (ψmax-ψmin) × q(C)/(q(C)-ψmin/ψmax)
ψ(C)>0: dN/dt = ln(10) × ψ(C) × N × (1-N/K)
ψ(C)≤0: d log10(N)/dt = ψ(C)
```

三药参数 `(zMIC mg/L, κ, ψmin log10-fold/h)`：

- 氨苄西林：`(3.4, 0.75, -4)`。
- 四环素：`(0.67, 0.61, -8.1)`。
- 环丙沙星：`(0.017, 1.1, -6.5)`。

药效参数引用 [Regoes et al. (2004), Table 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC521919/) 的 **CAB1/LB** 条件，迁移到项目目标时明确标记跨条件使用，不声称在 BW25113/M9 下完成匹配验证。`K=10^9 CFU/mL` 是教学假设。注册表保留单位、来源定位、版本和条件匹配状态。

完整推导、基线增长参数、来源差异及源码入口见 [方法与证据](./research-method-evidence.md)。

## 3. 新增真实 OD 增长曲线比较

新增 [`growth-comparison.js`](../src/analysis/growth-comparison.js)，由 [`research-upgrade.js`](../src/analysis/research-upgrade.js) 接入版本化工作流。

### 三个候选与统一评价流程

- 精确观测时间上的训练均值基线 `training_mean`。
- 直接 OD 尺度 Logistic：`b + A / (1 + exp(-r × (t-ti)))`。
- 直接 OD 尺度 Gompertz：`b + A × exp(-exp(-r × (t-ti)))`。

增长曲线比较参考 [Zwietering et al. (1990)](https://doi.org/10.1128/aem.56.6.1875-1881.1990)，但明确采用 OD 尺度的经验改写，不把形状系数 `r` 或拐点 `ti` 冒充原论文的生理比增长率和延滞期。OD 也不直接转换成 CFU。

### 拟合、选模与不确定性

- 有界 Differential Evolution → Nelder–Mead；记录评价预算、停止原因、最佳点及收敛标志。
- 新 OD 模型最小化平均轨迹 MSE，避免不同长度曲线获得隐含不等权重。
- 只在训练数据上进行整轨迹交叉验证；当前示例为 8 折留一曲线，不随机拆散同一曲线的时间点。
- 按 out-of-fold 每轨迹 RMSE 的均值选择候选；最低分绝对容差 `1e-10` 内优先均值基线，再 Logistic，再 Gompertz。
- 在全部训练轨迹上完成拟合并冻结后，才评价已查看开发曲线。
- 对完整训练轨迹有放回重采样，重拟合已选模型，保留联合参数样本、均值曲线、失败与收敛诊断。
- 区间明确是条件性的探索结果，不包含选模不确定性或新观测噪声；曲线独立性尚未得到确认。

## 4. 修复数值和统计解释问题

### 优化器

Nelder–Mead 在评价预算耗尽前若已找到更优点，仍保留该点。达到预算上限不自动标记为收敛。

### Morris 与 Sobol–Jansen

- Morris 使用单位超立方体上的归一化步长，检查网格兼容性；仅一条轨迹时样本标准差为 `null`，而不是误报零不确定性。
- Sobol–Jansen 的 bootstrap 同时重采样 A、B 和混合矩阵的对应行，避免破坏估计所需的配对关系。
- 保留原始有限指数及区间；负指数、`S1>ST` 和精度不足会产生警告，不通过裁剪或重排掩盖。
- 对 bootstrap 次数及运算量设置明确上限，超预算拒绝执行。

### 可识别性

- 将当前实现命名为干扰参数剖面化的目标函数切片，不再将其解释为完整 profile likelihood 或把扫描端点当作置信限。
- 秩亏时协方差为 `null`；伪逆仅保留为几何诊断。
- 分开报告 `completed`、`converged`、`identified`、`precisionAssessed`，避免把流程完成等同于拟合与推断成功。

方法引用与实现细节见 [敏感性、不确定性及可识别性说明](./research-method-evidence.md)。

## 5. 浏览器工作区与本地存储

- 保留中英文 Learn / Sandbox 与 Research Workspace，不新增第三方运行时依赖。
- 新分析与复算接入真实 Web Worker，支持取消；取消不破坏已有结果。
- IndexedDB 初始化不可用、阻塞或超时时，明确说明易失内存降级及原因。
- 已启用持久化后的运行时配额失败明确报错，不静默改存内存后声称保存成功。
- 内存和 IndexedDB 仓库保留 revision 冲突语义；恢复研究结果时同时匹配数据 `id + revision + contentHash`。
- 独立 CSV 导出即使尚未进行分析，也会披露已查看开发集的角色；通用来源不会自动继承 Figshare 署名或结论。

用户分析数据不上传计算服务器。静态网站首次加载仍访问托管站点，浏览器本地存储也不等于永久备份；重要工作应导出研究包。

## 6. 研究包：完整性检查与显式复算分开

新增 [`research-replay.js`](../src/analysis/research-replay.js)：

- 研究包记录源文本与 SHA-256、拆分、解析模型快照、算法版本、参数边界、完整计算设置、随机种子和科学输出。
- 严格检查 JSON、包清单、制品哈希、输入关联、重复 ID、不安全路径、体积限制及版本兼容性。
- 导入只检查，不自动计算、不执行导入代码，也不联网获取依赖。
- 精确兼容的内置实现才允许显式 Worker 复算；缺少完整输入的历史包仅供检查查看。
- 复算同时比较科学投影与**完整分析清单**，返回精确差异路径。

独立审查发现并修复了一项重要问题：只修改分析清单中的收敛结论或开发误差、然后重新计算该清单哈希，原先可能仍得到匹配结果。现在这类包可以通过结构检查并允许尝试复算，但复算会报告不匹配。`replayable` 只表示可尝试，不能等同于 `matched`；哈希本身也不证明来源真实。

## 7. 真实数据与实际结果

来源为 [Aida / Ying (2025) Figshare 数据](https://doi.org/10.6084/m9.figshare.28342064.v1)，许可 `CC BY 4.0`。当前准入范围为 BW25113、无药、`Cond00003`、未扣空白 OD600，共 **12 条曲线、528 个观测**：训练 8 条 / 352 点，已查看开发比较 4 条 / 176 点。源文件中的 `validation` 标签保留用于追溯，但不再解释为未触碰或外部验证。

固定 `small` 预算、根种子 `123456789` 的实际结果：

- 训练 8 折 CV macro RMSE：均值基线 **0.00384827**，Logistic **0.01488944**，Gompertz **0.01766475**。
- 当前规则选中均值基线；两个参数化 OD 候选均为 **0/8 折报告收敛**，不能据此断言充分优化后的参数模型必然更差。
- 冻结选中模型的开发 macro RMSE **0.00304756 OD**，pooled RMSE **0.00318059 OD**，MAE **0.00239205 OD**；相对基线差值为零。
- 原潜在种群模型的开发 macro RMSE **0.00833386 OD**，相对基线差值 **+0.00528629 OD**；160 次评价后达到预算上限，未收敛。
- Morris 在其声明的完整参数范围内观察到 `log10(N0)` 的 `μ*` 最大，为 **0.11151688**，但只有两条轨迹。
- Sobol 在不同的局部三角输入范围内观察到 `ψmax` 的指数最大，但基础样本只有 8，且出现 `S1>ST`；不支持稳健的全局排名。
- 整轨迹 bootstrap **20/20** 成功，但 95% 区间尾部分辨率不足；选中无参数基线时参数区间为空，均值曲线区间仍存在。

整体状态为流程完成、优化未收敛、参数识别与统计精度未确立。上述结果不应改写为“新模型提升预测效果”或“三药验证成功”。完整精度值与计算工件见 [自动生成的 6.0.0 示例](../data/examples/ecolab-stage6-research-6.0.0.md)。

## 8. 兼容性与使用注意

- 应用升级为 `6.0.0`，分析实现为 `ecolab-research-analysis-v2@2.0.0`；稳定分析 ID 仍为 `ecolab.stage4.analysis`。
- 教学核心与模型版本不变；原始数据、规范数据及历史 `5.0.0` 示例不覆盖。
- 旧结果不冒充本版分析；只有精确兼容、输入完整的研究包才可复算。
- 生成的示例 JSON 是 wrapper，浏览器导入应使用其中的 `researchPackage`，不是整个 wrapper。浏览器自己导出的研究包可直接走导入流程。
- Node.js 要求 `>=20.19.0`。公开仓库可使用 `npm run build:public`；本地完整 `npm run build` 还需要原始数据审计输入，原始 XLSX 不随公开仓库上传。
- GitHub Pages 不应用 `_headers` 文件，因此不声称 Pages 已部署其中的自定义安全响应头。

## 9. 验证与发布范围

本地最终验证（完整命令及阶段记录见 [发布检查表](./release-checklist.md)）：

- `npm test`：**500/500** 通过。
- `npm run build` 和 `npm run build:public`：通过；发布测试 **59/59**。
- 两次干净构建：**157 个文件逐字节一致**。
- 新产物真实 Chromium 工作流：**24/24** 检查通过，包括正常复算、仅重哈希清单的负向包、独立 CSV 披露、刷新恢复、取消和存储降级。
- 发布审计：示例严格检查和复算匹配；Core **7.14 MiB**、Web **7.55 MiB**，最大静态文件 **4.10 MiB**，未提高大小预算。
- 历史两个示例 SHA-256 与升级前相同。

2026-09-07，用户在本地升级验证完成后明确授权提交并上传已有 GitHub 仓库。发布目标是现有 `main`，不强制推送或重写历史；现有 [Pages workflow](../.github/workflows/deploy-pages.yml) 会在推送后运行公开构建并部署。具体提交及部署结论以 [GitHub 提交记录](https://github.com/Keng0nion/ecolab-antibiotic-modeling/commits/main/) 和 [Actions 记录](https://github.com/Keng0nion/ecolab-antibiotic-modeling/actions/workflows/deploy-pages.yml) 为准；本地测试记录不替代远端成功状态。

源码、测试、文档与带许可的规范数据/示例进入仓库；`data/raw/`、XLSX、`tmp/` 浏览器证据、编辑器状态、凭据和生成的 `dist/` 不进入 Git 提交。Pages 由 workflow 单独构建发布静态产物。

## 10. 仍未完成的验证与明确不支持的结论

- 人工 Chrome / Firefox / Safari 工作流、键盘、窄屏与读屏矩阵，以及启动/交互/网络 P95 测量。
- 条件匹配、具有独立实验重复的三药药效验证；当前无药 OD 数据不能替代这类证据。
- 充分预算的参数收敛、可靠置信覆盖率和稳健敏感性排名。
- 临床决策、耐药进化、持留亚群、联合用药和人体药代推断。

[项目介绍草稿](./portfolio-case-study.md) 已补齐方法、参数、来源与真实结果；个人历史贡献仍需作者按实际分工确认，公开数据与论文模型不应归为个人原创。

## English summary

Ecolab 6.0.0 preserves the referenced teaching model and upgrades the research engine to 2.0.0. It adds empirical direct-OD Logistic/Gompertz comparison, whole-training-trajectory CV and joint bootstrap; fixes optimization, sensitivity, identifiability and local-persistence defects; and supports strict package inspection plus explicit exact-version replay of both scientific output and the complete analysis manifest.

The deterministic small example selects the training-mean baseline. Development macro RMSE is 0.00304756 OD, versus 0.00833386 OD for the nonconverged legacy calibration. Previously viewed data remain development-only, and untreated OD600 does not validate antibiotic effects. Local software checks passed; remote publication is tracked separately in GitHub Actions. Manual cross-browser/accessibility/performance work and independent experimental validation remain outstanding.
