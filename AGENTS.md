# AGENTS.md —— agent 终端操作速览

本文档面向 agent：读完即可知道如何在本仓库中用终端操作 Ecolab。人类用户的完整说明见 [README.md](./README.md)，终端前端的详细参考见 [docs/cli.md](./docs/cli.md)。

## 一、仓库是什么

Ecolab 6.1.0：本地优先、可审计、可复现的大肠杆菌与抗生素种群建模项目。版本面为应用 `6.1.0`、科学核心 `2.0.0`、分析引擎 `2.1.0`、教学模型 `1.0.0`。无第三方运行时依赖，要求 Node.js 20.19 或更高，纯 ES Modules。分层为：浏览器应用 `src/app/`，科学核心 `src/model/`，分析引擎 `src/analysis/`，注册表与实验清单 `src/registry/`、`src/experiment/`，终端前端 `bin/ecolab.js` 与 `src/cli/`。全部计算在本地完成，不访问网络。

## 二、在终端操作：ecolab 命令行

入口三选一：

```bash
node bin/ecolab.js <命令> [选项]     # 推荐；注册表文件随模块自身定位，工作目录任意
npm run ecolab -- <命令> [选项]     # 在仓库根目录执行，等价
```

`npm link` 之后也可以直接用 `ecolab <命令> [选项]`。`node bin/ecolab.js help` 查看全部命令，`node bin/ecolab.js help <命令>` 查看单个命令的用法。

命令速查：

| 命令 | 作用 | 例子 |
| --- | --- | --- |
| `info` | 输出版本、药物目录、数据集、课程预设、沙盒限制、任务类型与命令清单 | `node bin/ecolab.js info` |
| `simulate` | 跑一次确定性模拟（模拟计划或课程预设），输出运行清单与轨迹 | `node bin/ecolab.js simulate --preset run-washout --out /tmp/ecolab-sim` |
| `qc` | 导入数据集文件，做严格 QC，报告工作流准入资格 | `node bin/ecolab.js qc --dataset <文件>` |
| `research` | 在内置数据集上跑锁定的研究工作流，导出六类产物 | `node bin/ecolab.js research --preset small --out /tmp/ecolab-research` |
| `replay` | 检查研究包；加 `--execute` 做精确同版显式复算 | `node bin/ecolab.js replay --package <包.json> --execute` |
| `task` | 直接执行与浏览器相同的 Worker 任务协议（共 12 种任务） | `echo '<任务JSON>' \| node bin/ecolab.js task --task -` |
| `serve` | 在 127.0.0.1 上提供网页应用（存在 `dist/web` 时用构建产物，否则用源码目录） | `node bin/ecolab.js serve --port 4173` |

输出契约（请依赖这些约定，不要猜测）：

1. 成功时 stdout 恰好输出一个 JSON 文档，其 `kind` 为 `ecolab.cli.<命令>`，`schemaVersion` 为 `1.0.0`；
2. 失败时 stderr 输出一个 JSON 错误文档（`kind` 为 `ecolab.cli.error`，`error` 含 code、message、path 等字段），退出码为 1，stdout 为空；按 `error.code` 判断失败原因；
3. 输入路径写 `-` 表示从 stdin 读取该输入；
4. `--out 目录` 把产物写入该目录，并在结果的 `artifacts` 数组中列出每个文件的 role、path、bytes 与 sha256；
5. `--progress` 时进度以 NDJSON 逐行写在 stderr，stdout 仍然是单个 JSON 文档；
6. 退出码只有 0（成功）与 1（失败），`serve` 是长驻服务，随服务进程退出。

`simulate --plan` 接受的模拟计划示例（结构契约见 [schemas/simulation-plan.schema.json](./schemas/simulation-plan.schema.json)，可直接照抄修改）：

```json
{
  "schemaVersion": "1.0.0",
  "kind": "ecolab.simulation-plan",
  "id": "my-experiment",
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

浓度支持 `mg/L` 与 `x_zMIC` 两种单位；`dose`、`dilute`、`washout` 只登记边界动作，`advance` 才提交并推进时间，与浏览器 Sandbox 语义一致。

常用组合（可直接复制执行）：

```bash
node bin/ecolab.js info
node bin/ecolab.js simulate --preset compare-drugs
cat plan.json | node bin/ecolab.js simulate --plan - --out /tmp/ecolab-sim
node bin/ecolab.js research --preset small --seed 123456789 --run-id my-run --created-at 2026-11-17T00:00:00.000Z --out /tmp/ecolab-research
node bin/ecolab.js replay --package /tmp/ecolab-research/my-run.research-package.json --execute
node bin/ecolab.js qc --dataset data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json
```

课程预设名：`run-control`、`run-zmic`、`run-high`、`run-washout`、`compare-drugs`。研究预设名：`small`、`standard`。`replay` 的 `matched` 为 false 属于复算结果而不是命令错误，退出码仍为 0。

## 三、修改代码时的约束

1. 不新增第三方依赖；Node.js 20.19 以上，纯 ESM；
2. 当前应用版本为 `6.1.0`，分析引擎为 `2.1.0`；会改变拟合、识别性、诊断或结果契约的修改必须升级对应版本并同步锁定检查、回放兼容、当前示例和发布记录。历史版本化示例不可覆盖；
3. 新增源码文件要登记到 `package.json` 的 `check:syntax` 列表；测试放在对应模块的 `tests/` 目录，使用 `node:test`；
4. `src/cli/` 不会进入 `dist/` 构建产物，不要把 CLI 代码混入 `src/app/`、`src/model/`、`src/analysis/`，也不要改动 `scripts/serve-static.js`（离线发布包声明与它逐字节一致）；
5. 科学语义不要复制粘贴：浏览器与终端都经由 `src/model/`、`src/analysis/` 调用同一份实现；
6. 改完必须执行 `npm run check:syntax && npm run check:version && npm run test:release`，全部通过才算完成；更完整的检查是 `npm test` 与 `npm run build:public`。

## 四、English summary

This repository is Ecolab 6.1.0, a local first E. coli / antibiotic population modeling app (scientific core 2.0.0, analysis engine 2.1.0, teaching model 1.0.0), with no third party runtime dependencies; it needs Node.js 20.19 or newer and plain ES modules. Agents operate it from the terminal through the bundled CLI: `node bin/ecolab.js <command> [options]`, or `npm run ecolab -- <command> [options]` from the repository root. Commands: `info`, `simulate`, `qc`, `research`, `replay`, `task`, `serve`, `help`. Every command prints exactly one JSON document on stdout (`kind` is `ecolab.cli.<command>`, `schemaVersion` is `1.0.0`); failures print a structured JSON error on stderr and exit with code 1; `-` reads an input from stdin; `--out` writes artifacts and lists their SHA-256 hashes; `--progress` streams NDJSON progress on stderr while stdout stays a single document. Simulation plans for `simulate --plan` follow [schemas/simulation-plan.schema.json](./schemas/simulation-plan.schema.json); the full CLI reference is [docs/cli.md](./docs/cli.md). When editing code: add no dependencies, update versions and exact replay contracts when numerical semantics change, preserve explicitly named historical examples, register new source files in `check:syntax`, keep tests in `tests/` directories, never mix `src/cli/` into the web build, and verify with `npm run check:syntax && npm run check:version && npm run test:release`.
