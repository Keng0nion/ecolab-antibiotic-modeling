# Ecolab project overview / 项目概览

## 中文

Ecolab 5.0.0 是一个本地优先、可审计、可复现的 *E. coli*–抗生素种群建模项目。它把两个用途放在同一套版本化科学核心之上：

- **Learn / Sandbox**：中英文交互课程与实验沙盒，用于理解无药增长、`zMIC`、Regoes 药效函数、分段恒定暴露和模型边界。
- **Research Workspace**：真实数据准入、质量检查、参数拟合、不确定性、敏感性、锁定留出评价和研究包导出。

Stage 5 的应用版本是 `5.0.0`；科学核心引擎保持 `2.0.0`，分析引擎保持 `1.0.0`。应用版本升级代表发布、审计、文档和作品集线完成，不暗示模型方程或分析算法发生了版本升级。

项目面向学习、研究型探索和本科作品集展示，不是临床决策工具，也不是经过条件匹配验证的通用实验预测器。当前真实数据案例达到 L3 数据校准；其锁定留出程序虽然无泄漏且未触碰，但源孔/板独立性记录不足，因此不具备 L4 证据资格。

建议从以下页面继续：

- [系统架构](./architecture.md)
- [科学核心](./scientific-core.md)
- [Research Workspace 方法](./research-workspace.md)
- [局限性与声明边界](./limitations.md)
- [作品集案例](./portfolio-case-study.md)

## English

Ecolab 5.0.0 is a local-first, auditable, and reproducible *E. coli*–antibiotic population-modeling project. It places two experiences on the same versioned scientific core:

- **Learn / Sandbox**: a bilingual interactive course and experiment sandbox for no-drug growth, `zMIC`, the Regoes pharmacodynamic function, piecewise-constant exposure, and model boundaries.
- **Research Workspace**: real-data admission and quality control, parameter fitting, uncertainty and sensitivity analysis, locked held-out evaluation, and reproducible research-package export.

Stage 5 sets the application release to `5.0.0`; the scientific core engine remains `2.0.0`, and the analysis engine remains `1.0.0`. The application-version change represents the release, audit, documentation, and portfolio line. It does not imply a new model equation or analysis algorithm.

The project supports learning, research-oriented exploration, and undergraduate portfolio presentation. It is not a clinical decision tool or a condition-matched general experimental predictor. The bundled real-data case demonstrates L3 data calibration. Its locked holdout procedure is leakage-free and untouched, but incomplete source well/plate independence documentation makes it ineligible as L4 evidence.

Continue with:

- [Architecture](./architecture.md)
- [Scientific core](./scientific-core.md)
- [Research Workspace methods](./research-workspace.md)
- [Limitations and claim boundaries](./limitations.md)
- [Portfolio case study](./portfolio-case-study.md)
