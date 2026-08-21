# Maintenance, versioning, and data updates / 维护、版本与数据更新

## 中文

### 版本策略

Ecolab 分开维护三个版本面：

| 组件 | 当前版本 | 何时升级 |
| --- | --- | --- |
| 应用与发布 | `5.0.0` | UI、发布线、文档、部署或整体产品契约变化 |
| 科学核心引擎 | `2.0.0` | 模型实现、单位、状态、协议或数值语义变化 |
| 分析引擎 | `1.0.0` | 拟合、指标、验证、不确定性或敏感性算法契约变化 |

根 `package.json` 是应用版本的唯一权威来源。`src/app/version.js` 是浏览器可导入的镜像，必须由 `npm run check:version` 与根版本一致。`build-core.js` 直接读取根 package 版本，不保留第二份发布版本常量。

发布应用版本时：

1. 更新根 `package.json`；
2. 同步 `src/app/version.js`；
3. 更新版本化示例文件名与固定复现元数据；
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

新增数据集不能因为“可下载”就默认允许再分发；未知条件不能继承内置数据默认值。任何 OD 数据都必须保留 OD 语义，除非存在独立验证的转换证据。

### 维护节奏

- 依赖：项目当前无第三方运行时依赖；提高 Node 最低版本前先验证 CI/本地环境。
- 文档：每个概念只保留一个主页面，其他页面链接引用。
- 蓝图：只记录长期决策、边界和阶段状态，不复制用户指南。
- 预算：产物字节预算变化必须有测量与理由，不能用提高上限掩盖意外膨胀。
- 发布：不依赖 Git 状态或标签；release manifest 根据实际产物内容生成。

## English

Ecolab versions the application release, scientific core, and analysis engine separately. The root `package.json` is the sole authority for the application version. `src/app/version.js` is the browser-importable mirror checked by `npm run check:version`, while `build-core.js` reads the root package directly.

Raise scientific core `2.0.0` only for changes to model implementation, units, state, protocol, or numerical semantics. Raise analysis engine `1.0.0` only for changes to fitting, metrics, validation, uncertainty, or sensitivity contracts. An application release such as `5.0.0` can change release engineering and documentation without changing either scientific engine.

For data updates: register provenance, license, conditions, intended use, and version; retain source checksums; use deterministic acquisition/extraction scripts; run `npm run audit:data`; update the data card and candidate review; regenerate the portfolio artifact when results may change; and run the release audit to exclude raw workbooks and tests. Download availability does not imply redistribution permission, unknown conditions must remain unknown, and OD measurements must retain OD semantics unless an independently validated conversion exists.
