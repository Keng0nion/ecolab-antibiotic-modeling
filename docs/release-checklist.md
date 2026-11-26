# Ecolab release checklist / 发布检查表

## 6.1.0 fit-status and audit release / 拟合状态与审计版本

更新：2026-11-26；应用 `6.1.0`，分析 `2.1.0`，教学核心 `2.0.0`，教学模型 `1.0.0`。6.0.0 release record follows unchanged below.

- [x] Shared exact-observation gates cover censored-likelihood and OD least-squares fit entry points; local rank-deficient OD fits return status only.
- [x] Results record convergence, all boundary hits, σ lower-bound status and profile state; unassessed profiles are explicit.
- [x] Import readiness, status-only fit presentation, parameter boundary lists and result-linked exports are covered by Node view/export tests.
- [x] Current transferred parameter set records teaching-only purpose and research-fit ineligibility.
- [x] Foerster 2016 S1/S2 informative-row fixture records source, units and exclusions; Regoes algebraic regression tests run through the scientific model evaluator.
- [x] App / analysis versions advanced to `6.1.0` / `2.1.0`; 6.0.0 example bytes remain preserved and are referenced as historical.
- [x] Version compatibility contract: `schemas/analysis-run.schema.json` accepts analysis `2.1.0` while `1.0.0` / `2.0.0` manifests remain valid; replay input treats `preset` as optional so 6.0.0 packages stay inspect-only rather than invalid.
- [x] Current example regenerated as `data/examples/ecolab-stage6-research-6.1.0.{json,md}`; the four frozen 5.0.0 / 6.0.0 files kept their recorded SHA-256 before and after generation.
- [x] Focused checks, full Node suite, public build and real-browser import → fit → export → reload flow executed; observed results are recorded below.

### 6.1.0 已执行验证

本机 macOS（Darwin，Node `v22.22.2`）。验证期间主机存在与本任务无关的外部高负载（load average 6–20），因此测试墙钟时间明显长于空闲机器；所有断言未删减，超时预算只做环境性调整（见下）。

| 命令 | 实际结果 |
| --- | --- |
| `npm run check:syntax` | 通过（含新增 `src/cli/*`、`scripts/benchmarks/*`、`predictive-diagnostics.js`）。 |
| `npm run check:version` | 通过：应用 `6.1.0`、分析 `2.1.0` / `ecolab-research-analysis-v2`、教学核心 `2.0.0`、模型 `1.0.0`。 |
| `npm run audit:data` | 通过：1 model、1 parameter set、14 sources、7 dataset records、6 drug records。 |
| `npm run test:release` | **77/77 通过**，0 失败/取消/跳过，约 199 秒。 |
| `npm test` | **590/590 通过**，0 失败/取消/跳过，约 270 秒。 |
| `npm run build:public` | 通过：干净 Core/Web 构建与发布审计；示例严格包检查通过、科学回放匹配（abs=1e-10, rel=1e-8）；39 个 Markdown 文件链接检查通过；Core 7.29 MiB、Web 7.81 MiB，最大单文件 4.10 MiB。 |

- 示例生成确定性：连续两次 `npm run example:research` 产物字节一致；科学结果 canonical SHA-256 为 `1f261285e1d4d597451b33110c277f726f73eae36cfa56659ec1e34c5904d9c8`，preset `small`，根种子 `123456789`。
- 历史文件哈希（生成前后一致）：5.0.0 JSON `f3365e5c616597c042aa87eb76040b620955f4ea9e8865c77b83e5245acc41b8`；5.0.0 Markdown `05ca4c25a2327f81119ee7af609d2536c1ec7072f35a4532f32319406f416bbd`；6.0.0 JSON `f5929dae8d22c9b6bc6839abb19d5e92dfa458566e9dd31cb2f82175e5c1d41f`；6.0.0 Markdown `2b451d5bd26add57098e0a6a7eabcc2a531bd945b710dd104b735a12efec1527`。
- 本轮发现并修复的回归：工作区曾用 6.1.0 代码覆盖 6.0.0 示例，并把新字节写入发布审计的历史哈希；现已恢复 6.0.0 原始字节，审计与示例引用改为 HEAD 记录。CSV 导出的 `random_algorithm` 曾因读取不存在的 `runMetadata.randomAlgorithm` 而为空，现读取 `runMetadata.seeds.algorithm` 并由测试断言具体值。状态型结果（单时间点、秩亏）曾使 v2 工作流在缺少 `researchPackage` 时抛 `TypeError`，现按状态输出返回，不伪造比较。
- 超时预算调整（仅环境预算，未放宽断言）：发布审计测试 `120s → 600s`（隔离约 60 秒，主机高负载下约 126 秒）；浏览器 API 集成测试 `30s → 120s`（隔离约 12 秒，高负载并发下约 50 秒）。

### 6.1.0 浏览器记录

2026-11-26，agent-browser `0.33.0`（Chromium），服务 `dist/web` 于 `http://127.0.0.1:43118`；先执行 `agent-browser skills get core`。全流程在同一真实浏览器会话内完成：

- 导入：内置 BW25113 数据加载并校验 SHA-256 `67b5fc27…f03817`，528 观测 / 12 独立单元 / 0 错误，显示“精确合约 · 可运行”，一键锁定工作流启用。
- 拟合：`small` 预设、默认种子 `1582041777`；真实 Worker 完成运行，结果页显示“拟合未收敛 · 需复核”、轮廓似然“未评估”、贴边参数 0、σ 下界“—”；completed=true / converged=false / identified=false / precisionAssessed=false；训练 352 观测 / 8 单元，开发比较 176 / 4；终止原因 `maximum_evaluations`。
- 导出：完整结果 JSON 记录应用 `6.1.0`、种子 `1582041777`、`settings.preset="small"`、RNG `xoshiro128ss-splitmix32-v1`、`training.status=FIT_NOT_CONVERGED`、边界列表为空、`sigmaAtLowerBound=null`、profile `NOT_ASSESSED`；数据集 CSV 头部记录 `application_version: 6.1.0`、`random_seed: 1582041777`、`random_algorithm: xoshiro128ss-splitmix32-v1`、`fit_status: FIT_NOT_CONVERGED` 与完整 `run_settings_json`。
- 重开：刷新后恢复保存的数据集与分析记录（同一 runId，状态“已完成”，数据集引用 `figshare-bw25113-growth-v1@1.0.0 · r1`），结果状态标签与“打开结果”均可用；设计区默认值恢复为种子 `1582041777`、预设 `small`。
- 研究包导入：当前 6.1.0 包检查为“版本兼容 · 等待显式重放”，显式重放返回“重放匹配”并显示比较报告与预览指标；历史 6.0.0 包检查为“仅检查 · 不可重放”，原因 `UNSUPPORTED_SOFTWARE_VERSION` 与 `UNSUPPORTED_GROWTH_COMPARISON_IMPLEMENTATION`，重放按钮禁用。
- 控制台无错误；观察到的应用请求均为 `127.0.0.1`，仅有构建未包含的 `favicon.ico` 404。未执行跨浏览器、窄屏、读屏或性能 P95 矩阵。

更新：2026-09-07；本地 macOS，Node `v26.4.0`。这是本轮记录，不沿用历史 5.0.0 的 238 项测试数。

## 发布标识与范围

- [x] 应用 `6.0.0`：根 `package.json` 与 `src/app/version.js` 一致。
- [x] 分析 `2.0.0` / `ecolab-research-analysis-v2`；稳定 ID `ecolab.stage4.analysis` 不改名。
- [x] 教学核心 `2.0.0` / 模型 `1.0.0` 不变；原始数据和 5.0.0 工件不重写。
- [x] 不增加第三方运行时依赖；本地升级阶段没有提交、创建分支、推送或部署。完成验证后，用户于 2026-09-07 另行授权提交并上传现有 GitHub 仓库，见下方发布决定。

## 实现与科学声明

- [x] 修复存储状态/降级/冲突，恢复核对 dataset id + revision + contentHash，运行时配额失败明确报错。
- [x] 修复 NM 预算耗尽最佳点、Morris 归一化和单轨迹 σ、Sobol 配对 bootstrap 与资源上限。
- [x] 目标切片与真正 profile likelihood 分开；秩亏 covariance 为 null，伪逆不冒充参数不确定性。
- [x] 直接 OD Logistic/Gompertz、整训练曲线 CV、冻结开发比较、联合整曲线 bootstrap 及失败诊断已集成。
- [x] 安全 JSON/inventory/输入关联检查、显式同版回放、独立易失预览及取消已集成。
- [x] 独立审查发现“仅重哈希 manifest 可伪造 matched”，已加先失败后通过回归测试；回放现比较科学投影与完整 manifest。
- [x] 独立数据 CSV 的已查看开发集披露已做中英文回归修复，generic 来源不继承 Figshare 默认值。
- [x] 小预算实例如实保留基线获选、参数模型未收敛、非识别、采样精度不足和无药 OD 数据边界。
- [x] 方法论文、方程、单位、主要参数、真实结果和本人负责内容草稿已写入文档；个人历史分工仍需作者确认。

## 已执行验证

按执行顺序记录，避免把修复前通过冒充最终通过：

- 最后两项审查修复前：`npm test` **490/490 通过**，约 112 秒；`npm run audit:data` 通过，1 model / 1 parameter set / 11 sources / 7 dataset records / 4 drugs。
- CSV 修复：`node --test src/app/tests/research-export.test.js`，Red 18 通过 / 3 失败，Green **21/21 通过**。
- manifest 修复：`node --test --test-name-pattern='rehashed manifest science' src/analysis/tests/research-replay.test.js` 首次 7 项按预期失败；修复后连同真实回放、容差和结构比较的定向命令 **10/10 通过**。
- `node --test --test-name-pattern='Stage 6 release audit verifies' scripts/tests/release.test.js` **21/21 通过**，包含真实复算及重哈希篡改拒绝。
- `git diff --check` 通过；历史 5.0.0 两文件 SHA-256 与升级前匹配。

### 最终产物检查

- [x] 最后修复后的 `npm run build` 通过：语法/版本检查、数据审计、全量测试、干净 core/web 构建。
- [x] `npm run build:public` 通过：公开材料检查、**59/59 发布测试**、正式产物与发布审计；未依赖公开仓库排除的原始 XLSX。
- [x] `npm run check:reproducible` 通过：两次临时干净构建的 **157 个文件逐字节一致**。
- [x] 最终再单独运行 `npm test`：**500/500 通过**，0 失败/跳过/取消，约 140.27 秒。
- [x] 最终新产物真实 Chromium 检查 **24/24 通过**，包含正常复算、篡改清单检测和独立 CSV 披露。
- [x] 独立审查原探针复核：正常包 `matched=true`；仅改并重哈希 convergence 与开发 metric 的包 `matched=false`、2 个精确差异路径，0 网络调用。

以上均为本地验证，不单独证明远端推送、部署或科学独立验证成功；GitHub 上传是随后获用户授权的发布步骤。

## GitHub 上传后的跨运行时复验

主升级提交 [`a9f34ef`](https://github.com/Keng0nion/ecolab-antibiotic-modeling/commit/a9f34ef9f51c0452bcad59f079dded5054d9226b) 已推送到现有 `main`。[首次 Actions 34132393765](https://github.com/Keng0nion/ecolab-antibiotic-modeling/actions/runs/34132393765) 的 Ubuntu / Node 20.19.0 发布测试为 58 通过 / 1 失败，deploy 跳过。仅四处相关性警告的 message 不同，结构化数值没有超出复算容差；本地 Node 20.19.0 可复现。

兼容补丁只识别与各自数值字段逐字一致的封闭警告模板，仍核对所有结构化字段和完整 manifest。未更改科学结果、版本、示例、哈希或默认容差；模板之外的警告继续严格比较。

- [x] 原例子 Node 20.19.0：修复前四处 message 差异，修复后 `matched=true` / 0 差异。相关系数 `-0.9936582411628538` 与 `-0.9936582411628594` 的尾差未通过改写工件掩盖。
- [x] 新回归先失败后通过；连同原回放/manifest/容差/结构定向检查 **32/32** 通过，包含 16 个新负向子项和零容差反证。
- [x] 最终 `npm test`：**522/522** 通过，0 失败 / 取消 / 跳过，约 280.84 秒。
- [x] `npm exec --yes --package=node@20.19.0 -- npm run build:public` 单独执行：**59/59** 发布测试、Core/Web 构建、发布审计通过，发布测试约 60.23 秒。
- [x] `npm run check:reproducible`：**159 个文件逐字节一致**；新增模板模块分别进入 Core / Web，使文件数从 157 增至 159。
- [x] 全部 `data/examples` 相对主更新提交无变化；历史两哈希不变，`git diff --check` 及编辑器 diagnostics 通过。
- [x] 独立只读补丁审查未发现阻断项，确认双侧模板校验不短路数值/结构/manifest 比较。

一度将 Node 20 公开构建与全量测试并行执行，发布测试内部 120 秒超时，57 通过 / 2 取消，不计通过。随后在无并行重负载时使用相同上限重跑通过；未增加时限或跳过测试。下方 24 项 Chromium 记录属于主升级修复前产物，不冒充该兼容补丁的线上浏览器验证。最新部署结果以 Actions 对应提交为准。

## 浏览器记录

2026-09-07 初轮隔离 Chromium 自动化 **16 项通过、0 项失败**：Learn/Sandbox 启动、bundled 528 点导入/QC、small 实际 Worker 分析、开发与状态标签、UI 研究包下载、导入不自动运行、显式 Worker 回放 `matched=true` / 0 mismatches、IndexedDB 刷新恢复、分析/回放取消及初始化内存降级。

初轮证据在本地 `tmp/research-smoke/q6b-20260907-130645-report.json`，命令与事件同前缀；harness 125 秒总上限，实际约 22.54 秒。下载包 12,280,545 字节，低于 32 MiB 导入限额。观察的应用 HTTP 请求均为 loopback，无 page/console error；独立 session/服务器在 finally 关闭并检查无残留。此轮发生在最后 manifest/CSV 修复前；下面最终一轮已覆盖新修复。

首次额外使用 agent-browser `--allowed-domains 127.0.0.1` 时 dataset Worker 阻塞；有界退出，移除该额外 CLI 选项并用新隔离 session 后通过。未修改应用来规避该问题。另一只读审查组合测试曾因 60 秒限制超时，不计为通过，也未用其代替本页实际测试结果。

### 最终新产物复验

新独立 session `qa-stage6-final-20260907-134805`，另有 `-nostorage` session；harness 硬总超时 145 秒，实际 **38.217 秒**。命令：

```bash
node --check tmp/research-smoke/q6final-20260907-134805-harness.mjs
node tmp/research-smoke/q6final-20260907-134805-harness.mjs
```

最终 **24/24 项通过**，0 失败/阻塞：

- 包含初轮全部 16 项：启动、数据 QC、真实 Worker、状态标签、正常包导出/仅检查/显式匹配、刷新恢复、取消与内存降级。
- 尚未运行分析时独立下载 normalized CSV，528 行，明确说明已查看开发集、保留源 validation 角色、独立性未核实。
- 分别修改 manifest 的 convergence 或开发 macro RMSE，并仅重哈希 manifest；两包仍允许尝试复算、无自动执行，但显式浏览器 Worker 回放均 `matched=false`，各唯一差异为 `$.analysisManifest.convergence.converged` / `$.analysisManifest.diagnostics.metrics.development.macroRmse`。
- 10 个关键源码/产物文件逐字节相同，QA 前后哈希未变；正常未改包先验证 `matched=true`、0 mismatches。
- 无 console/page errors，观察到的应用 HTTP 请求全部 loopback；finally 关闭两 session 和服务器，端口 `43229` 与进程清理检查通过。

本地证据（不随发布分发）：`tmp/research-smoke/q6final-20260907-134805-report.json`、同前缀 `commands.txt`、`events.jsonl`、`dist-source-consistency.json`、`standalone-normalized.csv` 和 `cleanup-check.json`。Node 只负责 harness / 文件与负向包准备，分析、检查、回放发生在真实浏览器 Worker 内。

尚未完成：

- [ ] Chrome / Firefox / Safari 人工工作流、键盘、窄屏、读屏矩阵。
- [ ] Safari WebDriver 流程；仍需本机 Allow remote automation。
- [ ] 浏览器交互、启动和网络 P95 性能测量。

单次 smoke 耗时不是性能 P95；自动化契约和颜色对比度测试不是完整可访问性认证。

## 产物、预算与复现契约

- 默认产物 `dist/core/` / `dist/web/`；两脚本均支持临时 `--out-dir`。
- `scripts/audit-release.js` 约束每产物总大小 **10 MiB**、最大单文件 **5 MiB**；限额未因新版提高。最终实测 Core **7.14 MiB**、Web **7.55 MiB**；各最大文件为规范数据 JSON，**4.10 MiB**。
- 发布排除 `data/raw/`、`.xlsx`、tests；生成排序 `dist/release-manifest.sha256`。
- Web 复制 `_headers`，但 GitHub Pages 不应用该文件，不能声称线上 CSP 响应头已部署。
- 6.0.0 例子由实际计算生成，严格包校验后复算科学投影与完整 manifest；不规定模型赢家或差值方向。
- 示例科学结果 SHA-256：`6c4657779363edb4d9d3cbe33c15520378eb5a62469f9caff7b52da54cafb84e`。
- 历史 JSON SHA-256：`f3365e5c616597c042aa87eb76040b620955f4ea9e8865c77b83e5245acc41b8`。
- 历史 Markdown SHA-256：`05ca4c25a2327f81119ee7af609d2536c1ec7072f35a4532f32319406f416bbd`。

## 发布决定与边界

本轮本地 B 升级、文档及自动化验证已完成。用户随后于 2026-09-07 明确授权将此次更新提交并上传 `Keng0nion/ecolab-antibiotic-modeling` 的现有 `main`，不强制推送或重写历史。推送将触发已有 Pages workflow；具体提交与部署结果分别以 [GitHub 提交记录](https://github.com/Keng0nion/ecolab-antibiotic-modeling/commits/main/) 和 [Actions 记录](https://github.com/Keng0nion/ecolab-antibiotic-modeling/actions/workflows/deploy-pages.yml) 为准。详细改动见 [6.0.0 更新说明](./release-notes-6.0.0.md)。

手动跨浏览器 / 可访问性矩阵、P95 及独立实验验证仍未完成。更多方法不能补足不存在的三药实验数据，测试通过与同版复算不证明模型有效性或来源真实性。

Current checks concern local software and reproducibility, not publication or scientific validation. The admitted data are untreated OD600; previously viewed holdouts remain development comparisons. Completion is not convergence, identification or precision. Actual final build results are recorded above rather than inherited from historical release logs.
