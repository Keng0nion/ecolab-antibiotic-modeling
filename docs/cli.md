# 终端前端 CLI / Terminal front end

Ecolab 6.0.0 除了浏览器应用，还提供终端前端 `ecolab`，让整个应用都可以在终端运行，方便 agent 与脚本直接调用。它不新增任何科学语义：所有计算都复用浏览器应用使用的同一份科学核心、分析引擎、任务协议与导出函数。详见 [Learn / Sandbox](./interactive-app.md) 与 [Research Workspace](./research-workspace.md) 了解浏览器端对应功能。agent 速览见仓库根目录的 [AGENTS.md](../AGENTS.md)。

## 中文

### 运行方式

要求 Node.js 20.19 或更高版本，无第三方运行时依赖，全程本地计算，不访问网络。

```bash
node bin/ecolab.js <命令> [选项]
npm run ecolab -- <命令> [选项]        # 等价写法
ecolab <命令> [选项]                    # npm link 之后，bin/ecolab.js 注册为 ecolab 命令
```

`ecolab help` 列出全部命令；`ecolab help <命令>` 列出单个命令的用法。机器可读的自描述清单用 `ecolab info`。测试见 `node --test src/cli/tests/cli.test.js`。

### 输出契约

1. 成功时，stdout 恰好输出一个 JSON 文档，其 `kind` 为 `ecolab.cli.<命令>`，`schemaVersion` 为 `1.0.0`；
2. 失败时，stderr 输出一个 JSON 错误文档（`kind` 为 `ecolab.cli.error`，`error` 含 name、code、message、path 等结构化字段），退出码为 1，stdout 不输出任何内容；
3. 输入路径写 `-` 表示从 stdin 读取该输入；
4. `--out DIR` 把产物写入目录，并在结果的 `artifacts` 数组中列出每个文件的 role、path、bytes 与 sha256；
5. `--progress` 在 stderr 以 NDJSON 逐行输出进度，stdout 仍然是单个 JSON 文档；
6. 退出码只有 0（成功）与 1（失败）；`serve` 是长驻服务，随服务进程退出。

### 命令总览

| 命令 | 作用 |
| --- | --- |
| `info` | 输出版本、药物目录、数据集、课程预设、任务类型、沙盒限制与命令清单 |
| `simulate` | 用模拟计划或课程预设跑一次确定性模拟，输出运行清单与轨迹 |
| `qc` | 导入一个数据集文件，做严格 QC 并报告工作流准入资格 |
| `research` | 在内置数据集上跑锁定的研究工作流，导出六类产物 |
| `replay` | 检查研究包；加 `--execute` 做精确同版显式复算 |
| `task` | 直接执行一个 Worker 任务协议任务（与浏览器相同的 12 种任务） |
| `serve` | 在 127.0.0.1 上提供网页应用（存在 dist/web 时用构建产物，否则用源码目录） |

### simulate：模拟计划与课程预设

`--plan <文件|->` 接受一个 `ecolab.simulation-plan`，结构契约见 [schemas/simulation-plan.schema.json](../schemas/simulation-plan.schema.json)：

```json
{
  "schemaVersion": "1.0.0",
  "kind": "ecolab.simulation-plan",
  "id": "demo",
  "drugId": "ciprofloxacin",
  "sampleIntervalMinutes": 5,
  "steps": [
    { "action": "dose", "concentration": { "value": 4, "unit": "x_zMIC" } },
    { "action": "advance", "durationMinutes": 60 },
    { "action": "dilute", "fold": 2 },
    { "action": "advance", "durationMinutes": 30 },
    { "action": "washout" },
    { "action": "advance", "durationMinutes": 60 }
  ]
}
```

步骤语义与浏览器 Sandbox 完全一致：`dose`、`dilute`、`washout` 只在当前时间边界登记待提交动作，`advance` 才把动作提交进协议并推进时间，不产生零时长段。浓度支持 `mg/L` 与 `x_zMIC`（按已注册参数集解析为 mg/L）。其余字段的默认值与 Sandbox 项目一致：初始种群 1e6 CFU/mL、检测限 10 CFU/mL、采样间隔 1 分钟。沙盒上限（最长模拟时长、最小采样间隔、最多 10000 个采样点）同样生效；非法输入直接报结构化错误，不做静默修复。

`--preset` 直接运行 Learn 课程实验：`run-control`、`run-zmic`、`run-high`、`run-washout`，以及 `compare-drugs`（对全部五种已注册抗生素各跑 60 分钟 4×zMIC，并给出与课程对比页相同的终值读数）。

产物：stdout 内嵌与浏览器导出同契约的 run manifest（即 `createRunManifest` 产物，含版本、参数集、协议、轨迹与警告）；`--out` 追加写出 `<runId>.run-manifest.json` 与 `<runId>.trajectory.csv`，CSV 表头和防电子表格公式注入规则与浏览器导出一致。

注意：模拟计划是 CLI 专用的自动化输入格式，不是应用的项目文件导入格式；浏览器应用仍不支持项目文件往返导入。

### qc：数据准入与质量检查

```bash
node bin/ecolab.js qc --dataset path/to/dataset.json
node bin/ecolab.js qc --dataset data.csv --format csv --dataset-id my-data --title "My data" --license "CC0-1.0" --out /tmp/ecolab-qc
```

输出导入结果、质量报告、数据集记录（不含源文本本体）与工作流准入资格。只有与已注册内置数据逐字节一致（SHA-256 匹配）的输入才会被认定为受信任的内置数据；其它文件只做 QC 与导出，不自动套用一键研究设计，这与浏览器的准入规则一致。`--out` 写出规范数据 CSV。

### research：锁定的研究工作流

```bash
node bin/ecolab.js research --preset small --seed 123456789 --out /tmp/ecolab-research
```

在内置数据集上执行与浏览器一键研究完全相同的流程（准入、预声明设计、分析、结果），使用同一预设预算与根种子派生。`--run-id` 与 `--created-at` 可以固定审计元数据，使产物逐字节可复现。`--out` 写出六类与浏览器导出同格式的文件：研究包 JSON、分析 manifest JSON、预测残差指标 CSV、规范数据 CSV、方法摘要 Markdown、研究仪表板 SVG。结果中的能力等级、完成、收敛、可识别性、精度与警告全部原样保留；开发集比较仍然不是未触碰验证。

泛型数据集不能用本命令跑一键工作流，只能用 `qc`。

### replay：检查与显式复算

```bash
node bin/ecolab.js replay --package run.research-package.json             # 只检查
node bin/ecolab.js replay --package run.research-package.json --execute   # 显式复算并比较
```

默认只做离线检查（安全 JSON、结构、inventory、字节与交叉引用），不执行数值任务；`--execute` 才在精确兼容的内置实现上复算，并同时比较科学投影与完整分析 manifest。输入若含顶层 `researchPackage` 字段（例如 6.0.0 示例包装文件），CLI 会自动取该字段并在输出中标注。`replay.matched` 为 false 表示复算发现差异；这属于结果而非错误，退出码仍为 0。

### task：原始任务协议

```bash
echo '{"kind":"dataset.parse","payload":{"input":"..."}}' | node bin/ecolab.js task --task -
```

接受任务对象或 run 信封，直接调用与浏览器 Worker 相同的 `dispatchTask`（12 种任务：数据解析、质量检查、参数扫描、Monte Carlo、局部、Morris 与 Sobol 敏感性、拟合、评价、研究工作流、包检查、包复算）。研究包任务的 `payload.input` 必须是研究包本体 JSON 文本；如需检查示例包装文件，请用 `replay` 命令。

### serve：在终端启动网页应用

```bash
node bin/ecolab.js serve --port 4173         # 存在 dist/web 时提供构建产物
node bin/ecolab.js serve --dir . --port 4173 # 显式提供源码目录（开发模式）
node bin/ecolab.js serve --port 4173 --open  # 同时打开默认浏览器
```

底层就是仓库自带的 `scripts/serve-static.js`，只监听 127.0.0.1，不产生对外请求；按 Ctrl+C 停止。

## 与浏览器应用的边界

1. 科学语义同源：CLI 不复制方程与算法，全部经由 `src/model/`、`src/analysis/`、`src/app/` 的既有模块；
2. 存储换成文件系统：终端没有 IndexedDB，`--out` 产物就是持久化形式，可复现性由 manifest 与产物哈希承担；
3. 准入与信任边界不变：一键研究只认内置数据，包检查上限与应用一致，复算只针对精确同版内置实现，不执行导入代码，不联网；
4. 科学声明不变：教学与探索用途，不是临床决策工具；开发集比较不是未触碰或外部验证；OD600 不是 CFU/mL。

## English summary

`ecolab` is a terminal front end that runs the whole application without a browser: `info`, `simulate`, `qc`, `research`, `replay`, `task`, and `serve`. Every command prints exactly one JSON document on stdout (`kind` is `ecolab.cli.<command>`); failures print a structured JSON error on stderr and exit 1. Inputs may be piped through stdin with `-`; `--out` writes artifacts and lists their SHA-256 hashes; `--progress` streams NDJSON progress on stderr while stdout stays a single document. It reuses the same scientific core, analysis engine, worker task protocol, and export formats as the browser app, adds no new scientific semantics, performs no network I/O, and keeps the same admission, trust, and capability boundaries: the one click research workflow still accepts only the integrity verified bundled dataset, package inspection stays offline until an explicit `--execute` replay, and development comparisons remain previously viewed data rather than untouched validation.
