# Maintenance, versioning, and data updates / 维护、版本与数据更新

## 中文

### 版本策略

Ecolab 分开维护三个版本面：

- 应用与发布 `6.0.0`：UI、发布线、文档、部署或整体产品契约变化时升级。
- 科学核心引擎 `2.0.0`，教学模型 `1.0.0`：模型实现、单位、状态、协议或数值语义变化时分别升级。
- 分析引擎 `2.0.0`：拟合、指标、评价、不确定性或敏感性算法契约变化时升级；当前 implementation 为 `ecolab-research-analysis-v2`，稳定 ID 仍是 `ecolab.stage4.analysis`。

根 `package.json` 是应用版本的唯一权威来源。`src/app/version.js` 是浏览器可导入的镜像，必须由 `npm run check:version` 与根版本一致。`build-core.js` 直接读取根 package 版本，不保留第二份发布版本常量。

发布应用版本时：

1. 更新根 `package.json`；
2. 同步 `src/app/version.js`；
3. 新建对应版本示例文件名与固定复现元数据，不能覆盖已发布历史工件；
4. 运行 `npm run check:version`、目标测试、构建和发布审计；
5. 只有科学语义变化时才升级科学核心或分析引擎，并同步 schema、测试和方法文档。

### 数据更新流程

1. 在 `data/registry/` 记录来源、许可证、条件、用途与版本。
2. 保存原始来源校验和；只有许可证允许时才保留可再分发原始文件。
3. 使用获取/提取脚本产生规范 JSON/CSV，不手工修饰源测量值。
4. 运行 `npm run audit:data` 验证注册表、哈希、计数和准入规则。
5. 更新数据卡和 `docs/data-candidate-review.md`，明确转换、排除和证据资格。
6. 若数据或结果影响作品集案例，重新运行 `npm run example:research`，检查 L3/L4、基线和警告是否仍准确。
7. 运行 `npm run audit:release`，确认发布产物不含 `data/raw/`、`.xlsx` 或测试目录。

新增数据集不能因为“可下载”就默认允许再分发；未知条件不能继承内置数据默认值。任何 OD 数据都必须保留 OD 语义，除非存在独立验证的转换证据。已查看的留出曲线不能因修改算法或版本号重新成为 untouched test；当前仅开发比较，原始文件的 `validation` 角色保留用于溯源。

### 回放与统计维护

- `schemas/analysis-run.schema.json` 接受明确的 v1/v2 版本和 implementation 配对；接受查看不代表能运行。完整输入与精确内置版本匹配才允许显式复算，不自动升级旧算法。
- 研究包是数据自包含、软件依赖显式的 JSON，不是独立可执行文件；复算同时比较科学投影与完整 manifest，不能只检查重新计算的哈希。
- 更新默认参数、预算、RNG 或统计语义后，运行示例生成和真实回放审计；保留负面结果、非收敛、非识别及精度警告，测试不能断言偏好的获胜模型。
- Morris 全范围与 Sobol 独立三角工程范围不可混淆，轨迹 bootstrap 联合样本不可拆成独立参数边际。
- 不通过提高预算上限掩盖资源风险；导入大小、嵌套深度、节点数及计算预算都需对应拒绝测试。
- 存储结构未变，仍是 IndexedDB v2；恢复结果核对 id/revision/contentHash。初始化内存降级是易失模式；运行时配额失败应提示导出/清理，不自动丢弃数据或换库。

### 维护节奏

- 依赖：项目当前无第三方运行时依赖；提高 Node 最低版本前先验证 CI/本地环境。
- 文档：每个概念只保留一个主页面，其他页面链接引用。
- 蓝图：只记录长期决策、边界和阶段状态，不复制用户指南。
- 预算：产物字节预算变化必须有测量与理由，不能用提高上限掩盖意外膨胀。
- 发布：不依赖 Git 状态或标签；release manifest 根据实际产物内容生成。

## English

Ecolab versions the application release, scientific core, and analysis engine separately. The root `package.json` is the sole authority for the application version. `src/app/version.js` is the browser-importable mirror checked by `npm run check:version`, while `build-core.js` reads the root package directly.

Scientific core `2.0.0` and teaching model `1.0.0` remain unchanged. Application `6.0.0` includes analysis `2.0.0` (`ecolab-research-analysis-v2`), retaining stable engine ID `ecolab.stage4.analysis`. Preserve historical artifacts, pin replay dependencies exactly, and compare the complete recomputed manifest as well as scientific output. Previously inspected holdouts remain development data; higher budgets and passing software tests do not establish scientific validation.

For data updates: register provenance, license, conditions, intended use, and version; retain source checksums; use deterministic acquisition/extraction scripts; run `npm run audit:data`; update the data card and candidate review; regenerate the portfolio artifact when results may change; and run the release audit to exclude raw workbooks and tests. Download availability does not imply redistribution permission, unknown conditions must remain unknown, and OD measurements must retain OD semantics unless an independently validated conversion exists.
