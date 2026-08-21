# Ecolab 5.0.0

Ecolab 是一个本地优先、可审计、可复现的 *E. coli*–抗生素种群建模项目，包含中英文 Learn / Sandbox 与真实数据 Research Workspace。

Ecolab is a local-first, auditable, reproducible *E. coli*–antibiotic population-modeling project with a bilingual Learn / Sandbox and a real-data Research Workspace.

> 用于教学、模型探索和研究型分析；不是临床决策工具，也不是经过条件匹配验证的通用实验预测器。
>
> For teaching, model exploration, and research-oriented analysis; not for clinical decisions or as a condition-matched general experimental predictor.

## Version contract / 版本契约

- Application / 应用：`5.0.0`
- Scientific core engine / 科学核心：`2.0.0`（Stage 5 未改变）
- Analysis engine / 分析引擎：`1.0.0`（Stage 5 未改变）
- Model / 模型：`ecolab.single-population.regoes-logistic@1.0.0`

根 `package.json` 是应用版本唯一来源。当前内置真实数据案例达到 L3 数据校准，但因源孔/板独立性记录不足而不具备 L4 证据资格；其验证结果差于预声明基线并被原样保留。

The root `package.json` is the sole application-version authority. The bundled case demonstrates L3 calibration but is ineligible for L4 evidence; its worse-than-predeclared-baseline validation result is retained.

## Commands / 命令

Requires Node.js 20.19 or newer; no third-party runtime dependencies.

```bash
npm start
npm run dev
npm run test:release
npm run build
npm run audit:release
npm run check:reproducible
npm run example:research
npm run preview
```

使用 `npm start` 可一键检查、构建、启动 Ecolab，并自动打开默认浏览器；在终端按 `Ctrl+C` 停止。Default products are `dist/core/` and `dist/web/`. Both build scripts also accept `--out-dir` for isolated builds. See the release checklist for the current full-suite and manual-browser validation status.

## Documentation / 文档

- [Project overview / 项目概览](./docs/project-overview.md)
- [Architecture / 系统架构](./docs/architecture.md)
- [Scientific core / 科学核心](./docs/scientific-core.md)
- [Learn / Sandbox](./docs/interactive-app.md)
- [Research Workspace](./docs/research-workspace.md)
- [Limitations / 局限性](./docs/limitations.md)
- [Portfolio case study / 作品集案例](./docs/portfolio-case-study.md)
- [Deployment / 部署](./docs/deployment.md)
- [Maintenance, versioning, data updates / 维护、版本与数据更新](./docs/maintenance.md)
- [Stage 5 release checklist / 发布检查表](./docs/release-checklist.md)
- [Data admission review / 数据准入审查](./docs/data-candidate-review.md)
- [Technical blueprints / 技术蓝图](./blueprints/README.md)

## License and data attribution / 许可证与数据归属

Ecolab 自有代码以 [MIT License](./LICENSE) 发布，版权所有 © 2026 Kengo Kubota。仓库中的第三方数据、论文和来源材料不因代码许可证而重新授权；内置 Figshare BW25113 数据继续遵守原始 `CC BY 4.0` 许可及其数据卡中的署名和来源要求。

Original Ecolab code is released under the [MIT License](./LICENSE), copyright © 2026 Kengo Kubota. Third-party datasets, papers, and source materials are not relicensed by the software license. The bundled Figshare BW25113 data remain subject to their original `CC BY 4.0` license and the attribution/provenance requirements documented in the dataset card.

Versioned generated example:

- [Small-preset Markdown](./data/examples/ecolab-stage5-small-research-5.0.0.md)
- [Small-preset JSON](./data/examples/ecolab-stage5-small-research-5.0.0.json)
