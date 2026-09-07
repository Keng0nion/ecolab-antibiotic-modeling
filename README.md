# Ecolab 6.0.0

Ecolab 是一个本地优先、可审计、可复现的 *E. coli*–抗生素种群建模项目，包含中英文 Learn / Sandbox 与真实数据 Research Workspace。

Ecolab is a local-first, auditable, reproducible *E. coli*–antibiotic population-modeling project with a bilingual Learn / Sandbox and a real-data Research Workspace.

> 用于教学、模型探索和研究型分析；不是临床决策工具，也不是经过条件匹配验证的通用实验预测器。
>
> For teaching, model exploration, and research-oriented analysis; not for clinical decisions or as a condition-matched general experimental predictor.

## Live site / 在线网站

- GitHub Pages: https://keng0nion.github.io/ecolab-antibiotic-modeling/
- 每次推送到 `main` 后，`.github/workflows/deploy-pages.yml` 会运行 `npm run build:public`，验证公开仓库材料并自动发布 `dist/web/`。
- Every push to `main` runs `npm run build:public` to validate the public repository materials and deploy `dist/web/`.

## Version contract / 版本契约

- Application / 应用：`6.0.0`
- Scientific core engine / 科学核心：`2.0.0`（教学动力学不变）
- Analysis engine / 分析引擎：`2.0.0`（数值修复、OD 模型比较和同版回放）
- Model / 模型：`ecolab.single-population.regoes-logistic@1.0.0`

根 `package.json` 是应用发布版本权威来源。新版保留教学 Regoes/Logistic 模型，新增直接 OD 尺度 Logistic/Gompertz、训练整曲线交叉验证、联合整曲线 bootstrap，以及带校验和的研究包同版复算。原留出数据已被查看，新结果明确标为开发集比较，不是未触碰测试集或外部验证。

实际 `small` 示例中，训练交叉验证选中逐时间均值基线，开发集 macro RMSE 为 `0.00304756`；原潜在种群模型为 `0.00833386`，仍差于基线。参数模型未收敛、独立性与统计精度不足的警告均保留。未处理 OD600 数据不能验证三种抗生素药效，也不能识别绝对 CFU。

Version 6 adds empirical OD-scale model comparison, training-trajectory CV/bootstrap and integrity-checked exact-version replay. The previously inspected holdout is development data, not untouched/external validation. The quick example selects the training-mean baseline; parameterized fits remain nonconverged. Completion, convergence, identification and precision are reported separately. No antibiotic-effect validation is claimed.

## Commands / 命令

Requires Node.js 20.19 or newer; no third-party runtime dependencies.

```bash
npm start
npm run dev
npm run test:release
npm run build
npm run build:public
npm run audit:release
npm run check:reproducible
npm run example:research
npm run preview
```

使用 `npm start` 可一键检查、构建、启动 Ecolab，并自动打开默认浏览器；在终端按 `Ctrl+C` 停止。Default products are `dist/core/` and `dist/web/`. Both build scripts also accept `--out-dir` for isolated builds. See the release checklist for the current full-suite and manual-browser validation status.

## Documentation / 文档

- [6.0.0 release notes / 本次详细更新说明](./docs/release-notes-6.0.0.md)
- [Project overview / 项目概览](./docs/project-overview.md)
- [Architecture / 系统架构](./docs/architecture.md)
- [Scientific core / 科学核心](./docs/scientific-core.md)
- [Learn / Sandbox](./docs/interactive-app.md)
- [Research Workspace](./docs/research-workspace.md)
- [Limitations / 局限性](./docs/limitations.md)
- [Portfolio case study / 项目介绍与真实结果](./docs/portfolio-case-study.md)
- [Equations, parameters and papers / 方程、参数与论文证据](./docs/research-method-evidence.md)
- [Deployment / 部署](./docs/deployment.md)
- [Maintenance, versioning, data updates / 维护、版本与数据更新](./docs/maintenance.md)
- [Release checklist / 发布检查表](./docs/release-checklist.md)
- [Data admission review / 数据准入审查](./docs/data-candidate-review.md)
- [Technical blueprints / 技术蓝图](./blueprints/README.md)

## License and data attribution / 许可证与数据归属

Ecolab 自有代码以 [MIT License](./LICENSE) 发布，版权所有 © 2026 Kengo Kubota。仓库中的第三方数据、论文和来源材料不因代码许可证而重新授权；内置 Figshare BW25113 数据继续遵守原始 `CC BY 4.0` 许可及其数据卡中的署名和来源要求。

Original Ecolab code is released under the [MIT License](./LICENSE), copyright © 2026 Kengo Kubota. Third-party datasets, papers, and source materials are not relicensed by the software license. The bundled Figshare BW25113 data remain subject to their original `CC BY 4.0` license and the attribution/provenance requirements documented in the dataset card.

Versioned generated examples:

- [Current 6.0.0 Markdown](./data/examples/ecolab-stage6-research-6.0.0.md)
- [Current 6.0.0 JSON](./data/examples/ecolab-stage6-research-6.0.0.json)
- [Frozen historical 5.0.0 Markdown](./data/examples/ecolab-stage5-small-research-5.0.0.md)
- [Frozen historical 5.0.0 JSON](./data/examples/ecolab-stage5-small-research-5.0.0.json)

计算在本地 Worker 执行，合格数据源文本与结果存入 IndexedDB；初始化不可用时使用易失性内存，运行时配额失败明确报错。研究包包含数据与完整输入，但需要精确匹配的内置软件，不是独立可执行文件。旧包可校验查看，缺少完整输入或版本不兼容时拒绝复算。静态资源初次加载仍需要访问部署站点；用户数据不上传到分析服务器。
