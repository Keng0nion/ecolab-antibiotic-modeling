import test from "node:test";
import assert from "node:assert/strict";
import {
  alignedValidationRows,
  renderResearchCharts,
  serializeResearchDashboard,
} from "../research/charts.js";
import {
  createNormalizedDataset,
  createResearchResult,
} from "./research-test-fixtures.js";

test("validation observations, predictions, and residuals align for charting", () => {
  const rows = alignedValidationRows(createNormalizedDataset(), createResearchResult());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ prediction, residual }) => [prediction, residual]), [
    [0.085, 0.005],
    [0.115, 0.005],
  ]);
});

test("dedicated Research chart renderer emits five accessible figures with stable IDs", () => {
  const container = { innerHTML: "" };
  renderResearchCharts(container, {
    dataset: createNormalizedDataset(),
    result: createResearchResult(),
    selectedValidationUnit: "validation-unit",
    locale: "en",
  });
  assert.equal((container.innerHTML.match(/<figure/g) ?? []).length, 5);
  assert.equal((container.innerHTML.match(/<title id=/g) ?? []).length, 5);
  assert.equal((container.innerHTML.match(/<desc id=/g) ?? []).length, 5);
  assert.match(container.innerHTML, /overlay-validation-unit-title/);
  assert.match(container.innerHTML, /Two-dimensional parameter scan/);
  assert.match(container.innerHTML, /Predicted OD600 at 10 h value legend/);
  assert.match(container.innerHTML, /Equivalent two-dimensional parameter-scan data table/);
  assert.match(container.innerHTML, /<caption>Equivalent two-dimensional parameter-scan data table<\/caption>/);
  assert.match(container.innerHTML, /<th scope="col">psiMax \(log10\/h\)<\/th>/);
  assert.match(container.innerHTML, /class="research-heat-value"[^>]*>0\.2<\/text>/);
  assert.match(container.innerHTML, /Uncertainty interval at 10 h/);
  assert.match(container.innerHTML, /Sensitivity at 10 h/);
});

test("missing uncertainty and sensitivity values render no-data text rather than NaN coordinates", () => {
  const base = createResearchResult();
  const result = {
    ...base,
    analyses: {
      ...base.analyses,
      monteCarlo: { warnings: [], summaries: {} },
      sensitivity: { local: { byParameter: {} }, morris: { byParameter: {} }, sobolJansen: { byParameter: {} } },
    },
  };
  const container = { innerHTML: "" };
  renderResearchCharts(container, {
    dataset: createNormalizedDataset(),
    result,
    selectedValidationUnit: "validation-unit",
    locale: "en",
  });
  assert.doesNotMatch(container.innerHTML, /NaN/);
  assert.match(container.innerHTML, /No plottable data/);
});

test("Research dashboard SVG is standalone and describes all five chart concepts", () => {
  const svg = serializeResearchDashboard({
    dataset: createNormalizedDataset(),
    result: createResearchResult(),
    selectedValidationUnit: "validation-unit",
    locale: "en",
  });
  assert.match(svg, /^<\?xml version="1.0"/);
  assert.match(svg, /<title id="dashboard-title">/);
  assert.match(svg, /<desc id="dashboard-desc">/);
  assert.match(svg, /held-out overlay, residuals, parameter scan, uncertainty, and sensitivity/);
  assert.match(svg, /capability L3/);
  assert.match(svg, /10\.6084\/m9\.figshare\.28342064\.v1/);
  assert.match(svg, /10\.1038\/s41597-025-05356-3/);
  assert.match(svg, /CC BY 4\.0/);
  assert.match(svg, /Raw OD600 is not CFU\/mL/);
  assert.match(svg, /locked held-out units/);
  assert.match(svg, /not confidence intervals/);
  assert.match(svg, /no antibiotic exposure/);
  assert.match(svg, /transferred across unmatched measurement and medium conditions/);
  assert.doesNotMatch(svg, /independent validation unit/i);
  assert.doesNotMatch(svg, /NaN/);

  const chineseSvg = serializeResearchDashboard({
    dataset: createNormalizedDataset(),
    result: createResearchResult(),
    selectedValidationUnit: "validation-unit",
    locale: "zh-CN",
  });
  assert.match(chineseSvg, /研究仪表板/);
  assert.match(chineseSvg, /锁定留出单元/);
  assert.match(chineseSvg, /原始 OD600 不是 CFU\/mL/);
  assert.match(chineseSvg, /不是置信区间/);
  assert.match(chineseSvg, /没有药物暴露/);
  assert.match(chineseSvg, /跨越不匹配的测量层和培养基条件迁移/);
});
