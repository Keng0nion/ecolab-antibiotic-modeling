# 科学计算核心

## 版本契约

Stage 5 应用版本为 `5.0.0`，但没有改变科学核心或分析算法版本。当前科学模型为：

- Model ID：`ecolab.single-population.regoes-logistic`
- Model version：`1.0.0`
- Implementation ID：`regoes-logistic-piecewise-analytic-v1`
- Engine version：`2.0.0`
- Parameter set：`ecolab.bw25113-m9-regoes-transferred@1.0.0`

模型版本描述方程、状态语义、协议边界和积分方式；引擎版本描述软件实现；参数集版本描述数值、条件和来源。未知版本不会自动回退。

第 4 步另外提供独立分析入口：

- Public entry：`src/analysis.js`
- Analysis engine ID：`ecolab.stage4.analysis`
- Analysis engine version：`1.0.0`
- Analysis implementation ID：`ecolab-stage4-analysis-v1`
- Core package subpath：`@ecolab/scientific-core/analysis`

应用版本、分析版本与确定性模型引擎版本分开维护。根 `package.json` 管理应用发布版本；科学核心 `2.0.0` 与分析引擎 `1.0.0` 只在各自语义契约改变时升级。模拟 `createRunManifest()` 描述一条确定性模型运行；研究分析使用 `ecolab.analysis-run` manifest 和 `ecolab.research-package`，另外记录数据集、拆分、锁定计划、随机种子、优化、拟合、指标、残差、能力等级和警告。二者不能混用来暗示确定性模拟已经完成真实数据验证。

## 状态与单位

内部状态使用 `log10(CFU/mL)`，避免强杀灭过程中的线性数值下溢。公共输入使用显式 quantity：

```json
{
  "value": 60,
  "unit": "min"
}
```

内部规范单位为：

- 时间：`h`
- 浓度：`mg/L`
- 种群：`log10(CFU/mL)`
- 净增长率：`log10-fold/h`

支持 `mg/L` 与 `ug/mL` 的显式等值转换。`×zMIC` 是依赖具体参数集的派生表示，不是独立物理单位；第 3 步 UI 必须把它解析为带参数引用的 `mg/L`。

## 药效函数

净增长率采用 Regoes 等人 2004 年的四参数药效函数。实现使用代数等价的稳定 logistic 形式，避免在极高浓度下直接计算巨大幂。

关键性质：

- 浓度为 0 时返回 `psiMax`；
- 浓度等于 `zMIC` 时净增长率为 0；
- 浓度增加时净增长率单调不增；
- 高浓度极限为 `psiMin`。

`zMIC` 是药效函数的零净增长浓度，不等同于二倍稀释实验报告的 MIC。注册表和 API 不使用无限定的 `mic` 字段。

## 种群动力学

当药效函数给出正净增长率时：

```text
dN/dt = ln(10) × psi(a) × N × (1 - N/K)
```

当净增长率小于或等于 0 时：

```text
d log10(N)/dt = psi(a)
```

恒定浓度段内使用解析更新，因此把一个浓度段拆成多个相同子段不会改变结果。模型不通过事后截断模拟承载量。

## 检测限

检测限属于观测过程，不属于生物学状态下限。潜在种群可以低于检测限，输出通过 `belowDetectionLimit` 标记删失状态；检测限不会反馈到动力学方程。

## 暴露协议

当前只支持单一药物的分段恒定浓度：

- 第一段从时间 0 开始；
- 各段连续、无重叠、无空洞；
- 时间段采用 `[start,end)`；
- 最终终点包含在结果中；
- 浓度在边界右连续；
- 种群在边界连续；
- `none` 对照的浓度必须为 0；
- 一个协议不能切换或组合多种抗生素。

该协议只是把原型中的加药、洗脱和推进时间形式化，不引入药代动力学。

## 严格验证

科学核心不会静默修复非法输入：

- 未知药物直接报错；
- 数字字符串、`NaN`、`Infinity` 和负浓度被拒绝；
- 单位不匹配被拒绝；
- 种群超过承载量被拒绝；
- 协议空洞和重叠被拒绝；
- 模型和参数版本不匹配被拒绝；
- 来源引用缺失或无精确定位被拒绝。

未来 UI 可以帮助用户纠错，但不能让核心无声改变实验含义。

## 已删除的错误语义

- 不再把 `zMIC` 简称为普通 MIC；
- 不再用检测限截断潜在种群；
- 不再报告 `cumulativeDeaths`，因为净增长率模型不能区分出生和死亡；
- 不再把 `netGrowth` 保存为容易陈旧的可变状态；
- 不再让模型核心直接导入 JSON 或包含颜色、翻译和格式化逻辑。

## 可复现运行

`createRunManifest()` 记录：

- 应用、引擎、模型和参数集版本；
- 解析后的参数；
- 来源 ID；
- 初始状态、协议、采样和观测设置；
- 轨迹与诊断；
- `Transferred calibration` 等强制警告；
- 当前无随机性的显式声明。

同一个 JSON 兼容请求在相同版本下产生相同轨迹。

## 第 4 步分析层

分析层位于 `src/analysis/`，保持纯函数和无 UI 依赖，并可在浏览器 Worker 与 Node 测试中运行。它包括：

- 规范 JSON/CSV 数据导入与质量检查；
- 条件匹配、数据指纹和完整独立单元拆分；
- 参数扫描和分布采样；
- Monte Carlo 参数不确定性传播；
- 局部、Morris 与 Sobol–Jansen 敏感性；
- 有界差分进化、Nelder–Mead 和多起点拟合；
- 残差、macro/pooled 指标和预声明基线比较；
- 参数相关性与可识别性诊断；
- 锁定分析计划与验证执行；
- 每次运行的 L1–L5 能力评估；
- 分析 manifest、方法摘要和研究包。

所有生产科学拟合默认执行 Stage 4 参数白名单，只接受全局模型参数、已声明药物参数和已声明初始状态路径。合成回归测试可显式使用 `generic_test_adapter`，但该策略不能作为生产科学参数路径的默认值。

随机分析统一使用 `xoshiro128ss-splitmix32-v1`，不使用 `Math.random()` 生成科学样本。根种子通过稳定标签派生优化、Monte Carlo、Morris 和 Sobol 子流。

点残差定义为 `observed - predicted`。对删失观测不制造伪点残差，而是保存残差区间；点指标只在精确观测上计算。

## OD600 研究观测层

内置真实数据是原始 OD600，而科学模型内部状态仍是 `log10(CFU/mL)`。二者通过独立、显式的观测层连接：

```text
OD600 = baselineOd + scaleOd × (N/K)
```

`baselineOd` 与 `scaleOd` 是训练数据上的观测层干扰参数，不改变源值，也不构成普适 OD→CFU 转换。验证前它们被锁定，验证时不重新拟合。详细流程见 [Research Workspace](./research-workspace.md)。
