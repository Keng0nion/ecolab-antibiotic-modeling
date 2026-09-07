# Limitations and claim boundaries / 局限性与声明边界

适用版本：应用 `6.0.0` / 分析 `2.0.0`；教学核心与原始数据保留。

## 当前可以支持的声明

- Learn / Sandbox 提供 L1 教学、模型探索及确定性运行清单。
- Research Workspace 实现真实数据 QC、训练拟合、整轨迹训练 CV、冻结后的开发比较、诊断、不确定性及敏感性分析。
- 工程流程可保存数据与设置、检查包完整性、在精确兼容版本显式复算；软件测试检查已声明的数学和交换契约。
- 能力按每次运行评估；L3 流程标签表示进行了校准与诊断，不自动证明收敛、识别或泛化。

## 当前不能支持的声明

- 临床决策、患者给药、治疗建议、临床 S/I/R 分类。
- 通用或条件匹配的 E. coli 实验预测器。
- 将 OD600 当作 CFU/mL，或通用 OD→CFU 换算。
- 使用当前无药数据拟合或验证三药的 `zMIC`、`kappa`、`psiMin`。
- 将已查看开发集当作未触碰测试或独立外部验证；形式无泄漏不等于实验独立。
- 将“计算完成”“测试通过”当作“优化收敛”“模型稳定”或“科学验证成功”。

## 教学动力学范围

单一均质种群、单药分段恒定浓度；正净增长使用密度约束 Logistic，非正增长在 log10 状态推进。模型不含耐药进化、持留或异质亚群、联合用药、人体药代动力学、空间扩散、生物膜、宿主免疫。

`zMIC` 是药效函数零净增长浓度，不是无限定普通 MIC。三药参数来自 CAB1/LB，迁移到 BW25113 目标；`K=10^9 CFU/mL` 是教学假设，不是测量。

## 数据与评价边界

内置 Figshare 子集只有 12 条 BW25113 无药、原始未扣空白 OD600 轨迹。`Cond00003` 不等于目标补充 M9；同管分孔及曲线标签不能证明独立生物实验批次。后四条原角色 `validation` 的曲线已在此前版本查看，当前明确为 `development_comparison`，不改写原始数据。

`OD=b+s(N/K)` 的干扰参数只在训练侧剖面化，不能标定绝对 CFU 或 K。新增直接 OD Logistic/Gompertz 是经验观察尺度曲线；形状 rate 与拐点 timing 不是原文 log-population 的比增长率 / 生理 lag。方法选择及差异见 [方法证据](./research-method-evidence.md)。

快速示例训练 CV 选中均值基线，开发 macro RMSE `0.00304756 OD`；原潜在模型 `0.00833386 OD`，更差且未收敛。不能把基线的分数宣传为 Logistic/Gompertz 的改进，也不能依据有限未收敛搜索断言参数模型充分优化后仍较差。完整数值见 [作品集案例](./portfolio-case-study.md)。

## 不确定性、敏感性与可识别性

- Monte Carlo 独立三角工程范围产生探索性模拟区间，不是校准置信区间。
- Morris 用完整边界，Sobol 用拟合点附近独立分布；输入空间不同，不要求排名相同。小样本指数可负、可 `S1>ST`，保留原值与精度警告，不裁剪。
- Sobol 配对行 bootstrap 仅估计给定输入分布的采样误差，不涵盖模型或数据误差。
- 整训练轨迹 bootstrap 保留联合样本，但独立性未验证；区间条件于冻结模型、边界和成功收敛重拟合，不包含选模 / 观测噪声不确定性，不是同时带或新观测预测区间。
- `small` 的 20 次 bootstrap 尾部分辨率不足；选中无参数基线时参数区间为空是正确行为。
- `objectiveSlices` 固定其他生物参数并重新优化 OD 干扰参数，不是真 profile likelihood。秩亏 covariance 为 `null`；伪逆不能冒充已识别参数的不确定性。
- 整体 `completed=true` 可以同时有 `converged=false`、`identified=false`、`precisionAssessed=false`。

## 存储、回放与工程限制

- 本地计算与数据不上传分析服务器，但首次静态资源加载仍访问部署站点；本地存储不等于云备份。
- IndexedDB 初始化不可用时降级为易失内存；运行时配额失败显式报错。清除站点数据会删除保存记录，必须自行保留导出备份。
- IndexedDB 列表仍读取完整记录，长期大数据量的分页与配额管理尚未优化。
- 研究包最多 32 MiB，含完整数据/输入但依赖精确内置软件；不是独立可执行文件，也不承诺无限跨版本复算。缺输入的旧包只查看。
- 导入检查不自动运行；`replayable` 只表示可尝试，复算同时比较科学投影与完整 manifest 才确定 matched。哈希不证明来源身份、数据真实或结论有效。
- 回放预览只在内存，不关联或覆盖当前数据集分析，不会自动持久化。
- Sandbox JSON 仍是运行清单，不是项目导入包；防公式注入 CSV 不承诺任意字符串无损往返。

## 尚未完成的验证

- Chromium 隔离自动化检查不等于完整 Chrome/Firefox/Safari 人工、键盘或读屏可访问性矩阵；Safari WebDriver 仍需启用 Allow remote automation。
- 未测量浏览器交互、启动或网络性能 P95；静态字节预算审计不是延迟测试。单次 smoke 耗时不代表 P95。
- 自动化测试不能替代同行评议、实验重复、充分优化预算、统计精度或独立验证。
- 本轮没有提交、推送或更新线上站点；当前本地产物验证状态见 [发布检查表](./release-checklist.md)。

## English summary

This is a teaching and research-exploration tool, not clinical decision support or a condition-matched experimental predictor. Drug parameters are transferred from CAB1/LB; admitted data are untreated raw OD600 in Cond00003, not absolute CFU. Previously viewed holdout curves are development comparisons with unverified experimental independence.

The quick example selects the training-mean baseline; parameterized fits remain nonconverged. Completion, convergence, identification and precision are distinct. Engineering Monte Carlo ranges, paired-row Sobol uncertainty and conditional joint-trajectory bootstrap have different meanings; none establishes general model stability or antibiotic-effect validation.

Local persistence is not backup. Replay requires exact built-in software and compares scientific output plus the full manifest; hashes do not authenticate sources. Browser automation and static-size audits do not establish a manual cross-browser/accessibility matrix, P95 performance or experimental validity.
