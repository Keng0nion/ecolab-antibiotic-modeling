# Ecolab 技术蓝图

本目录保存 Ecolab 的长期系统决策与科学证据规则。使用指南、部署、维护与作品集叙事位于 `docs/`；蓝图不复制这些页面。

> Ecolab 是研究型探索与教学工具，不是临床决策工具，也不是未经条件匹配验证的通用实验预测器。

## 蓝图索引

- [Ecolab 系统总蓝图](./ecolab-system.md) — 产品定位、双模式架构、质量契约、五阶段路线与审批门。
- [科学证据与真实数据](./scientific-evidence-and-data.md) — 证据等级、数据准入、溯源、校准、验证和科学声明规则。

主文档入口：

- [Project overview](../docs/project-overview.md)
- [Architecture](../docs/architecture.md)
- [Limitations](../docs/limitations.md)
- [Portfolio case study](../docs/portfolio-case-study.md)
- [当前发布检查表](../docs/release-checklist.md)
- [方程、参数与论文证据](../docs/research-method-evidence.md)

## 当前项目状态

- Stage 1–3 已实施并获项目所有者批准。
- **Stage 4 已实施、完成内部审计并获项目所有者批准。**
- Stage 5 的历史 5.0.0 工件原样保留；旧验证记录不作为本轮检查结果。
- **用户已批准 B 方案，应用 6.0.0 / 分析 2.0.0 升级已实现。** 教学科学核心保持 `2.0.0`、模型 `1.0.0`；新增 OD 经验曲线比较、整训练轨迹 CV / 联合 bootstrap、安全显式回放及数值/存储修复。
- 当前自动化构建、回放与隔离 Chromium 检查以 [发布检查表](../docs/release-checklist.md) 为准；人工跨浏览器 / 可访问性矩阵与 P95 尚未完成，本轮未推送或部署。
- 默认构建生成 `dist/core/` 与 `dist/web/`；临时 `--out-dir` 构建、两次内容哈希复现检查、大小预算、禁止路径、部署头和排序 SHA-256 manifest 已进入发布审计。
- 6.0.0 small 示例由真实 bundled dataset 计算；训练 CV 选中均值基线，原潜在模型开发表现仍更差且未收敛。旧留出已经查看，仅开发比较，不具备 L4。完成、收敛、可识别性与精度状态独立报告。
- 七步课程和所有蓝图中的建模浓度术语统一使用 `zMIC`；它不是未经限定的普通 MIC。

## 蓝图维护规则

1. 新建蓝图前搜索本目录，避免重复文档。
2. 每个核心概念只保留一个主要定义位置；其他页面通过链接引用。
3. 文件使用 kebab-case，并加入本索引。
4. 实现偏离蓝图时更新长期决策；日常使用说明写入 `docs/`。
5. 科学声明、数据来源和适用域变化必须同步更新[科学证据与真实数据](./scientific-evidence-and-data.md)。
6. 阶段实现、内部审计和项目所有者批准是不同状态，不能互相替代。
