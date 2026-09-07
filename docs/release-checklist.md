# Ecolab 6.0.0 release checklist / 发布检查表

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
