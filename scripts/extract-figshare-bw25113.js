import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_FILES, SOURCE_METADATA, verifySourceBuffer } from "./acquire-figshare-bw25113.js";
import { columnNumberToName, openXlsx, worksheetRecords } from "./lib/xlsx-reader.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

export const DATASET_ID = "figshare-bw25113-growth-v1";
export const DATASET_VERSION = "1.0.0";
export const OUTPUT_FILES = Object.freeze({
  json: `${DATASET_ID}.json`,
  csv: `${DATASET_ID}.csv`,
  readme: "README.md",
  checksums: "checksums.json",
});
export const SELECTED_LABELS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `Curve${String(index + 25).padStart(5, "0")}`),
);
export const TRAINING_LABELS = Object.freeze(SELECTED_LABELS.slice(0, 8));
export const VALIDATION_LABELS = Object.freeze(SELECTED_LABELS.slice(8));
export const SELECTED_TIMES = Object.freeze(Array.from({ length: 44 }, (_, index) => (index + 1) / 2));

const COMPOSITION_HEADERS = Object.freeze([
  "K2HPO4\r\n(mM)",
  "KH2PO4\r\n(mM)",
  "Na2HPO4\r\n(mM)",
  "Glucose\r\n(mM)",
  "(NH4)2SO4\r\n(mM)",
  "NH4Cl\r\n(mM)",
  "Alanine\r\n(mM)",
  "Arginine/HCl\r\n(mM)",
  "Asparagine/H2O\r\n(mM)",
  "AsparticAcid\r\n(mM)",
  "Cystine/HCl/H2O\r\n(mM)",
  "GlutamicAcid/HCl\r\n(mM)",
  "Glutamine\r\n(mM)",
  "Glycine\r\n(mM)",
  "Histidine/HCl/H2O\r\n(mM)",
  "Isoleucine\r\n(mM)",
  "Leucine\r\n(mM)",
  "Lysine/HCl\r\n(mM)",
  "Methionine\r\n(mM)",
  "Phenylalanine\r\n(mM)",
  "Proline\r\n(mM)",
  "Serine\r\n(mM)",
  "Threonine\r\n(mM)",
  "Tryptophan\r\n(mM)",
  "Tyrosine\r\n(mM)",
  "Valine\r\n(mM)",
  "KCl\r\n(mM)",
  "NaCl\r\n(mM)",
  "MgSO4/7H2O\r\n(mM)",
  "MgCl2/6H2O\r\n(mM)",
  "CaCl2/2H2O\r\n(mM)",
  "CaSO4/2H2O\r\n(mM)",
  "Na3C6H5O7/2H2O\r\n(mM)",
  "Na2S2O3/5H2O\r\n(mM)",
  "FeSO4/7H2O\r\n(mM)",
  "CuSO4/5H2O\r\n(mM)",
  "Na2MoO4/2H2O\r\n(mM)",
  "ZuSO4/7H2O\r\n(mM)",
  "Thiamine/HCl\r\n(mM)",
  "Pyridoxine\r\n(mM)",
  "FolicAcid\r\n(mM)",
  "Riboflavin\r\n(mM)",
  "H3BO3\r\n(mM)",
  "AminobenzoicAcid\r\n(mM)",
]);
const COMPOSITION_WORKBOOK_HEADERS = Object.freeze(["Label", "Assay ID", "Condition ID", ...COMPOSITION_HEADERS]);
const EVALUATION_HEADERS = Object.freeze(["Label", "Assay ID", "Condition ID", "K", "r", "K_info", "r_info"]);
const CSV_HEADERS = Object.freeze([
  "observationId",
  "seriesId",
  "independentUnitId",
  "role",
  "timeHours",
  "drugId",
  "concentrationMgPerL",
  "measurementType",
  "value",
  "censoring",
  "censoringBounds",
  "replicate",
  "conditions",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertArrayEqual(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array.`);
  assert(actual.length === expected.length, `${label} has ${actual.length} entries; expected ${expected.length}.`);
  for (let index = 0; index < expected.length; index += 1) {
    assert(actual[index] === expected[index], `${label}[${index}] is ${JSON.stringify(actual[index])}; expected ${JSON.stringify(expected[index])}.`);
  }
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function bytes(contents) {
  return Buffer.byteLength(contents, "utf8");
}

function canonicalComparable(value) {
  if (Array.isArray(value)) return value.map(canonicalComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalComparable(value[key])]));
  }
  return value;
}

function assertSameRecord(actual, expected, label) {
  assert(
    JSON.stringify(canonicalComparable(actual)) === JSON.stringify(canonicalComparable(expected)),
    `${label} differs across selected labels.`,
  );
}

function uniqueRecordMap(records, key, workbookLabel) {
  const map = new Map();
  for (const record of records) {
    const value = record.values[key];
    assert(typeof value === "string" && value !== "", `${workbookLabel} row ${record.rowNumber} has no ${key}.`);
    assert(!map.has(value), `${workbookLabel} has duplicate ${key} ${value}.`);
    map.set(value, record);
  }
  return map;
}

function mediumCompositionFromRecord(record) {
  return COMPOSITION_HEADERS.map((sourceHeader) => {
    const concentrationMm = record[sourceHeader];
    assert(Number.isFinite(concentrationMm), `Composition value ${JSON.stringify(sourceHeader)} is not finite.`);
    return {
      component: sourceHeader.slice(0, -"\r\n(mM)".length),
      sourceHeader,
      concentrationMm,
    };
  });
}

function buildConditions(composition) {
  return {
    organism: "Escherichia coli",
    strain: "BW25113",
    medium: {
      type: "chemically defined medium",
      conditionId: "Cond00003",
      compositionUnit: "mM",
      composition,
    },
    temperatureC: 37,
    plateFormat: "96-well plate",
    workingVolumeUl: 200,
    shakingRpm: 567,
    inoculationDilution: "1:1000",
    plateReader: "Epoch2",
    samplingIntervalMinutes: 30,
    treatment: "untreated",
    antibioticExposure: false,
    rawOdBlankCorrection: "none; source OD600 values are unblanked",
  };
}

function csvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function observationsToCsv(observations) {
  const lines = [CSV_HEADERS.join(",")];
  for (const observation of observations) {
    lines.push(CSV_HEADERS.map((header) => {
      const value = header === "conditions" || header === "censoringBounds"
        ? JSON.stringify(observation[header])
        : observation[header];
      return csvField(value);
    }).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function compositionTable(composition) {
  return composition.map((entry) => `| \`${entry.sourceHeader.replace("\r\n", "\\r\\n")}\` | ${entry.concentrationMm} |`).join("\n");
}

function dataCard({ composition, jsonHash, csvHash }) {
  return `# Figshare BW25113 growth baseline v1 / Figshare BW25113 生长基线 v1

## English

### Identity and attribution

- Dataset ID/version: \`${DATASET_ID}@${DATASET_VERSION}\`
- Normalized files: \`${OUTPUT_FILES.json}\` and \`${OUTPUT_FILES.csv}\`
- Source: Aida, Honoka; Ying, Bei-Wen (2025), “Bacterial growth profiles across one-thousand chemical-defined media,” Figshare Dataset, https://doi.org/${SOURCE_METADATA.datasetDoi}
- Related article: Aida H, Ying B-W, “Population Dynamics of Escherichia coli Growing under Chemically Defined Media,” Scientific Data, https://doi.org/${SOURCE_METADATA.articleDoi}
- Data license: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- Attribution requirement: retain the source authors, dataset title, DOI, and license notice when redistributing or adapting these data.

### Admitted data

This bundle contains 12 complete untreated OD600 well trajectories from \`BW25113_Growth_Round01.xlsx\`, \`Sheet1\`: \`Curve00025\` through \`Curve00036\`. Each trajectory has the 44 observed times from 0.5 through 22.0 hours at 30-minute intervals, for 528 observations total. \`Curve00025\`–\`Curve00032\` are training units (352 observations); \`Curve00033\`–\`Curve00036\` are validation units (176 observations). A whole well/curve is assigned to only one role.

The composition and evaluation workbooks were joined by exact \`Label\` and checked for matching \`Assay ID\` and \`Condition ID\`. Every admitted curve is \`Cond00003\`, has source \`K_info = 0\` and \`r_info = 0\`, and has \`K2HPO4 = 61.5 mM\`.

### Experimental conditions

- Organism/strain: *Escherichia coli* BW25113
- Medium: chemically defined \`Cond00003\`; full composition below
- Temperature: 37 °C
- Format/volume: 96-well plate, 200 µL
- Shaking: 567 rpm
- Inoculation: 1:1000
- Reader: Epoch2 plate reader
- Sampling: 30 minutes; the first available point is 0.5 h
- Treatment: untreated; \`drugId = none\`, \`concentrationMgPerL = 0\`
- Measurement: raw, unblanked OD600; no blank correction and no OD-to-CFU conversion were applied

### Full source composition

The source workbook spelling is retained exactly in \`sourceHeader\`, including the apparent \`ZuSO4\` typo; it is not silently changed to \`ZnSO4\`.

| Source header | Concentration (mM) |
|---|---:|
${compositionTable(composition)}

### Transformation history

1. Verify each original XLSX by exact byte count, MD5, and SHA-256.
2. Read XLSX ZIP/XML using the repository’s Node-built-in-only reader.
3. Select \`Sheet1\`, times 0.5–22.0 h, and labels \`Curve00025\`–\`Curve00036\`.
4. Join composition and evaluation rows by exact label and verify assay/condition identifiers and source quality flags.
5. Parse each numeric OD cell directly from its cached worksheet token; perform no subtraction, blank correction, smoothing, interpolation, unit conversion, or OD-to-CFU model.
6. Assign complete trajectories to training or validation and serialize deterministic JSON/CSV.

Normalized JSON SHA-256: \`${jsonHash}\`  
Normalized CSV SHA-256: \`${csvHash}\`

### Intended and prohibited interpretations

Allowed uses include testing OD600 import/admission code, developing an explicit OD observation model, and analyzing untreated BW25113 growth under this exact medium with attribution. Do not use this bundle as direct CFU/mL observations, as evidence of antibiotic effects, as matched M9-medium validation, or as independent validation of the current CFU-based model without an explicit OD-to-model observation layer.

### Known limitations

- OD600 is not CFU/mL.
- Source OD values are raw and unblanked; no blank wells were inferred or subtracted.
- A \`t = 0\` observation is absent; the first admitted point is 0.5 h.
- Independence among wells and plate identity are not fully documented in the admitted source tables.
- Changing K2HPO4 can affect buffering, pH, and osmolality, not only a single nutrient axis.
- These are untreated curves and provide no evidence about antibiotic effects.
- The strain matches the current BW25113 growth baseline, but the chemically defined medium differs from the current model’s M9 target, and OD600 is incompatible with direct CFU observation without an explicit model.

## 中文

### 身份与署名

- 数据集 ID/版本：\`${DATASET_ID}@${DATASET_VERSION}\`
- 标准化文件：\`${OUTPUT_FILES.json}\` 与 \`${OUTPUT_FILES.csv}\`
- 来源：Aida, Honoka；Ying, Bei-Wen（2025），《Bacterial growth profiles across one-thousand chemical-defined media》，Figshare 数据集，https://doi.org/${SOURCE_METADATA.datasetDoi}
- 相关文章：Aida H, Ying B-W，《Population Dynamics of Escherichia coli Growing under Chemically Defined Media》，Scientific Data，https://doi.org/${SOURCE_METADATA.articleDoi}
- 数据许可：CC BY 4.0，https://creativecommons.org/licenses/by/4.0/
- 再分发或改编时必须保留作者、数据集标题、DOI 与许可声明。

### 纳入的数据

本数据包从 \`BW25113_Growth_Round01.xlsx\` 的 \`Sheet1\` 纳入 12 条完整的未处理 OD600 孔轨迹：\`Curve00025\` 至 \`Curve00036\`。每条轨迹包含 0.5 至 22.0 小时、间隔 30 分钟的 44 个观测点，共 528 个观测。\`Curve00025\`–\`Curve00032\` 为训练单元（352 个观测），\`Curve00033\`–\`Curve00036\` 为验证单元（176 个观测）；同一孔/曲线不会跨集合拆分。

培养基组成表和评价表按精确的 \`Label\` 连接，并核对 \`Assay ID\` 与 \`Condition ID\`。全部曲线均为 \`Cond00003\`，源字段 \`K_info = 0\`、\`r_info = 0\`，且 \`K2HPO4 = 61.5 mM\`。

### 实验条件与处理

菌株为 *Escherichia coli* BW25113；化学成分明确的 \`Cond00003\` 培养基；37 °C；96 孔板；200 µL；567 rpm；1:1000 接种；Epoch2 酶标仪；每 30 分钟采样；未使用抗生素。标准化数据保持 \`drugId = none\`、浓度 0、\`measurementType = od600\`。原始 OD 未扣空白，未推断空白孔，也未进行任何 OD 到 CFU 的换算。

完整培养基组成见上表。源表中的拼写（包括疑似笔误 \`ZuSO4\`）被原样保留，没有静默改成 \`ZnSO4\`。

### 转换历史

1. 按字节数、MD5 和 SHA-256 精确校验三个原始 XLSX。
2. 仅使用 Node 内置模块解析 XLSX 的 ZIP/XML。
3. 精确选择工作表、时间范围和曲线标签。
4. 按标签连接并核验组成表、评价表和质量标志。
5. 直接解析工作表缓存的数值；不扣空白、不平滑、不插值、不换单位、不进行 OD→CFU 建模。
6. 按完整轨迹划分训练/验证，并确定性写出 JSON/CSV。

### 允许用途、禁止用途与局限

可用于验证 OD600 数据导入流程、开发明确的 OD 观测模型，以及在署名条件下分析该精确培养基中的未处理 BW25113 生长。不得把这些数值直接当作 CFU/mL，不得据此声称抗生素效应，不得视为匹配 M9 条件的数据，也不得在缺少明确 OD 观测模型时声称其独立验证当前基于 CFU 的模型。

局限包括：OD600 不等于 CFU；原始 OD 未扣空白；没有 \`t=0\`；孔间独立性和板身份记录不完整；K2HPO4 变化会同时影响缓冲、pH 与渗透压；数据不含抗生素处理。菌株与当前 BW25113 生长基线一致，但培养基不同，测量尺度也不兼容直接观测。
`;
}

function checksumsDocument({ jsonText, csvText, readmeText, evaluationSummary }) {
  const jsonHash = sha256(jsonText);
  const csvHash = sha256(csvText);
  return {
    schemaVersion: "1.0.0",
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    generatedDeterministically: true,
    source: {
      title: SOURCE_METADATA.title,
      authors: [...SOURCE_METADATA.authors],
      url: SOURCE_METADATA.figshareUrl,
      datasetDoi: SOURCE_METADATA.datasetDoi,
      articleDoi: SOURCE_METADATA.articleDoi,
      license: { ...SOURCE_METADATA.license },
      attribution: `Aida, Honoka; Ying, Bei-Wen (2025). ${SOURCE_METADATA.title}. figshare. Dataset. https://doi.org/${SOURCE_METADATA.datasetDoi}`,
      files: SOURCE_FILES.map((file) => ({
        path: `data/raw/${DATASET_ID}/${file.name}`,
        sourceUrl: file.url,
        bytes: file.bytes,
        md5: file.md5,
        sha256: file.sha256,
      })),
    },
    normalizedDataSha256: jsonHash,
    artifacts: [
      {
        path: `data/datasets/${DATASET_ID}/${OUTPUT_FILES.json}`,
        mediaType: "application/json",
        bytes: bytes(jsonText),
        sha256: jsonHash,
        observationCount: 528,
        trainingObservationCount: 352,
        validationObservationCount: 176,
        independentUnitCount: 12,
      },
      {
        path: `data/datasets/${DATASET_ID}/${OUTPUT_FILES.csv}`,
        mediaType: "text/csv",
        bytes: bytes(csvText),
        sha256: csvHash,
        headerRowCount: 1,
        dataRowCount: 528,
      },
      {
        path: `data/datasets/${DATASET_ID}/${OUTPUT_FILES.readme}`,
        mediaType: "text/markdown",
        bytes: bytes(readmeText),
        sha256: sha256(readmeText),
      },
    ],
    selection: {
      workbook: "BW25113_Growth_Round01.xlsx",
      sheet: "Sheet1",
      timeHours: { first: 0.5, last: 22, interval: 0.5, count: 44 },
      labels: [...SELECTED_LABELS],
      trainingLabels: [...TRAINING_LABELS],
      validationLabels: [...VALIDATION_LABELS],
      conditionId: "Cond00003",
      k2hpo4Mm: 61.5,
      evaluation: evaluationSummary,
    },
    transformationHistory: [
      "Verified exact source byte count, MD5, and SHA-256 before parsing.",
      "Parsed XLSX ZIP central directory, deflated XML, workbook relationships, shared strings, and worksheet cached values using Node built-ins only.",
      "Selected exact Sheet1 cells for 0.5 through 22.0 hours and Curve00025 through Curve00036.",
      "Joined composition and evaluation by exact Label; verified Assay ID and Condition ID agreement, Cond00003, K2HPO4=61.5 mM, K_info=0, and r_info=0.",
      "Parsed source numeric tokens as finite JavaScript numbers without arithmetic, rounding, blank correction, smoothing, interpolation, or OD-to-CFU conversion.",
      "Assigned complete independent units Curve00025..Curve00032 to training and Curve00033..Curve00036 to validation.",
    ],
    allowedUses: [
      "OD600 ingestion and data-admission testing with attribution.",
      "Untreated BW25113 growth analysis under the documented Cond00003 medium.",
      "Development or evaluation of an explicit OD600 observation model.",
    ],
    prohibitedUses: [
      "Treating OD600 values as CFU/mL or log10 CFU/mL without an explicit validated conversion model.",
      "Claiming direct independent validation of the current CFU-based model.",
      "Claiming matched M9-medium validation or any antibiotic effect.",
      "Inferring or applying blank correction not present in the source.",
    ],
    knownLimitations: [
      "OD600 is not CFU/mL.",
      "Raw OD600 values are unblanked.",
      "The t=0 observation is absent; data begin at 0.5 h.",
      "Well independence and plate identity are not fully documented in the admitted source tables.",
      "K2HPO4 changes may affect buffering, pH, and osmolality.",
      "The admitted trajectories are untreated and contain no antibiotic-effect evidence.",
      "The source spelling ZuSO4 is preserved and may be a typo.",
    ],
    conditionMatch: {
      strain: "match_to_current_BW25113_growth_baseline",
      medium: "mismatch_to_current_M9_target",
      measurement: "OD600_incompatible_with_direct_CFU_observation_without_explicit_model",
      validationClaim: "not_direct_independent_validation_of_current_CFU_model",
    },
  };
}

async function readVerifiedWorkbooks(rawDirectory) {
  const buffers = new Map();
  for (const specification of SOURCE_FILES) {
    const buffer = await readFile(path.join(rawDirectory, specification.name));
    verifySourceBuffer(buffer, specification);
    buffers.set(specification.id, buffer);
  }
  return buffers;
}

function extractWorkbookData(buffers) {
  const growthWorkbook = openXlsx(buffers.get("growth-round01"));
  const compositionWorkbook = openXlsx(buffers.get("medium-composition"));
  const evaluationWorkbook = openXlsx(buffers.get("growth-evaluation"));
  for (const [label, workbook] of [
    ["growth workbook", growthWorkbook],
    ["composition workbook", compositionWorkbook],
    ["evaluation workbook", evaluationWorkbook],
  ]) assertArrayEqual(workbook.sheetNames, ["Sheet1"], `${label} sheets`);

  const growthSheet = growthWorkbook.getSheet("Sheet1");
  assert(growthSheet.getValue("A1") === "Time (h)", `Growth A1 must be "Time (h)"; received ${JSON.stringify(growthSheet.getValue("A1"))}.`);
  for (let index = 0; index < SELECTED_LABELS.length; index += 1) {
    const reference = `${columnNumberToName(index + 26)}1`;
    assert(growthSheet.getValue(reference) === SELECTED_LABELS[index], `${reference} must contain ${SELECTED_LABELS[index]}.`);
  }

  const compositionRows = worksheetRecords(compositionWorkbook.getSheet("Sheet1"));
  const evaluationRows = worksheetRecords(evaluationWorkbook.getSheet("Sheet1"));
  assertArrayEqual(compositionRows.headers, COMPOSITION_WORKBOOK_HEADERS, "Composition headers");
  assertArrayEqual(evaluationRows.headers, EVALUATION_HEADERS, "Evaluation headers");
  const compositionByLabel = uniqueRecordMap(compositionRows.records, "Label", "Composition workbook");
  const evaluationByLabel = uniqueRecordMap(evaluationRows.records, "Label", "Evaluation workbook");

  let referenceComposition = null;
  const joined = new Map();
  for (let index = 0; index < SELECTED_LABELS.length; index += 1) {
    const label = SELECTED_LABELS[index];
    const expectedAssayId = `Round01_${String(index + 25).padStart(4, "0")}`;
    const compositionRecord = compositionByLabel.get(label)?.values;
    const evaluationRecord = evaluationByLabel.get(label)?.values;
    assert(compositionRecord, `Composition row is missing for ${label}.`);
    assert(evaluationRecord, `Evaluation row is missing for ${label}.`);
    assert(compositionRecord["Assay ID"] === expectedAssayId, `${label} composition Assay ID mismatch.`);
    assert(evaluationRecord["Assay ID"] === expectedAssayId, `${label} evaluation Assay ID mismatch.`);
    assert(compositionRecord["Assay ID"] === evaluationRecord["Assay ID"], `${label} Assay ID does not join exactly.`);
    assert(compositionRecord["Condition ID"] === evaluationRecord["Condition ID"], `${label} Condition ID does not join exactly.`);
    assert(compositionRecord["Condition ID"] === "Cond00003", `${label} is not Cond00003.`);
    assert(compositionRecord["K2HPO4\r\n(mM)"] === 61.5, `${label} K2HPO4 is not 61.5 mM.`);
    assert(evaluationRecord.K_info === 0 && evaluationRecord.r_info === 0, `${label} K_info/r_info must both equal 0.`);
    assert(Number.isFinite(evaluationRecord.K) && Number.isFinite(evaluationRecord.r), `${label} K/r must be finite.`);

    const comparableComposition = Object.fromEntries(COMPOSITION_HEADERS.map((header) => [header, compositionRecord[header]]));
    if (referenceComposition === null) referenceComposition = comparableComposition;
    else assertSameRecord(comparableComposition, referenceComposition, `${label} medium composition`);
    joined.set(label, { assayId: expectedAssayId, compositionRecord, evaluationRecord });
  }

  const composition = mediumCompositionFromRecord(referenceComposition);
  assert(composition.some((entry) => entry.sourceHeader === "ZuSO4/7H2O\r\n(mM)" && entry.concentrationMm === 0.0001), "Source typo ZuSO4 and its value were not preserved.");
  const conditions = buildConditions(composition);
  const observations = [];
  for (let labelIndex = 0; labelIndex < SELECTED_LABELS.length; labelIndex += 1) {
    const label = SELECTED_LABELS[labelIndex];
    const { assayId } = joined.get(label);
    const role = labelIndex < TRAINING_LABELS.length ? "training" : "validation";
    const unitId = `${label}|${assayId}`;
    for (let timeIndex = 0; timeIndex < SELECTED_TIMES.length; timeIndex += 1) {
      const row = timeIndex + 2;
      const timeCell = growthSheet.getCell(`A${row}`);
      const valueCell = growthSheet.getCell(`${columnNumberToName(labelIndex + 26)}${row}`);
      const timeHours = SELECTED_TIMES[timeIndex];
      assert(timeCell?.type === "n" && timeCell.formula === null && timeCell.value === timeHours, `Growth time at A${row} must be ${timeHours}.`);
      assert(valueCell?.type === "n" && valueCell.formula === null && Number.isFinite(valueCell.value), `${label} has no complete numeric OD600 value at ${timeHours} h.`);
      observations.push({
        observationId: `${unitId}|timeHours=${timeHours.toFixed(1)}`,
        seriesId: unitId,
        independentUnitId: unitId,
        role,
        timeHours,
        drugId: "none",
        concentrationMgPerL: 0,
        measurementType: "od600",
        value: valueCell.value,
        censoring: "none",
        censoringBounds: null,
        replicate: unitId,
        conditions,
      });
    }
  }

  assert(observations.length === 528, `Expected 528 observations; received ${observations.length}.`);
  assert(observations.filter((observation) => observation.role === "training").length === 352, "Training observation count must be 352.");
  assert(observations.filter((observation) => observation.role === "validation").length === 176, "Validation observation count must be 176.");

  return {
    composition,
    conditions,
    observations,
    evaluationSummary: SELECTED_LABELS.map((label) => {
      const { assayId, evaluationRecord } = joined.get(label);
      return {
        label,
        assayId,
        conditionId: "Cond00003",
        K: evaluationRecord.K,
        r: evaluationRecord.r,
        K_info: evaluationRecord.K_info,
        r_info: evaluationRecord.r_info,
      };
    }),
  };
}

export async function extractFigshareDataset(options = {}) {
  const rawDirectory = path.resolve(options.rawDirectory ?? path.join(projectRoot, "data/raw", DATASET_ID));
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(projectRoot, "data/datasets", DATASET_ID));
  const buffers = await readVerifiedWorkbooks(rawDirectory);
  const extracted = extractWorkbookData(buffers);
  const dataset = {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: {
      datasetId: DATASET_ID,
      title: "Untreated Escherichia coli BW25113 OD600 growth in Cond00003",
      description: "Twelve complete raw, unblanked OD600 well trajectories selected from Figshare Round01; no OD-to-CFU conversion was applied.",
      createdAt: SOURCE_METADATA.publishedDate,
      license: "CC-BY-4.0",
      sourceIds: [SOURCE_METADATA.id],
      conditions: extracted.conditions,
    },
    observations: extracted.observations,
  };
  const jsonText = `${JSON.stringify(dataset, null, 2)}\n`;
  const csvText = observationsToCsv(extracted.observations);
  const jsonHash = sha256(jsonText);
  const csvHash = sha256(csvText);
  const readmeText = dataCard({ composition: extracted.composition, jsonHash, csvHash });
  const checksums = checksumsDocument({
    jsonText,
    csvText,
    readmeText,
    evaluationSummary: extracted.evaluationSummary,
  });
  const checksumsText = `${JSON.stringify(checksums, null, 2)}\n`;

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, OUTPUT_FILES.json), jsonText),
    writeFile(path.join(outputDirectory, OUTPUT_FILES.csv), csvText),
    writeFile(path.join(outputDirectory, OUTPUT_FILES.readme), readmeText),
    writeFile(path.join(outputDirectory, OUTPUT_FILES.checksums), checksumsText),
  ]);

  return {
    rawDirectory,
    outputDirectory,
    observationCount: extracted.observations.length,
    trainingObservationCount: 352,
    validationObservationCount: 176,
    independentUnitCount: 12,
    normalizedDataSha256: checksums.normalizedDataSha256,
    artifacts: Object.fromEntries(Object.entries(OUTPUT_FILES).map(([key, name]) => [key, path.join(outputDirectory, name)])),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--raw-dir" || argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
      if (argument === "--raw-dir") options.rawDirectory = value;
      else options.outputDirectory = value;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/extract-figshare-bw25113.js [--raw-dir PATH] [--output-dir PATH]");
    } else {
      const result = await extractFigshareDataset(options);
      console.log(`Extracted ${result.observationCount} observations (${result.trainingObservationCount} training, ${result.validationObservationCount} validation).`);
      console.log(`Independent units: ${result.independentUnitCount}.`);
      console.log(`Normalized JSON SHA-256: ${result.normalizedDataSha256}`);
      console.log(`Output directory: ${result.outputDirectory}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
