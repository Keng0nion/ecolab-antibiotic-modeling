# Learn / Sandbox 交互应用

## 定位

Ecolab 6.0.0 保留本地优先、响应式、中英文的 `Learn / Sandbox` 浏览器应用。新版升级独立研究分析与回放；教学科学核心引擎仍为 `2.0.0`，模型 `1.0.0` 不变。应用直接调用版本化科学核心，不在 UI 中复制或改写方程。

本页只说明 `#/learn` 与 `#/sandbox`。`#/research` 的真实数据、拟合、训练 CV、开发集比较、敏感性和安全回放见 [Research Workspace](./research-workspace.md)。

Learn / Sandbox 的演示运行属于 **L1 — Reproducible exploration**：可以用于大学一年级水平教学、模型探索和可复现实验演示，但没有在匹配条件下完成生物学验证，不能用于临床决策或真实实验结果预测。科研能力按每次运行评估；Research Workspace 的 L3 结果不会自动提高普通 Sandbox 运行的等级。

## 启动

要求 Node.js 20.19 或更高版本，无第三方运行时依赖。

```bash
npm run dev
```

打开 `http://127.0.0.1:4173`。

生产构建与预览：

```bash
npm run build
npm run preview
```

构建输出分开保存：

```text
dist/
├── core/   # 可独立分发的科学核心
└── web/    # 静态浏览器应用
```

## Learn

`#/learn` 提供固定七步课程：

1. 模型边界；
2. 无药增长；
3. `1×zMIC`；
4. `4×zMIC`；
5. 稀释药物浓度与洗脱；
6. 比较三种抗生素；
7. 保存、恢复与导出。

课程不会评分、发放徽章或持久保存学习进度。每一步的“载入本步实验”会创建一个明确、可复现的实验协议。

## Sandbox

`#/sandbox` 支持：

- 无药对照、氨苄西林、四环素和环丙沙星；
- 以 `mg/L` 或 `×zMIC` 输入浓度；
- 设置浓度、只稀释药物浓度、洗脱；
- 离散推进、播放、暂停和重置；
- 种群、药物浓度和净增长率三图联动；
- `log10`/线性种群坐标和 `mg/L`/`×zMIC` 浓度显示；
- 公式检查器、来源与限制、操作时间线和可访问数据表；
- IndexedDB 本地保存与恢复；初始化不可用时退化为易失内存并显示原因，运行时配额/事务失败明确报错，不静默切库；
- JSON 运行清单、CSV 轨迹和独立 SVG 图表导出。

导出契约：JSON 是当前已提交运行的审计清单，不是可重新导入的项目包；保存/恢复使用 IndexedDB 中的项目记录。CSV 是带电子表格公式注入防护的展示/分析格式，不承诺任意文本的字节级往返；需要机器可读的完整运行语义时使用 JSON 清单。当前 UI 不声称支持文件形式的 Sandbox project import/export round trip。

## 边界操作语义

加药、药物浓度稀释和洗脱发生在当前时间边界，并先保存为 `pendingAction`：

- 不创建零时长协议段；
- 同一边界上的后一次操作替换前一次待提交浓度；
- 只有推进正时间后，操作才进入科学协议；
- 本地保存可以保留待提交操作；
- 科学导出会拒绝包含待提交操作的项目。

“稀释”只降低药物浓度，不改变细菌种群或培养体积。

## 公式检查器

检查器区分两种量：

- **此刻及下一时间段**：边界右侧浓度及其净增长率；
- **到达此点的区间**：把种群推进到当前点的前一区间。

它显示：

- `ψmax = log10(2) / doublingTimeHours`；
- 当前 `a/zMIC`、`κ`、`ψmin` 和科学核心计算的 `ψ(a)`；
- 正净增长使用解析逻辑斯蒂分支；
- 零或负净增长使用 `log10` 线性分支；
- 检测限只标记观测删失，不截断潜在状态。

## 科学声明

当前参数集是跨条件组合：

- 增长基线：E. coli BW25113，补充 M9；
- 药效参数：E. coli CAB1，LB，37°C。

因此界面持续显示 `Transferred calibration` 警告。`zMIC` 是药效函数的零净增长浓度，不是普通二倍稀释实验 MIC。

Learn / Sandbox 本身不执行真实数据拟合、Monte Carlo、敏感性分析或参数扫描；这些功能位于独立的 Research Workspace。整个项目仍不包含耐药进化、持留菌、联合用药、人体药代动力学、空间扩散、宿主免疫或临床 S/I/R。

## 验证

```bash
npm run test:release
npm run build
npm run audit:release
```

发布构建、临时输出目录、CSP 和复现检查见 [Deployment](./deployment.md) 与 [当前发布检查表](./release-checklist.md)。

Safari 浏览器冒烟测试：

```bash
npm run smoke:safari
```

该命令需要在 Safari 设置的 Developer 部分启用 **Allow remote automation**。它会打开构建产物、载入无药四小时课程实验、检查三联图和数据表，再验证语言切换。

2026-09-07 的隔离 Chromium 自动化已检查 Learn/Sandbox 启动及研究 Worker 流程，不等于完成 Safari/Firefox 或人工可访问性矩阵。首次静态资源加载访问部署站点；用户导入数据不发送至分析服务器，IndexedDB 保存也不等于异地备份。
