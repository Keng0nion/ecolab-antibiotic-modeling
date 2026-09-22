**目次：**

- [中国語](README.md)
- [英語](README.en.md)
- [日本語](README.ja.md)

# Ecolab 6.0.0

![Ecolab 学習界面のスクリーンショット](./docs/screenshot.png)

Ecolab は、ローカル優先・監査可能・再現可能な *E. coli*–抗生物質の個体群モデリングプロジェクトです。中英の Learn / Sandbox と、実データの Research Workspace を含みます。

> 教育、モデル探索、研究グレードの分析のため。臨床判断ツールではなく、条件マッチングで検証された汎用実験予測器でもありません。

## 読書ナビ

- [オンラインサイト](#オンラインサイト) · [バージョン契約](#バージョン契約) · [コマンド](#コマンド)
- [コードの仕組み](#コードの仕組み)
  - [1. 階層構造と呼び出しチェーン](#1-階層構造と呼び出しチェーン)
  - [2. 教育モデルと区分解析計算](#2-教育モデルと区分解析計算)
  - [3. 実データの取り込みと観測層](#3-実データの取り込みと観測層)
  - [4. フィッティング最適化とモデル比較](#4-フィッティング最適化とモデル比較)
  - [5. パラメータスキャンと感度分析](#5-パラメータスキャンと感度分析)
  - [6. 不確実性と同定可能性](#6-不確実性と同定可能性)
  - [7. ブラウザ描画とタスク実行](#7-ブラウザ描画とタスク実行)
  - [8. ローカル保存と復元](#8-ローカル保存と復元)
  - [9. 研究パッケージ検証と明示的リプレイ](#9-研究パッケージ検証と明示的リプレイ)
  - [10. ビルドテストとソース読解の順序](#10-ビルドテストとソース読解の順序)
- [ドキュメント](#ドキュメント) · [ライセンスとデータ帰属](#ライセンスとデータ帰属)

## オンラインサイト

- GitHub Pages: https://keng0nion.github.io/ecolab-antibiotic-modeling/
- `main` へのプッシュのたびに、`.github/workflows/deploy-pages.yml` が `npm run build:public` を実行し、公開リポジトリの材料を検証して `dist/web/` を自動公開します。

## バージョン契約

- アプリ：`6.0.0`
- 科学コア：`2.0.0`（教育ダイナミクスは不変）
- 分析エンジン：`2.0.0`（数値修正、OD モデル比較、同バージョンリプレイ）
- モデル：`ecolab.single-population.regoes-logistic@1.0.0`

ルートの `package.json` はアプリリリースバージョンの権威あるソースです。新版は教育用の Regoes/Logistic モデルを保持し、直接 OD スケールの Logistic/Gompertz、訓練データでの曲線全体の交差検証、曲線全体の結合 bootstrap、チェックサム検証付きの研究パッケージ同バージョンリプレイを新増しました。元の留保データは閲覧済みで、新しい結果は開発セット比較として明示的に標示され、未接触のテストセットや外部検証ではありません。

実際の `small` 例では、訓練交差検証が時間ごとの平均基線を選び、開発セットの macro RMSE は `0.00304756`。元の潜在個体群モデルは `0.00833386` で、依然基線に劣ります。パラメータモデルが収束しなかったこと、同定可能性と統計精度が不足している警告はすべて保持されています。未処理の OD600 データは 3 種の抗生物質の薬効を検証できず、絶対 CFU も特定できません。

## コマンド

Node.js 20.19 以降が必要。サードパーティの実行時依存はありません。

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

**公開 GitHub リポジトリから初めて実行する場合は、`npm run build:public` を推奨し、その後 `npm run preview` を実行**。`npm run dev` はソースディレクトリを直接提供し、ビルドや完全検査を実行しません。`npm start` は完全な `build` を実行した後、サービスを起動してデフォルトブラウザを開きますが、そのデータ監査にはローカルの生データ材料が必要で、公開リポジトリの clone だけではこれらの材料が揃うと想定できません。具体的な取得と監査の手順は[データ准入審査](./docs/data-candidate-review.md)を参照。

ターミナルで `Ctrl+C` を押すとサービスを停止します。デフォルトの成果物は `dist/core/` と `dist/web/`。両ビルドスクリプトは `--out-dir` を受け、隔離出力ディレクトリを指定できます。`npm run example:research` はバージョン化されたサンプルファイルを生成します。アルゴリズム変更後は、履歴の回帰差異を隠すためにサンプルを再生成しないでください。

## コードの仕組み

以下は現在の `6.0.0` ソースに基づき、実際のデータフロー、数学的計算、工学的制約を説明します。リンクは具体的な実装を指し、論文は方法の根拠を説明するものであり、本プロジェクトの条件マッチング実験検証の代替にはなりません。アプリは React、サードパーティオプティマイザー、遠隔計算サービスに依存せず、ネイティブの JavaScript ES Modules、DOM/SVG、Web Worker、IndexedDB を使用します。

### 1. 階層構造と呼び出しチェーン

コードは「モデルとは何か」「分析をどう行うか」「操作と保存をどう扱うか」を分けています：

```text
src/model.js                  教育科学 API 入口
src/model/                    単位、薬効関数、区分プロトコル、解析推進、観測マーク
src/registry/resolve.js        出所付きパラメータレジストリを凍結モデルスナップショットに解決
src/experiment/run-manifest.js 教育実行マニフェスト
src/analysis.js               研究分析 API 入口
src/analysis/                 フィッティング、スキャン、感度、不確実性、研究ワークフローとリプレイ
src/app/main.js               ページ起動、ルーティング、教育インタラクションと描画
src/app/research/              研究状態、コントローラ、インポート、チャートとエクスポート
src/app/workers/               JSON タスクプロトコル、ディスパッチクライアントと計算入口
src/app/persistence.js         IndexedDB と揮発メモリリポジトリ
```

**教育パス**：ページアクション → `experiment.js` がプロジェクトを更新 → `compileSimulationRequest()` が露出プロトコルをコンパイル → `simulatePiecewise()` が軌跡を返す → SVG チャート、データ表、数式説明。科学コアは DOM を読まず、データベースにアクセスせず、呼び出し側が明示的にモデルと入力を提供します。同一の API は Node.js テストとブラウザの両方から呼び出せます。

**研究パス**：ソーステキストをインポート → Worker が解析と品質チェック → コントローラが合格データを保存 → `TaskClient` が研究 Worker を起動 → `runEcolabResearchWorkflow()` → 結果、診断、研究パッケージ → ページ表示とローカル永続化。

現在の研究結合入口の内部順序は：

```text
runEcolabResearchWorkflow()                  research-upgrade.js
  ├─ 完全設定、モデルスナップショット、入力ハッシュ、種子を正規化
  ├─ runEcolabStage4ResearchWorkflow()       research-workflow.js
  │    データチェック → 潜在個体群の OD 校正 → 局所同定可能性診断
  │    → 開発比較の凍結 → パラメータスキャン → MC → 局所 / Morris / Sobol
  ├─ runGrowthModelComparison()             growth-comparison.js
  │    訓練曲線全体 CV → モデル選択 → 全訓練セット再フィット
  │    → 選択モデルの曲線全体 bootstrap → 開発比較の凍結
  └─ 証拠状態、warnings、マニフェスト、研究パッケージを集約
```

旧い `runEcolabStage4ResearchWorkflow()` は互換入口として残っており、成長曲線比較を含む完全な v2 ワークフローではありません。通常のデータインポート、汎用分析 API、内蔵 BW25113 ワンクリック研究フローも同じ准入範囲ではありません。

ソース：[科学入口](./src/model.js)、[分析入口](./src/analysis/index.js)、[教育プロジェクト](./src/app/experiment.js)、[研究結合入口](./src/analysis/research-upgrade.js)、[研究コントローラ](./src/app/research/controller.js)。

### 2. 教育モデルと区分解析計算

#### 2.1 パラメータを先に解決し、単位を先に統一

`resolveModelFromRegistries()` は正確な `id + version` でモデル定義とパラメータセットを検索し、重複・欠落・不一致の参照を拒否し、パラメータの単位と出所を確認した上で、深く凍結された `ResolvedModel` を生成します。パラメータ探索はコピーを使用し、文献パラメータレジストリに書き戻しません。

内部の単位は時間 `h`、濃度 `mg/L`、個体群 `log10(CFU/mL)`、純増殖率 `log10-fold/h` に統一されます。入力の分は時間に変換され、`µg/mL` と `mg/L` は数値的に等価。線形 CFU/mL は正でなければならず、未知の単位は直接エラーになり、推測や黙示的変換はしません。

- `psiMaxLog10PerHour = log10(2) / doublingTimeHours`。現在の教育倍増時間 `42 min` で約 `0.43004 log10-fold/h`。
- `carryingCapacityLog10CfuPerMl = 9`、すなわち `K = 10^9 CFU/mL`。教育上の仮定です。
- 各薬の `zMicMgPerL`、`hillKappa`、`psiMinLog10PerHour` は下文の `zMIC`、`κ`、`ψmin` に対応します。
- アンピシリンの 3 パラメータは `(3.4, 0.75, -4)`。テトラサイクリン `(0.67, 0.61, -8.1)`。シプロフロキサシン `(0.017, 1.1, -6.5)`。単位は順に `mg/L`、無次元、`log10-fold/h`。

3 薬の値は [Regoes et al. (2004), Table 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC521919/) の **CAB1/LB** 条件を参照します。成長基線は [BioNumbers 111767](https://bionumbers.hms.harvard.edu/bionumber.aspx?id=111767) / [Campos et al. (2014)](https://doi.org/10.1016/j.cell.2014.11.022) から。プロジェクトは条件をまたぐ移行マークを保持しており、BW25113/M9 下の薬効パラメータ推定とは呼べません。

ソース：[レジストリ解決](./src/registry/resolve.js)、[単位変換](./src/model/units.js)、[パラメータレジストリ](./data/registry/parameter-sets.json)、[出所インデックス](./data/registry/sources.json)。

#### 2.2 濃度がどう純増殖率になるか

単一薬の濃度 `C` に対し、`evaluateRegoesNetGrowth()` は以下を実装します：

```text
q(C) = (C / zMIC)^κ
ψ(C) = ψmax - (ψmax - ψmin) × q(C) / (q(C) - ψmin / ψmax)
```

この関数は `ψ(0)=ψmax`、`ψ(zMIC)=0` を満たし、高濃度で `ψmin` に近づきます。`zMIC` はモデルのゼロ純増殖濃度であり、臨床ブレークポイントではなく、出所論文の broth-dilution MIC とも等しくありません。後者は出所コンテキストとしてのみ保持されます。

実装はオーバーフローする可能性のある巨大な冪を直接計算せず、`C>0` の場合は以下に書き換えます：

```text
a = κ × ln(C/zMIC) - ln(-ψmin/ψmax)
w = sigmoid(a)
ψ = ψmax × (1-w) + ψmin × w
```

`sigmoid()` は正負で分岐して指数を計算します。ゼロ濃度は別途 `ψmax` を返し、絶対値が `1e-14` 未満の結果はゼロにし、ゼロ純増殖境界の丸め残差を避けます。ここで `ψ` は純変化率であり、コードは出生率と死亡率を別々に推定しないため、個体群の純減少量を累積死亡数と呼ぶことはできません。

ソース：[薬効関数と安定な数値表現](./src/model/regoes-logistic-v1.js)。

#### 2.3 個体群がどう推進するか、なぜ Euler 積分ではないか

濃度一定・長さ `Δt` の区間内で、`advancePopulationAnalytically()` は区分解析式を使用します：

```text
ψ > 0：dN/dt = ln(10) × ψ × N × (1 - N/K)
       N(t+Δt) = K / [1 + (K/N(t)-1) × exp(-ln(10) × ψ × Δt)]

ψ ≤ 0：d log10(N)/dt = ψ
       log10(N(t+Δt)) = log10(N(t)) + ψ × Δt
```

`ln(10)` は十進対数の増殖率を自然指数の増殖率に変換するために使われます。正の増殖分岐だけが収容容量制約を加えます。負の分岐は `1-N/K` を乗じません。そうしないと、個体群がちょうど K のときに密度因子で減少が止まるという誤った意味論になります。

極低個体群でのアンダーフローと K 近傍での相殺誤差を減らすため、正の増殖は実際には `N/K` の log-odds 座標で推進し、その後 `softplus`、`expm1`、`log1p` などの安定表現で対数個体群を復元し、線形 CFU を繰り返し計算しません。ゼロ増殖またはゼロ時間はそのまま状態を保持し、K を超える初期個体群は拒否されます。

`simulatePiecewise()` は複数の区間をつなぐ役割を担います：

1. プロトコルが 0 から始まり、各区間の長さが正、隣接区間が連続かつ重複しないことを検証。1 つのプロトコルは 1 種の薬のみ許可。
2. サンプル時刻が一意、厳密に単調増加、プロトコル内であることを検証し、シミュレーション起点と終点を補完。
3. 各目標サンプル時刻について、「サンプル時刻」と「現在区間の終点」の早い方まで推進。区間をまたぐ場合は継続して推進し、濃度変化をまたいで単一の定数で計算することは決してありません。
4. 区間は `[start,end)`、最後の終点は含まれます。境界で個体群は連続し、境界出力の濃度と `ψ` は右側の新規露出条件を使用します。
5. `observePopulation()` は別途 `belowDetectionLimit` を付与。検出限界は観測をマークするだけで、潜在個体群を検出限界やゼロに切り詰めません。

したがって、サンプル間隔は出力密度を制御するものであり、Euler/RK の時間ステップではありません。同じ定数露出を複数の区間に分割しても、浮動小数点許容内で同じ終態を保つべきです。シミュレーションは依然連続密度モデルであり、単細胞の確率的絶滅、耐性進化、持留亜群は含みません。

教育インタラクションの「投薬」はまず `pendingAction` を形成し、時間推進時に区間として確定します。隣接する同濃度区間は統合でき、アクション履歴は保持されます。「希釈／洗浄」は薬物濃度だけを変え、細菌数や培養体積は変えません。

ソース：[プロトコル検証](./src/model/protocol.js)、[区分ディスパッチ](./src/model/simulate-piecewise.js)、[解析推進](./src/model/regoes-logistic-v1.js)、[観測層](./src/model/observe.js)、[境界と検出限界テスト](./src/tests/model.test.js)。

#### 2.4 最小の実行可能科学 API 例

以下の ES module 例はリポジトリのルートを作業ディレクトリとし、Node.js の `--input-type=module` 標準入力方式で実行できます。実際のレジストリからモデルを解決し、1 時間の無薬増殖、その後 `4 × zMIC` のシプロフロキサシンを 1 時間適用するシミュレーションを行います。これらは教育プロトコルの入力であり、投薬推奨ではありません。

```js
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries, simulatePiecewise } from "./src/model.js";

const [modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all(
  ["model-definitions", "parameter-sets", "sources"].map(async (name) =>
    JSON.parse(await readFile(`data/registry/${name}.json`, "utf8")),
  ),
);
const model = resolveModelFromRegistries({
  modelRegistry,
  parameterRegistry,
  sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const zMic = model.parameters.drugs.ciprofloxacin.zMicMgPerL;
const result = simulatePiecewise(model, {
  initialState: { populationDensity: { value: 1e6, unit: "CFU/mL" } },
  protocol: {
    kind: "piecewise_constant",
    drugId: "ciprofloxacin",
    segments: [
      {
        start: { value: 0, unit: "h" },
        end: { value: 1, unit: "h" },
        concentration: { value: 0, unit: "mg/L" },
      },
      {
        start: { value: 1, unit: "h" },
        end: { value: 2, unit: "h" },
        concentration: { value: 4 * zMic, unit: "mg/L" },
      },
    ],
  },
  sampleTimes: [0, 0.5, 1, 1.5, 2].map((value) => ({ value, unit: "h" })),
  observation: { detectionLimit: { value: 10, unit: "CFU/mL" } },
});
console.table(result.trajectory);
```

返される各行は `timeHours`、`concentrationMgPerL`、`netGrowthLog10PerHour`、`latentLog10PopulationDensity` と検出限界マークを含みます。1 時間行の個体群は前 1 時間の無薬増殖を既に完了していますが、その行の濃度は新しく設定された `0.068 mg/L` です。これがまさに「状態連続、濃度右連続」であり、前の区間を先に新しい薬濃度で計算するのではありません。

### 3. 実データの取り込みと観測層

#### 3.1 ファイルから分析可能なデータへ

`dataset-import.js` の CSV パーサーは文字状態機械であり、引用符、エスケープされた二重引用符、カンマ、CRLF、BOM を処理し、規定の列集合、有限数値、ネストした JSON を検査します。インポートにはファイルサイズ、行・列数、フィールド長、ネスト深さの制限があります。単位を推測せず、自動平滑化や補点もしません。ブラウザの CSV インポートは、ユーザーが明示的に `datasetId`、タイトル、ライセンスを提供することを要求します。底層の公共インポート API のライセンスフィールドは任意ですが、ファイル名から出所やライセンスを自動推測することはありません。

ブラウザのインポートチェーンは `file.text()` → `dataset.parse` Worker → 正規化された `observation-dataset` → QC → データ記録。QC 合格のデータのみ永続化されます。汎用インポートは未バージョンのファイル出所として標示され、Figshare の署名、ライセンス証明、内蔵研究資格を自動的に継承しません。

内蔵データの読み込みは、正確なレジストリバージョン、正規化 JSON ソーステキストの SHA-256、観測数、分割も検証します。現在のワンクリック研究は BW25113 無薬の生 OD600 を対象とし、正確な時間を持つ曲線が完全であることを要求します。これは任意の CSV が同じ結合ワークフローを実行できるという意味ではありません。

ソース：[厳格インポート](./src/analysis/dataset-import.js)、[品質チェック](./src/analysis/dataset-quality.js)、[ブラウザのデータ読み込みと准入](./src/app/research/dataset-loader.js)、[正規化データと出所条件](./data/datasets/figshare-bw25113-growth-v1/README.md)。

#### 3.2 無薬 OD は直接絶対 CFU にはならない

実データは [Aida / Ying (2025), Figshare](https://doi.org/10.6084/m9.figshare.28342064.v1) から。12 曲線、528 点、0.5–22 時間、0.5 時間ごとに 1 観測、すべて無薬・ブランク未差し引きの OD600。訓練は 8 曲線／352 点、閲覧済み開発比較は 4 曲線／176 点。曲線ラベルは独立した生物実験バッチの証明にはなりません。

潜在個体群の校正は観測マッピングを導入します：

```text
OD(t) = b + s × N(t)/K
```

訓練目標の評価ごとに、まず生物パラメータで `N(t)/K` を生成し、次に `profileOdObservationLayer()` が制約付き OD 攪乱パラメータ `b≥0`、`s≥1e-12` を解析的に解きます：実行可能な非制約線形回帰解と境界候補を比較し、訓練 SSE 最小のものを取ります。これにより、数値オプティマイザーに 4 パラメータを同時に探索させずに済みます。開発評価の前に `b`、`s`、すべての生物パラメータを凍結し、開発観測で再校正しません。

このマッピングは実験的に較正された OD→CFU 変換ではありません。K は渡された `resolvedModel` スナップショットの値に固定され、OD データから推定されず、現在のデフォルトスナップショットは前述の教育値を使用します。現在のソースデータには t=0 がありません。モデルは時刻ゼロの初期状態から最初の観測まで推進できますが、ソースの t=0 測定を捏造しません。OD のブランクと機器依存の制限は [Stevenson et al. (2016)](https://doi.org/10.1038/srep38828) を参照。

ソース：[OD 観測マッピングと攪乱パラメータの解析的求解](./src/analysis/od-observation-model.js)、[訓練と凍結評価](./src/analysis/research-workflow.js)。

### 4. フィッティング最適化とモデル比較

#### 4.1 2 つのモデル、2 つの目的関数

**潜在個体群の校正**は `psiMaxLog10PerHour` と `initialStates.pooled.log10PopulationDensity` だけを探索します。範囲はそれぞれ `[0.05,0.8]` と `[3,min(8.5,Klog10−0.1)]`（`Klog10` はスナップショットの対数収容容量）。現在のデフォルト初期状態範囲は `[3,8.5]`。各評価で訓練 OD 観測層を再求解し、訓練観測の SSE を最小化します。3 薬の `zMIC`、`κ`、`ψmin` はフィットしません。

**直接 OD 比較**は 3 つの候補を使用します：正確な観測時刻の訓練平均基線、Logistic、Gompertz。パラメータ化曲線は：

```text
Logistic：f(t) = b + A / (1 + exp(-r × (t-ti)))
Gompertz：f(t) = b + A × exp(-exp(-r × (t-ti)))

J(θ) = (1/U) × Σu [(1/nu) × Σj (yuj - f(tuj;θ))²]
```

`U` は軌跡数、`nu` は軌跡 u の観測数。目標は**軌跡 MSE の等重み平均**であり、macro RMSE を直接最小化するのではありません。デフォルトで宣言される工学的境界は `b∈[0,0.3]`、`A∈[0.001,1]`、`r∈[0.001,4]`、`ti∈[0,30]` であり、開発データから逆算された生理範囲ではありません。

`r` は形状係数、`ti` は変曲点時刻。最大 OD 勾配はそれぞれ `A×r/4` と `A×r/e`。`b` は下漸近線であり、必ずしも `OD(0)` とは限りません。成長曲線比較の考えは [Zwietering et al. (1990)](https://doi.org/10.1128/aem.56.6.1875-1881.1990) を参照しますが、その log-個体群／生理増殖率／lag パラメータ化を装いません。

`training_mean` はパラメータを最適化しません：正確な訓練時刻でのみ平均を取り、補間しません。ある評価時刻に訓練サポートがなければ、その点を黙ってスキップしません。汎用の `fitParameters()` は明示的な誤差尺度の刈り込みガウス尤度も提供しますが、現在の無薬 OD 結合フローは最小二乗を使用します。API の対応能力を、この例が実際に使う方法として書くべきではありません。

ソース：[汎用フィッティング](./src/analysis/fitting.js)、[刈り込み尤度](./src/analysis/likelihood.js)、[直接 OD フィットと選択](./src/analysis/growth-comparison.js)。

#### 4.2 なぜ DE と Nelder–Mead を組み合わせるか

`optimizers.js` は有界最適化を自前で実装し、サードパーティのブラックボックスソルバーを呼び出しません：

1. **DE グローバル探索**：境界内で個体群を初期化し、目標ベクトルに 3 つの異なる候補を選び `xa + F × (xb-xc)` を構成。二項交叉は少なくとも 1 つの変異座標を強制し、範囲外の座標は境界に切り戻し、目標が悪化していない場合に受け入れます。デフォルト `F=0.8`、`CR=0.9`、受け入れ後すぐに個体群を更新。
2. **NM 局所精緻化**：DE の最良点を起点にシンプレックスを構築し、反射、拡張、収縮、縮小を実行。候補は依然境界制約を受けます。
3. **予算と再起動**：各段階に評価回数の上限があり、複数起点の再起動を設定可能。段階の種子、失敗候補、評価済み最良点、停止理由を保持します。NM は予算耗尽直前により良い点を見つけても、その点がまだシンプレックスに書き込まれていないという理由だけで失われることはありません。
4. **収束は必然ではない**：DE は個体群スパンと目標スパンの基準、NM はシンプレックススパンと目標スパンの基準を使用。`maximum_evaluations` は予算耗尽を意味し、大域最適が見つかったとは解釈できません。

2 つのフィットパスはどちらも DE→NM を組み合わせますが、潜在校正は `fitParameters()`／`optimizeBounded()` を経由し、直接 OD 比較は独自の段階結果選択ロジックを持ちます。同一のラッパー関数ではありません。オプティマイザーは渡されたパラメータ座標で探索します。局所感度/Morris がサポートする log 変換はオプティマイザーに自動適用されないため、「すべてのアルゴリズムが同じ正規化空間で実行される」と概括できません。

ソース：[DE、NM と最良点記録](./src/analysis/optimizers.js)、[パラメータホワイトリストと変換](./src/analysis/parameter-space.js)。

#### 4.3 時刻リークをどう避け、モデルを評価するか

`crossValidate()` はデフォルトで訓練軌跡の leave-one-out。軌跡 ID を明示的に提供して折を作ることもできますが、すべての訓練軌跡はちょうど 1 回留出されなければなりません。各折の 3 候補はその折の訓練部分のみを使用し、平均基線も再計算されます。全訓練セットの平均を借りることはできません。

評価はまず各軌跡の誤差を計算し、その後集計します：

```text
euj         = yuj - ŷuj
RMSEu       = sqrt(mean_j(euj²))
macro RMSE  = mean_u(RMSEu)
pooled RMSE = sqrt(ΣuΣj euj² / Σu nu)
MAE         = ΣuΣj |euj| / Σu nu
```

モデル選択はすべての out-of-fold 軌跡の macro RMSE を使用し、異なるサイズの折のスコアを直接無重み平均しません。スコアが大域最小値のデフォルト絶対 `1e-10` 許容内にある場合（`crossValidation.tieTolerance` で設定可能）、事前宣言された優先順位は `training_mean → logistic → gompertz`。採点可能だが未収束の候補も診断スコアを保持するため、「比較された」は「十分に最適化された」とは限りません。

凍結選択の後、候補は全訓練軌跡で再フィットされます。選択されたモデルに bootstrap を行い、最後に訓練平均基線と共に開発データを評価します。ソースは歴史的な `validation` ロールフィールドを保持していますが、現在の結果は明示的に `previously_viewed_development_only` であり、未接触のテストセットではありません。

固定 `small`、種子 `123456789` の実際の記録：CV は平均基線を選択。開発 macro RMSE は **0.00304756 OD**、MAE は **0.00239205 OD**。元の潜在モデルの macro RMSE は **0.00833386 OD** で、未収束。直接 Logistic/Gompertz も各 CV 折で未収束のため、これは新しいモデルが予測精度を向上させた証拠ではありません。

ソース：[CV と凍結比較](./src/analysis/growth-comparison.js)、[指標集計](./src/analysis/metrics.js)、[バージョン化された実際の結果](./data/examples/ecolab-stage6-research-6.0.0.md)。

### 5. パラメータスキャンと感度分析

分析アルゴリズムは evaluator を通じて「パラメータ → 有限数値出力」のマッピングを受け取り、チャートを直接操作しません。**現在の結合ワークフローのパラメータスキャン、MC、局所/Morris/Sobol 感度分析は統一的に、潜在モデルの 10 時間での予測 OD600 を調べ、訓練で得た OD 観測層を凍結します**。新増の Logistic/Gompertz の 4 パラメータや 3 薬に対する統一的なランキングではありません。

- **パラメータスキャン**：`parameter-scan.js` は宣言されたグリッドの直積組み合わせを列挙し、モデルのコピーを点ごとにカバーして出力を記録。応答面探索であり、自動最適化や信頼区間ではありません。
- **局所有限差分**：`localSensitivity()` は指定された変換座標でステップを選択し、中心差分を優先、境界付近では片側差分に切り替え。実際のステップと差分方向を記録します。得られるのは局所導数であり、自動正規化された弾力性やグローバルな重要度ではありません。
- **Morris**：変換後のパラメータ範囲にグリッドを立て、`[0,1]` 単位立方体にマッピング。各軌跡はパラメータの訪問順序をランダムに並べ替え、1 回に 1 つのパラメータだけを変更。k 個のパラメータには軌跡ごとに `k+1` 回の評価が必要。基本効果は `EEi = Δf / (±Δ)`、分母は正規化されたステップで、符号付き平均 `μ`、絶対値平均 `μ*`、標本標準偏差 `σ` を報告します。軌跡が 1 本のみの場合 `σ=null`（ゼロではありません）。
- **Sobol–Jansen**：宣言された独立入力分布から A、B を生成し、A の i 列を B に置き換えて `A_Bi` を得ます。基礎計算量は `n×(k+2)` 回の evaluator 呼び出し。V は A/B 出力を統合した後の標本分散。推定式は：

```text
STi = Σj [f(Aj) - f(A_Bi,j)]² / (2nV)
S1i = 1 - Σj [f(Bj) - f(A_Bi,j)]² / (2nV)
```

Sobol は相関入力を拒否します。ここでは擬似ランダムサンプリングを使用し、Sobol の低差異系列ではありません。ペア行 bootstrap は A/B/全混合マトリクスに同じ行インデックスを使用し、モデルを再呼び出しせずに指数を再推定します。出力は負の指数、`S1>ST`、区間幅、テール標本の警告を保持し、表面的に合理的な結果に切り詰めず、精度不足で自動的にサンプルを追加することもありません。

リソースチェックは異なる層で有効です：例えば公共 Sobol API は bootstrap を最大 2000 回に制限し、`2×B×n×パラメータ数×出力数 ≤ 100,000,000` を検査します。ワークフローは別にスキャン、MC、軌跡予算を制限します。これらは計算量の制約であり、壁時計時間の保証ではありません。

ソース：[スキャン](./src/analysis/parameter-scan.js)、[局所](./src/analysis/sensitivity-local.js)、[Morris](./src/analysis/sensitivity-morris.js)、[Sobol–Jansen](./src/analysis/sensitivity-sobol.js)。方法の根拠：[Morris 1991](https://doi.org/10.2307/1269043)、[Jansen 1999](https://doi.org/10.1016/S0010-4655(98)00154-4)、[Saltelli 2010](https://doi.org/10.1016/j.cpc.2009.09.018)。

### 6. 不確実性と同定可能性

#### 6.1 3 種のリサンプリングは異なる質問に答える

**工学範囲のモンテカルロ**は宣言されたパラメータ分布からサンプリングし、モデル出力へ伝播します。`runMonteCarlo()` は Welford アルゴリズムで成功サンプルの平均と標本分散を集計し、数値を保存して R7 分位数のためにソートします。evaluator の失敗を記録し、全失敗の場合は統計量の返却を拒否します。現在のワークフローの独立三角範囲は工学探索であり、データから推定されたパラメータの事後分布ではなく、観測ノイズを自動生成することもありません。この実装は結果と分位数サンプルを保持し、定数メモリアルゴリズムではありません。

**Sobol ペア行 bootstrap** は、与えられた入力分布と evaluator の下でのモンテカルロ指数のサンプリング誤差を推定します。データ誤差やモデル誤設定はカバーしません。

**訓練曲線全体の bootstrap** は完全な軌跡を復元抽出し、各曲線内の時刻—観測ペアと重複抽出回数を保持し、固定された選択済みモデルを再フィットします。結合パラメータベクトル、平均曲線、種子、収束状況、失敗を保存します。有限・収束・予測が完全な再フィットのみが R7 分位区間に入ります。区間は固定モデル、境界、成功再フィット条件下での探索結果であり、選択の不確実性と新しい観測ノイズを含まず、同時信頼帯でもありません。

パラメータなしの平均基線が選択された場合、パラメータ区間は空です。少なくとも 2 回の成功し予測サポートが完全な bootstrap 再フィットがあれば、点ごとの平均曲線区間を生成できます。bootstrap が無効または成功サンプル不足の場合、区間は生成されません。現在の例は bootstrap 20 回。95% 区間では各テールの期待サンプルは 0.5 にすぎず、20/20 成功でも信頼できる信頼カバレッジを主張できません。曲線の独立性はまだ十分に確認されておらず、結合パラメータサンプルを独立した周辺に分解して Sobol 入力と装うこともできません。

ソース：[MC と R7 分位数](./src/analysis/monte-carlo.js)、[分布サンプリング](./src/analysis/distributions.js)、[曲線全体 bootstrap](./src/analysis/growth-comparison.js)。

#### 6.2 同定可能性はフィットの良さのスコアではない

`numericalJacobian()` は有限差分でパラメータが出力への応答を推定し、パラメータ境界スパンと出力スケールで正規化します。`analyzeIdentifiability()` は `JᵀJ` を構築し、対称固有値分解でランク、特異値、条件数診断を得て、境界ヒット、ほぼ最適な複数起点のパラメータ分離、局所相関を検査します。

ランク落ちの場合、パラメータの共分散／相関行列は利用できません。保持された擬似逆行列は幾何学的診断のみに使われます。満ランクでも、互換フィールドの逆情報行列はノイズ較正されておらず、信頼できるパラメータ共分散や信頼区間として扱えません。

現在の `objectiveSlices` は、残りの生物パラメータを固定して 1 つのパラメータをスキャンし、同時に OD 攪乱パラメータを再求解します。これは **nuisance-profiled objective slice** です。他のすべてのパラメータが十分に最適化された完全な profile likelihood ではなく、スキャンの端点も信頼限界ではありません。旧 `profiles` は互換エイリアスのみです。区別は [Raue et al. (2009)](https://doi.org/10.1093/bioinformatics/btp358) を参照。

システムはそのため `completed`、`converged`、`identified`、`precisionAssessed` を別々に記録します。現在の成長比較はパラメータの同定可能性と区間カバレッジをまだ確立しておらず、ワークフローが正常終了してもこれらのラベルを自動的に true にすることはありません。

ソース：[ヤコビアン、ランクと目標スライス](./src/analysis/identifiability.js)、[全体証拠状態](./src/analysis/research-upgrade.js)。

#### 6.3 確率過程はどう再現するか

`random.js` は `xoshiro128ss-splitmix32-v1` を実装します：uint32 の根種子は SplitMix32 で状態に拡張され、その後 xoshiro128** が乱数を生成します。`deriveSeed()` は根種子と安定な識別子から子種子を派生させ、母流の状態を消費しません。

MC は「サンプルインデックス＋パラメータ名」、Morris は軌跡、Sobol は「マトリクス＋行＋パラメータ」、フィット/bootstrap は段階ごとに子流を派生させ、結果が 1 回の暗黙的なグローバル乱数呼び出し順序だけに依存することを避けます。研究パッケージは根種子、派生種子、アルゴリズム識別子を記録します。固定種子は同一の入力、予算、境界、互換実装と組み合わせる必要があります。暗号学的ランダムではなく、任意のソフトバージョンや実行時でのバイト単位の一致も保証しません。

ソース：[乱数と子流](./src/analysis/random.js)。

### 7. ブラウザ描画とタスク実行

#### 7.1 ページがどう更新されるか

`main.js` は教育プロジェクト、研究状態、ビュー状態を保持します。ルートノードは `click/change/keydown` イベントを委譲し、`data-action` でアクションをディスパッチし、Hash ルーティングが Learn、Sandbox、Research を区別します。主要な描画方式は HTML テンプレートによる DOM 再構築とその後の SVG 描画であり、仮想 DOM diff ではありません。`main.js` がフォーカスを復元し、`ui-state.js` が安定キーを持つスクロール位置の復元を補助します。

研究ページは controller / state / view / charts で分担します。進捗メッセージは進捗バーとテキストだけを更新し、メッセージごとにページ全体を再構築することを避けます。ビューはテキストと属性をエスケープし、出所リンクは HTTP(S) に制限されます。

**教育計算と研究計算のスレッドは異なります**：教育の `deriveScientificView()` はメインスレッドで解析シミュレーションを呼び出し、教育の再生はサンプル間隔でプロジェクトを推進します。研究データの解析、分析、研究パッケージの複算は Worker を使用します。ページを切り替えると教育の再生は停止しますが、Research を離れると研究タスクが自動的にキャンセルされると約束することはできません。

ソース：[ページ入口](./src/app/main.js)、[スクロール状態](./src/app/ui-state.js)、[研究状態](./src/app/research/state.js)、[研究ビュー](./src/app/research/view.js)、[研究チャート](./src/app/research/charts.js)。

#### 7.2 タスクのキューイング、キャンセル、遅到メッセージの上書き防止

`TaskClient.run()` は JSON タスクを検証してコピーし、`taskId` を割り当て、キューに入れ、Promise と cancel を持つハンドルを返し、`AbortSignal` に対応します。汎用クライアントのデフォルト同時実行は 2、研究 UI は 1。実行中のタスクごとに専用の module Worker を作成し、常駐 Worker プールを再利用せず、デフォルトの実行タイムアウトは 5 分です。

研究 UI が実際に提出するのは `dataset.parse`、`analysis.research-workflow`、`research.package-inspect`、`research.package-replay`。汎用プロトコルにはフィット、スキャン、MC、感度などのタスクタイプもありますが、UI に対応する独立した提出入口があるという意味ではありません。

Worker は `dispatchTask()` で内蔵 API を呼び出し、progress/result/error envelope を返します。プロトコルは関数、ループ、危険なオブジェクトキー、非有限 JSON を拒否します。パッケージタスクは入力テキストのみを受け付け、任意の実行コードは指定できません。クライアントは envelope、タスク ID、実行状態を検査し、すでに確定したタスクの遅到メッセージは無視されます。

キュー内タスクのキャンセルはキューから取り除きます。実行中タスクのキャンセルは直接 Worker を `terminate()` し、`TASK_CANCELLED` で Promise を拒否します。成功、エラー、キャンセル、タイムアウトはいずれもタイマー、リスナー、Worker を清理し、同時実行スロットを解放します。分析 API 自体に協調式の checkpoint がありますが、ブラウザのキャンセルは 1 つの長い同期ループが取消メッセージを適時に処理することに依存せず、部分計算を成功結果として保存することもありません。

ソース：[タスククライアント](./src/app/workers/task-client.js)、[JSON プロトコル](./src/app/workers/task-protocol.js)、[Worker ディスパッチ](./src/app/workers/analysis-worker.js)、[研究 Worker 入口](./src/app/research/research-worker.js)。

### 8. ローカル保存と復元

`createProjectRepository()` は IndexedDB データベース `ecolab-local`、データベースバージョン 2 を使用し、`projects`、`datasets`、`analyses` の 3 つの object store を含み、いずれも `id` で保存します。

- **起動時の降格**：まず実際の読み書きプローブを実行します。IndexedDB が利用不可、ブロック、初期化失敗、タイムアウトの場合、Map ベースのセッション内リポジトリを返し、揮発ストレージの状態を UI に露出します。IndexedDB 使用後に実行時の割り当てエラーが発生した場合、明示的に `PERSISTENCE_QUOTA_EXCEEDED` を報告し、黙ってメモリに切り替えて保存成功と主張することはありません。
- **同時書き込み**：レコードの更新は既存の `revision` との一致を要求し、成功後に増加します。IndexedDB は同一の readwrite transaction で読み取り、比較、書き込みを完了します。衝突はエラーになり、自動統合や最終書き込み勝ちではありません。
- **教育プロジェクト**：初期状態、プロトコル区間、アクション、参照、タイムスタンプを保存します。復元は明示的に最新プロジェクトを選択し、現在読み込まれたモデルで再計算します。実行中タスクの自動復元ではなく、教育アーカイブがバージョンをまたいで正確にリプレイできる保証もありません。
- **研究データ**：正確な `sourceText`、形式、内容ハッシュ、正規化データ、出所、QC、revision を保存します。同じ ID/内容ハッシュは再利用でき、意味のない revision 増加を避けます。
- **研究結果**：完了した結果と `datasetRef` を保存します。復元は `id + revision + contentHash` を同時にマッチさせる必要があり、そうでなければ古い結果を新しいデータに添付しません。実行中の記録は interrupted として扱われ、中断からの再開計算には対応していません。

ストレージ復元の関連チェックは、データハッシュの再計算や科学複算ではありません。ユーザーがサイトデータを消去、ブラウザがストレージを回収、またはメモリ降格後の更新も記録を失う可能性があります。重要な作業は研究パッケージとして書き出してください。CSV はデータ交換／閲覧の材料としてより適しており、現在の出所前文と数式ガード付きのエクスポートが直接無損失で再インポートできるとは約束できません。

ソース：[リポジトリと移行](./src/app/persistence.js)、[研究記録の構築と復元マッチング](./src/app/research/controller.js)、[エクスポート](./src/app/research/export.js)。

### 9. 研究パッケージ検証と明示的リプレイ

#### 9.1 パッケージに何を保存するか

`buildArtifacts()` は正規化された観測データ、split、ロックされた分析計画、解決済みモデルスナップショット、完全な replay input、科学結果を集約します。Replay input は正確なソーステキストとハッシュ、形式、モデル、完全な設定と予算、根／派生種子、バージョン識別子を含みます。関数コールバックはシリアライズされません。

Manifest はソフトと実装のバージョン、パラメータ／出所、データと split の指紋、アルゴリズム設定、停止設定と予算、失敗と収束情報、診断、証拠状態、warnings を記録します。各段階の実際の `terminationReason` は科学結果の最適化診断に保持されます。`buildResearchPackage()` は各内容の `id/role/path/mediaType/SHA-256/UTF-8 byteLength` 目録を生成します。

文字列は元テキストでハッシュします。JSON はオブジェクトキーを再帰的にソートし、配列順序を保持する canonical serialization でハッシュします。**元のワークブックハッシュ、正規化 JSON ファイルテキストハッシュ、正規化オブジェクト指紋は異なるオブジェクトのハッシュであり**、混用できません。SHA-256 は WebCrypto または純 JavaScript フォールバックを使用し、内容をアップロードする必要はありません。

ソース：[成果物の組立](./src/analysis/research-upgrade.js)、[マニフェストとパッケージ構築](./src/analysis/analysis-manifest.js)、[canonical JSON とハッシュ](./src/analysis/fingerprint.js)。

#### 9.2 なぜインポートは直接計算を開始しないか

`inspectResearchPackage()` はまず厳格な検査を行います：

1. JSON/schema、フィールド、リソースの制限。例えば最大 32 MiB、64 個の artifacts。
2. 内容ハッシュと UTF-8 長さ、一意の ID、大文字小文字を区別しない一意のパス、目録と内容の一対一対応。パス・トラバーサルと URL 型パスは拒否されます。パッケージ内のパスはラベルのみで、ファイル読み取りやネットワークダウンロードには使用されません。
3. 正規化データ、split、モデルスナップショット、ロックされた計画、manifest の身元／指紋の関連。
4. 完全な replay input、ソーステキスト SHA、ソーステキストの再解析後の正規化データとの一致、種子、設定、バージョンなどの関連。

適用される構造・完全性・関連検査を通過した旧式パッケージ（バージョン化された replay input が欠落）、またはバージョン／実装が互換しないパッケージは閲覧のみ可能です。新版リプレイを宣言するパッケージで必要な成果物やオプションが欠落している場合、拒否されます。現在の再計算可能ホワイトリストは正確なアプリ／エンジン／モデル／ワークフロー実装と依存宣言を要求し、緩い semver ではありません。パッケージはデータと設定を持ちますが実行可能なソフトはなく、現在のビルドは明示的に `selfContained:false` を宣言し、依存をインストールしたりパッケージ内コードを実行したりしません。

UI インポートは inspect のみ行い、ユーザーが明示的にリプレイをクリックします。パッケージプレビューは現在データと保存済み結果から分離され、自動的にリポジトリに書き込んだり現在の研究を置き換えたりしません。

#### 9.3 リプレイがどうマッチを判定するか

`replayResearchPackage()` はパッケージを再検査し、内蔵の `runEcolabResearchWorkflow()` を呼び出して再計算し、同時に比較します：**科学結果の投影と完全な analysis manifest**。いくつかの集計指標だけを照合するのではありません。変更された収束結論や誤差リストを再ハッシュするだけでは、実際の複算を自動的に通過しません。

デフォルトの数値比較ルールは：

```text
|a-b| ≤ 1e-10 + 1e-8 × max(|a|, |b|)
```

オブジェクトキー、タイプ、配列の長さ／順序、その他の非数値は厳密に比較されます。科学投影は `createdAt` を除外しますが、完全な manifest は比較に参加します。Methods テキストは完全性検査を受けますが、再生成された文案との意味的比較は行わないため、`matched` はパッケージ全体がバイト単位で一致するという意味ではありません。

ランタイム横断パッチは、双方が自身の構造化フィールドに厳密に準拠している閉じた警告テンプレートだけの重複数値テキストを処理します：既知の出所を持つ 2 つの強相関警告、および有限の高条件数警告。テンプレートが完全に一致する場合のみ、重複した `message` 文字列比較をスキップします。構造化数値、code/source/パラメータ、その他のフィールドは通常通り検査されます。未知のテンプレート、追加結論、制限文言の削除は免除されません。

したがって区別が必要です：**完全性通過 ≠ 出所が本物。再計算可能 ≠ リプレイマッチ。リプレイマッチ ≠ 科学的に有効、またはパラメータが同定済み。** `replayable` は試行可能を意味するだけで、`matched` が規定の比較ルール下で結果が一致することを意味します。

ブラウザでバージョン化された例をインポートする際は、[6.0.0 例 JSON](./data/examples/ecolab-stage6-research-6.0.0.json) 内の `researchPackage` を使用し、外層の例ラッパーではありません。ブラウザ自身がエクスポートした研究パッケージは直接インポートできます。

ソース：[厳格検査、互換判定、リプレイ比較](./src/analysis/research-replay.js)、[閉じた数値警告テンプレート](./src/analysis/replay-warning-equivalence.js)。

### 10. ビルドテストとソース読解の順序

#### 10.1 同じソースがどう Core と Web として公開されるか

ビルドスクリプトは bundler でトランスパイルせず、公開境界に沿ってネイティブ ES modules、レジストリ、正規化データ、schemas をコピーし、テストと生の XLSX を除外します：

- `build-core.js` は `dist/core/` を生成し、パッケージ入口と `./model`、`./analysis` サブパスを書き込み、実際に検査 API をインポートします。
- `build-web.js` は `dist/web/` を生成し、GitHub Pages サブディレクトリに合わせて相対リソースパスを保持し、入口と Worker を検査し、生データとテストファイルの誤混入を拒否します。
- `audit-release.js` はバージョン、Markdown ローカルリンク、リリースサイズ予算、サンプルの厳格インポート、実際のリプレイを検査し、ソート済みの SHA-256 ファイル目録を生成します。
- `check-reproducible-build.js` は 2 つの独立した一時ディレクトリでそれぞれビルドし、各成果物のパス、バイト数、SHA-256 を比較します。「ビルドが再現可能」と「研究結果が許容内で再現」は 2 つの異なる契約です。

公開デプロイは `build:public` を実行し、公開可能な材料でリリーステストと監査を行います。完全な `build` はさらにローカル生データ監査と全量テストを含みます。GitHub Pages は静的ファイルを提供し、Node.js バックエンドを実行しません。Pages は `_headers` を適用せず、ファイルが存在するだけでカスタムセキュリティヘッダーが有効になったと考えることはできません。

ソース：[Core ビルド](./scripts/build-core.js)、[Web ビルド](./scripts/build-web.js)、[リリース監査](./scripts/audit-release.js)、[再現可能ビルド](./scripts/check-reproducible-build.js)、[Pages workflow](./.github/workflows/deploy-pages.yml)。

#### 10.2 テストが何を証明するか

テストは Node.js 内蔵の `node:test` を使用し、主にモジュール境界で組織されます：

- [科学コアテスト](./src/tests/)：単位、レジストリ、Regoes ゼロ点／極限、解析推進の組合性、プロトコル境界と検出限界。
- [分析テスト](./src/analysis/tests/)：目的関数、最適化予算、感度の正規化／ペアリング、診断、CV/bootstrap、パッケージ検査とリプレイのネガティブケース。
- [アプリテスト](./src/app/tests/)：プロジェクトアクション、状態、タスクプロトコル／キャンセル、保存の衝突と復元の関連。
- [リリーステスト](./scripts/tests/)：バージョン、ビルド境界、履歴サンプルの凍結、リリース監査と重複ビルド。

`npm test` は全量を実行。`npm run test:release` はリリースサブセットを実行。`npm run audit:release` は既存ビルド成果物を検査。`npm run check:reproducible` は重複ビルドを独立検証します。ソフトウェアのテストは菌株／培養条件のマッチング、実験の汎化、信頼カバレッジ、臨床有効性を証明できません。過去の実行結果と未完了の手動ブラウザ／アクセシビリティ／性能検証は[リリースチェックリスト](./docs/release-checklist.md)にあります。

初めてコードを読む場合の推奨順序：

1. [パラメータレジストリ](./data/registry/parameter-sets.json) → [resolve.js](./src/registry/resolve.js)：単位、出所、モデルスナップショットを理解。
2. [regoes-logistic-v1.js](./src/model/regoes-logistic-v1.js) → [simulate-piecewise.js](./src/model/simulate-piecewise.js)：濃度から個体群軌跡までを理解。
3. [research-workflow.js](./src/analysis/research-workflow.js) → [growth-comparison.js](./src/analysis/growth-comparison.js) → [research-upgrade.js](./src/analysis/research-upgrade.js)：潜在モデル校正、直接 OD 比較、最終結合を区別。
4. [研究コントローラ](./src/app/research/controller.js) → [TaskClient](./src/app/workers/task-client.js) → [persistence.js](./src/app/persistence.js)：ブラウザのライフサイクルと保存を理解。
5. [analysis-manifest.js](./src/analysis/analysis-manifest.js) → [research-replay.js](./src/analysis/research-replay.js)：完全性検査と実際の科学複算の区別を理解。

## ドキュメント

- [今回の詳細更新説明](./docs/release-notes-6.0.0.md)
- [プロジェクト概要](./docs/project-overview.md)
- [システムアーキテクチャ](./docs/architecture.md)
- [科学コア](./docs/scientific-core.md)
- [Learn / Sandbox](./docs/interactive-app.md)
- [Research Workspace](./docs/research-workspace.md)
- [限界](./docs/limitations.md)
- [プロジェクト紹介と実際の結果](./docs/portfolio-case-study.md)
- [方程式、パラメータ、論文の証拠](./docs/research-method-evidence.md)
- [デプロイ](./docs/deployment.md)
- [メンテナンス、バージョン、データ更新](./docs/maintenance.md)
- [リリースチェックリスト](./docs/release-checklist.md)
- [データ准入審査](./docs/data-candidate-review.md)
- [技術ブループリント](./blueprints/README.md)

## ライセンスとデータ帰属

Ecolab 自有のコードは [MIT License](./LICENSE) で公開され、著作権 © 2026 Kengo Kubota。リポジトリ内のサードパーティデータ、論文、出所材料はコードのライセンスによって再ライセンスされません。内蔵の Figshare BW25113 データは引き続き元の `CC BY 4.0` ライセンスと、データカードの署名・出所要件に従います。

バージョン化された生成サンプル：

- [Current 6.0.0 Markdown](./data/examples/ecolab-stage6-research-6.0.0.md)
- [Current 6.0.0 JSON](./data/examples/ecolab-stage6-research-6.0.0.json)
- [Frozen historical 5.0.0 Markdown](./data/examples/ecolab-stage5-small-research-5.0.0.md)
- [Frozen historical 5.0.0 JSON](./data/examples/ecolab-stage5-small-research-5.0.0.json)

研究データの解析、分析、複算はローカル Worker で実行され、教育の解析シミュレーションはブラウザのメインスレッドで実行されます。合格データのソーステキストと研究結果は IndexedDB に保存されます。初期化が利用不可の場合は揮発メモリを使用し、実行時の割り当て失敗は明示的にエラー報告されます。研究パッケージはデータと完全な入力を含みますが、正確にマッチする内蔵ソフトが必要であり、独立した実行可能ファイルではありません。旧パッケージは検証・閲覧可能で、完全な入力が欠落またはバージョン互換しない場合は複算を拒否します。静的リソースの初回読み込みにはデプロイサイトへのアクセスが必要です。ユーザーデータは分析サーバーにアップロードされません。

## さらなる読み物

より多くのプロジェクトと記事は私の個人サイトにあります：[keng0nion.github.io](https://keng0nion.github.io/)。
