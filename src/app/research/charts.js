import { captureScrollPositions, restoreScrollPositions } from "../ui-state.js";
import { RESEARCH_EXPORT_DISCLOSURES } from "./export.js";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function extent(values, fallback = [0, 1]) {
  const numbers = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (numbers.length === 0) return fallback;
  let minimum = Math.min(...numbers);
  let maximum = Math.max(...numbers);
  if (minimum === maximum) {
    const padding = Math.max(0.05, Math.abs(minimum) * 0.05);
    minimum -= padding;
    maximum += padding;
  }
  return [minimum, maximum];
}

function scale(value, domain, range) {
  return range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0]);
}

function ticks(domain, count = 5) {
  return Array.from({ length: count }, (_, index) => domain[0] + (index / (count - 1)) * (domain[1] - domain[0]));
}

function number(value, digits = 3) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 10_000) return value.toExponential(2).replace("e+", "e");
  return value.toFixed(digits).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "");
}

function labels(locale) {
  const zh = locale === "zh-CN";
  return {
    overlay: zh ? "锁定留出单元：观测值与模型" : "Locked held-out unit: observed vs model",
    overlayDesc: zh ? "所选锁定留出单元的原始 OD600 观测与锁定模型预测。" : "Raw OD600 observations and locked-model predictions for the selected locked held-out unit.",
    residuals: zh ? "验证残差" : "Validation residuals",
    residualDesc: zh ? "残差定义为观测值减预测值；零线表示无偏差。" : "Residuals are observed minus predicted; the zero line marks no error.",
    scan: zh ? "二维参数扫描" : "Two-dimensional parameter scan",
    scanDesc: zh ? "生长率与汇总初始潜在状态网格上的 10 小时预测 OD600。" : "Predicted OD600 at 10 hours over the growth-rate and pooled initial-state grid.",
    uncertainty: zh ? "10 小时不确定性区间" : "Uncertainty interval at 10 h",
    uncertaintyDesc: zh ? "探索性三角参数范围产生的 2.5%、50% 与 97.5% 分位数；不是置信区间。" : "2.5%, 50%, and 97.5% quantiles from exploratory triangular parameter ranges; not a confidence interval.",
    sensitivity: zh ? "10 小时敏感性" : "Sensitivity at 10 h",
    sensitivityDesc: zh ? "局部导数、Morris μ* 与 Sobol 一阶/总阶指标。" : "Local derivative, Morris μ*, and Sobol first-/total-order indices.",
    time: zh ? "时间 (h)" : "Time (h)",
    od: "OD600",
    residual: zh ? "残差" : "Residual",
    observed: zh ? "观测" : "Observed",
    predicted: zh ? "模型" : "Model",
    scanLegend: zh ? "10 小时预测 OD600 数值图例" : "Predicted OD600 at 10 h value legend",
    scanTable: zh ? "二维参数扫描等价数据表" : "Equivalent two-dimensional parameter-scan data table",
    scanPsi: "psiMax (log10/h)",
    scanInitial: zh ? "汇总初始 log10 CFU/mL" : "Pooled initial log10 CFU/mL",
    scanValue: zh ? "10 小时预测 OD600" : "Predicted OD600 at 10 h",
    noData: zh ? "没有可绘制的数据" : "No plottable data",
  };
}

function axes({ width, height, margin, xDomain, yDomain, xLabel, yLabel }) {
  const x0 = margin.left;
  const x1 = width - margin.right;
  const y0 = height - margin.bottom;
  const y1 = margin.top;
  const xTicks = ticks(xDomain);
  const yTicks = ticks(yDomain);
  return `
    <g class="research-chart-grid">
      ${yTicks.map((value) => `<line x1="${x0}" y1="${scale(value, yDomain, [y0, y1])}" x2="${x1}" y2="${scale(value, yDomain, [y0, y1])}"/>`).join("")}
    </g>
    <g class="research-chart-axis">
      <line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}"/><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}"/>
      ${xTicks.map((value) => `<g transform="translate(${scale(value, xDomain, [x0, x1])} ${y0})"><line y2="5"/><text y="18" text-anchor="middle">${escapeXml(number(value, 2))}</text></g>`).join("")}
      ${yTicks.map((value) => `<g transform="translate(${x0} ${scale(value, yDomain, [y0, y1])})"><line x2="-5"/><text x="-8" y="4" text-anchor="end">${escapeXml(number(value, 3))}</text></g>`).join("")}
      <text x="${(x0 + x1) / 2}" y="${height - 8}" text-anchor="middle">${escapeXml(xLabel)}</text>
      <text transform="translate(15 ${(y0 + y1) / 2}) rotate(-90)" text-anchor="middle">${escapeXml(yLabel)}</text>
    </g>`;
}

function safeId(value) {
  const normalized = String(value ?? "research-chart")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "research-chart";
}

function svg(id, title, description, body, width = 680, height = 340) {
  const chartId = safeId(id);
  return `<svg class="research-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${chartId}-title ${chartId}-desc"><title id="${chartId}-title">${escapeXml(title)}</title><desc id="${chartId}-desc">${escapeXml(description)}</desc>${body}</svg>`;
}

function figure(id, heading, description, svgMarkup, caption, supplement = "") {
  return `<figure class="research-chart-card" aria-labelledby="${id}-heading" data-scroll-key="research-chart-${escapeXml(id)}"><h3 id="${id}-heading">${escapeXml(heading)}</h3>${svgMarkup}<figcaption>${escapeXml(caption)}</figcaption>${supplement}</figure>`;
}

export function alignedValidationRows(dataset, result) {
  const observations = dataset?.observations?.filter((observation) => observation.role === "validation") ?? [];
  const predictions = result?.validation?.predictions ?? [];
  const residuals = result?.validation?.residuals ?? [];
  return observations.map((observation, index) => ({
    observation,
    prediction: typeof predictions[index] === "number" ? predictions[index] : predictions[index]?.predicted ?? predictions[index]?.value,
    residual: residuals[index]?.residual,
  }));
}

function overlayFigure(dataset, result, unitId, locale) {
  const text = labels(locale);
  const rows = alignedValidationRows(dataset, result).filter(({ observation }) => observation.independentUnitId === unitId);
  const width = 680;
  const height = 340;
  const margin = { left: 58, right: 22, top: 24, bottom: 48 };
  if (rows.length === 0) return figure("research-overlay", text.overlay, text.overlayDesc, svg("research-overlay-empty", text.overlay, text.overlayDesc, `<text x="340" y="170" text-anchor="middle">${escapeXml(text.noData)}</text>`, width, height), text.overlayDesc);
  const xDomain = extent(rows.map(({ observation }) => observation.timeHours));
  const yDomain = extent(rows.flatMap(({ observation, prediction }) => [observation.value, prediction]));
  const xRange = [margin.left, width - margin.right];
  const yRange = [height - margin.bottom, margin.top];
  const modelPath = rows.map(({ observation, prediction }, index) => `${index === 0 ? "M" : "L"}${scale(observation.timeHours, xDomain, xRange)} ${scale(prediction, yDomain, yRange)}`).join(" ");
  const body = `${axes({ width, height, margin, xDomain, yDomain, xLabel: text.time, yLabel: text.od })}
    <path class="research-model-line" d="${modelPath}"/>
    ${rows.map(({ observation }) => `<circle class="research-observed-point" cx="${scale(observation.timeHours, xDomain, xRange)}" cy="${scale(observation.value, yDomain, yRange)}" r="3.5"><title>${escapeXml(`${text.observed}: ${number(observation.value)} · ${number(observation.timeHours, 2)} h`)}</title></circle>`).join("")}
    <g class="research-chart-legend"><circle cx="505" cy="18" r="3.5"/><text x="514" y="22">${text.observed}</text><line x1="580" y1="18" x2="603" y2="18"/><text x="609" y="22">${text.predicted}</text></g>`;
  return figure("research-overlay", `${text.overlay} · ${unitId}`, text.overlayDesc, svg(`overlay-${unitId}`, `${text.overlay} · ${unitId}`, text.overlayDesc, body, width, height), text.overlayDesc);
}

function residualFigure(dataset, result, unitId, locale) {
  const text = labels(locale);
  const rows = alignedValidationRows(dataset, result).filter(({ observation, residual }) => observation.independentUnitId === unitId && Number.isFinite(residual));
  const width = 680;
  const height = 300;
  const margin = { left: 58, right: 22, top: 22, bottom: 46 };
  if (rows.length === 0) return figure("research-residuals", text.residuals, text.residualDesc, svg("research-residuals-empty", text.residuals, text.residualDesc, `<text x="340" y="150" text-anchor="middle">${escapeXml(text.noData)}</text>`, width, height), text.residualDesc);
  const xDomain = extent(rows.map(({ observation }) => observation.timeHours));
  const yExtent = extent(rows.map(({ residual }) => residual), [-0.1, 0.1]);
  const maxAbs = Math.max(Math.abs(yExtent[0]), Math.abs(yExtent[1]), 0.01);
  const yDomain = [-maxAbs, maxAbs];
  const xRange = [margin.left, width - margin.right];
  const yRange = [height - margin.bottom, margin.top];
  const body = `${axes({ width, height, margin, xDomain, yDomain, xLabel: text.time, yLabel: text.residual })}
    <line class="research-zero-line" x1="${margin.left}" y1="${scale(0, yDomain, yRange)}" x2="${width - margin.right}" y2="${scale(0, yDomain, yRange)}"/>
    ${rows.map(({ observation, residual }) => `<circle class="research-residual-point" cx="${scale(observation.timeHours, xDomain, xRange)}" cy="${scale(residual, yDomain, yRange)}" r="3.3"><title>${escapeXml(`${number(observation.timeHours, 2)} h: ${number(residual)}`)}</title></circle>`).join("")}`;
  return figure("research-residuals", `${text.residuals} · ${unitId}`, text.residualDesc, svg(`residual-${unitId}`, `${text.residuals} · ${unitId}`, text.residualDesc, body, width, height), text.residualDesc);
}

function heatColor(value, domain) {
  const normalized = Math.max(0, Math.min(1, (value - domain[0]) / (domain[1] - domain[0])));
  const hue = 190 - normalized * 160;
  return `hsl(${hue} 65% ${42 + normalized * 10}%)`;
}

function scanFigure(result, locale) {
  const text = labels(locale);
  const successful = (result?.analyses?.parameterScan?.results ?? []).filter((entry) => entry.status === "ok" && Number.isFinite(entry.value));
  const xName = "psiMaxLog10PerHour";
  const yName = "initialStates.pooled.log10PopulationDensity";
  const xs = [...new Set(successful.map((entry) => entry.parameters?.[xName]))].sort((a, b) => a - b);
  const ys = [...new Set(successful.map((entry) => entry.parameters?.[yName]))].sort((a, b) => a - b);
  const width = 680;
  const height = 360;
  const left = 76;
  const top = 24;
  const plotWidth = 560;
  const plotHeight = 230;
  if (successful.length === 0 || xs.length === 0 || ys.length === 0) {
    return figure("research-scan", text.scan, text.scanDesc, svg("parameter-scan-empty", text.scan, text.scanDesc, `<text x="340" y="180" text-anchor="middle">${escapeXml(text.noData)}</text>`, width, height), text.scanDesc);
  }
  const cellWidth = plotWidth / xs.length;
  const cellHeight = plotHeight / ys.length;
  const valueDomain = extent(successful.map((entry) => entry.value));
  const cells = successful.map((entry) => {
    const x = xs.indexOf(entry.parameters[xName]);
    const y = ys.indexOf(entry.parameters[yName]);
    const cellX = left + x * cellWidth;
    const cellY = top + (ys.length - y - 1) * cellHeight;
    const valueLabel = number(entry.value);
    return `<g><rect x="${cellX}" y="${cellY}" width="${cellWidth + 0.4}" height="${cellHeight + 0.4}" fill="${heatColor(entry.value, valueDomain)}"><title>${escapeXml(`psiMax=${number(entry.parameters[xName])}; initial=${number(entry.parameters[yName])}; OD10h=${valueLabel}`)}</title></rect><text class="research-heat-value" x="${cellX + cellWidth / 2}" y="${cellY + cellHeight / 2 + 4}" text-anchor="middle">${escapeXml(valueLabel)}</text></g>`;
  }).join("");
  const legendValues = Array.from({ length: 5 }, (_, index) => valueDomain[0] + (index / 4) * (valueDomain[1] - valueDomain[0]));
  const legendX = 225;
  const legendY = 300;
  const legendWidth = 46;
  const body = `${cells}
    <g class="research-chart-axis"><line x1="${left}" y1="${top + plotHeight}" x2="${left + plotWidth}" y2="${top + plotHeight}"/><line x1="${left}" y1="${top}" x2="${left}" y2="${top + plotHeight}"/>
    ${xs.map((value, index) => `<text x="${left + (index + 0.5) * cellWidth}" y="${top + plotHeight + 18}" text-anchor="middle">${number(value, 3)}</text>`).join("")}
    ${ys.map((value, index) => `<text x="${left - 8}" y="${top + (ys.length - index - 0.5) * cellHeight + 4}" text-anchor="end">${number(value, 2)}</text>`).join("")}
    <text x="${left + plotWidth / 2}" y="${top + plotHeight + 40}" text-anchor="middle">${escapeXml(text.scanPsi)}</text>
    <text transform="translate(16 ${top + plotHeight / 2}) rotate(-90)" text-anchor="middle">${escapeXml(text.scanInitial)}</text></g>
    <g class="research-heat-legend" role="group" aria-label="${escapeXml(text.scanLegend)}"><text x="${legendX - 12}" y="${legendY - 8}">${escapeXml(text.scanLegend)}</text>${legendValues.map((value, index) => `<rect x="${legendX + index * legendWidth}" y="${legendY}" width="${legendWidth}" height="14" fill="${heatColor(value, valueDomain)}"/><text x="${legendX + index * legendWidth + legendWidth / 2}" y="${legendY + 29}" text-anchor="middle">${escapeXml(number(value))}</text>`).join("")}</g>`;
  const table = `<div class="research-chart-data-table research-table-scroll" data-scroll-key="research-scan-table"><table class="research-table"><caption>${escapeXml(text.scanTable)}</caption><thead><tr><th scope="col">${escapeXml(text.scanPsi)}</th><th scope="col">${escapeXml(text.scanInitial)}</th><th scope="col">${escapeXml(text.scanValue)}</th></tr></thead><tbody>${successful.map((entry) => `<tr><th scope="row">${escapeXml(number(entry.parameters[xName], 3))}</th><td>${escapeXml(number(entry.parameters[yName], 3))}</td><td>${escapeXml(number(entry.value))}</td></tr>`).join("")}</tbody></table></div>`;
  return figure("research-scan", text.scan, text.scanDesc, svg("parameter-scan", text.scan, text.scanDesc, body, width, height), text.scanDesc, table);
}

function uncertaintyFigure(result, locale) {
  const text = labels(locale);
  const outputName = result?.analyses?.scalarOutput?.name;
  const quantiles = result?.analyses?.monteCarlo?.summaries?.[outputName]?.quantiles ?? {};
  const low = finite(quantiles["0.025"] ?? quantiles[0.025], NaN);
  const median = finite(quantiles["0.5"] ?? quantiles[0.5], NaN);
  const high = finite(quantiles["0.975"] ?? quantiles[0.975], NaN);
  if (![low, median, high].every(Number.isFinite)) {
    return figure("research-uncertainty", text.uncertainty, text.uncertaintyDesc, svg("uncertainty-10h-empty", text.uncertainty, text.uncertaintyDesc, `<text x="340" y="125" text-anchor="middle">${escapeXml(text.noData)}</text>`, 680, 250), text.uncertaintyDesc);
  }
  const domain = extent([low, median, high], [0, 1]);
  const padded = [Math.max(0, domain[0] - (domain[1] - domain[0]) * 0.12), domain[1] + (domain[1] - domain[0]) * 0.12];
  const x0 = 75;
  const x1 = 625;
  const x = (value) => scale(value, padded, [x0, x1]);
  const body = `${ticks(padded).map((value) => `<line class="research-chart-grid" x1="${x(value)}" y1="55" x2="${x(value)}" y2="188"/><text class="research-chart-axis" x="${x(value)}" y="210" text-anchor="middle">${number(value, 3)}</text>`).join("")}
    <line class="research-interval-line" x1="${x(low)}" y1="120" x2="${x(high)}" y2="120"/><line class="research-interval-cap" x1="${x(low)}" y1="102" x2="${x(low)}" y2="138"/><line class="research-interval-cap" x1="${x(high)}" y1="102" x2="${x(high)}" y2="138"/><circle class="research-interval-median" cx="${x(median)}" cy="120" r="8"/>
    <text x="${x(low)}" y="92" text-anchor="middle">2.5% ${number(low)}</text><text x="${x(median)}" y="158" text-anchor="middle">50% ${number(median)}</text><text x="${x(high)}" y="92" text-anchor="middle">97.5% ${number(high)}</text><text x="350" y="236" text-anchor="middle">OD600 at 10 h</text>`;
  return figure("research-uncertainty", text.uncertainty, text.uncertaintyDesc, svg("uncertainty-10h", text.uncertainty, text.uncertaintyDesc, body, 680, 250), text.uncertaintyDesc);
}

function sensitivityRows(result) {
  const local = result?.analyses?.sensitivity?.local?.byParameter ?? {};
  const morris = result?.analyses?.sensitivity?.morris?.byParameter ?? {};
  const sobol = result?.analyses?.sensitivity?.sobolJansen?.byParameter ?? {};
  const names = [...new Set([...Object.keys(local), ...Object.keys(morris), ...Object.keys(sobol)])];
  return names.map((name) => ({
    name,
    local: Math.abs(finite(local[name]?.derivative, 0)),
    morris: Math.abs(finite(morris[name]?.muStar, 0)),
    first: Math.abs(finite(sobol[name]?.firstOrder, 0)),
    total: Math.abs(finite(sobol[name]?.totalOrder, 0)),
  }));
}

function sensitivityFigure(result, locale) {
  const text = labels(locale);
  const rows = sensitivityRows(result);
  const metrics = [
    ["local", "Local |dY/dx|", "research-bar-local"],
    ["morris", "Morris μ*", "research-bar-morris"],
    ["first", "Sobol S1", "research-bar-sobol-first"],
    ["total", "Sobol ST", "research-bar-sobol-total"],
  ];
  const width = 680;
  const left = 210;
  const right = 28;
  const top = 35;
  const groupHeight = 112;
  const height = Math.max(250, top + rows.length * groupHeight + 55);
  if (rows.length === 0) {
    return figure("research-sensitivity", text.sensitivity, text.sensitivityDesc, svg("sensitivity-10h-empty", text.sensitivity, text.sensitivityDesc, `<text x="340" y="125" text-anchor="middle">${escapeXml(text.noData)}</text>`, width, 250), text.sensitivityDesc);
  }
  const max = Math.max(0.001, ...rows.flatMap((row) => metrics.map(([key]) => row[key])));
  const body = `${ticks([0, max]).map((value) => `<line class="research-chart-grid" x1="${scale(value, [0, max], [left, width - right])}" y1="${top}" x2="${scale(value, [0, max], [left, width - right])}" y2="${height - 50}"/><text class="research-chart-axis" x="${scale(value, [0, max], [left, width - right])}" y="${height - 30}" text-anchor="middle">${number(value, 2)}</text>`).join("")}
    ${rows.map((row, rowIndex) => {
      const baseY = top + rowIndex * groupHeight;
      return `<text x="${left - 10}" y="${baseY + 42}" text-anchor="end">${escapeXml(row.name.replace("initialStates.pooled.", "pooled."))}</text>${metrics.map(([key, label, className], metricIndex) => { const y = baseY + metricIndex * 18; return `<rect class="${className}" x="${left}" y="${y}" width="${scale(row[key], [0, max], [0, width - left - right])}" height="12"><title>${escapeXml(`${label}: ${number(row[key])}`)}</title></rect><text x="${left + 5}" y="${y + 10}">${escapeXml(label)}</text>`; }).join("")}`;
    }).join("")}`;
  return figure("research-sensitivity", text.sensitivity, text.sensitivityDesc, svg("sensitivity-10h", text.sensitivity, text.sensitivityDesc, body, width, height), text.sensitivityDesc);
}

export function renderResearchCharts(container, { dataset, result, selectedValidationUnit, locale = "en" }) {
  if (!container) return;
  const scrollPositions = captureScrollPositions(container);
  container.innerHTML = [
    overlayFigure(dataset, result, selectedValidationUnit, locale),
    residualFigure(dataset, result, selectedValidationUnit, locale),
    scanFigure(result, locale),
    uncertaintyFigure(result, locale),
    sensitivityFigure(result, locale),
  ].join("");
  restoreScrollPositions(container, scrollPositions);
}

function stripFigure(markup) {
  const match = markup.match(/<svg[^>]*viewBox="[^"]+"[^>]*>([\s\S]*?)<\/svg>/);
  return match?.[1] ?? "";
}

export function serializeResearchDashboard({ dataset, result, selectedValidationUnit, locale = "en" }) {
  if (!dataset || !result) throw new Error("A completed Research result and dataset are required for SVG export.");
  const chartBodies = [
    overlayFigure(dataset, result, selectedValidationUnit, locale),
    residualFigure(dataset, result, selectedValidationUnit, locale),
    scanFigure(result, locale),
    uncertaintyFigure(result, locale),
    sensitivityFigure(result, locale),
  ].map(stripFigure);
  const capability = result.capability?.level ?? "—";
  const runId = result.reproducibility?.runId ?? "research-run";
  const zh = locale === "zh-CN";
  const disclosure = RESEARCH_EXPORT_DISCLOSURES[locale] ?? RESEARCH_EXPORT_DISCLOSURES.en;
  const exportText = {
    title: zh ? "Ecolab Stage 4 研究仪表板" : "Ecolab Stage 4 Research dashboard",
    description: zh
      ? `运行 ${runId}，能力 ${capability}；包含留出单元叠加图、残差、参数扫描、不确定性和敏感性。来源 DOI ${RESEARCH_EXPORT_DISCLOSURES.sourceDoi}，论文 DOI ${RESEARCH_EXPORT_DISCLOSURES.articleDoi}，许可 ${RESEARCH_EXPORT_DISCLOSURES.license}。`
      : `Dedicated dashboard for run ${runId}, capability ${capability}, including held-out overlay, residuals, parameter scan, uncertainty, and sensitivity. Source DOI ${RESEARCH_EXPORT_DISCLOSURES.sourceDoi}; article DOI ${RESEARCH_EXPORT_DISCLOSURES.articleDoi}; licensed ${RESEARCH_EXPORT_DISCLOSURES.license}.`,
    run: zh ? `运行 ${runId} · 能力 ${capability}` : `Run ${runId} · capability ${capability}`,
    source: zh ? `来源 DOI ${RESEARCH_EXPORT_DISCLOSURES.sourceDoi}` : `Source DOI ${RESEARCH_EXPORT_DISCLOSURES.sourceDoi}`,
    article: zh ? `论文 DOI ${RESEARCH_EXPORT_DISCLOSURES.articleDoi}` : `Article DOI ${RESEARCH_EXPORT_DISCLOSURES.articleDoi}`, 
  };
  const panels = [
    { x: 30, y: 120, w: 740, h: 390, body: chartBodies[0], scale: 1.05 },
    { x: 800, y: 120, w: 740, h: 350, body: chartBodies[1], scale: 1.05 },
    { x: 30, y: 540, w: 740, h: 410, body: chartBodies[2], scale: 1.05 },
    { x: 800, y: 500, w: 740, h: 320, body: chartBodies[3], scale: 1.05 },
    { x: 800, y: 850, w: 740, h: 390, body: chartBodies[4], scale: 1.05 },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1360" viewBox="0 0 1600 1360" role="img" aria-labelledby="dashboard-title dashboard-desc"><title id="dashboard-title">${escapeXml(exportText.title)}</title><desc id="dashboard-desc">${escapeXml(exportText.description)} ${escapeXml(disclosure.measurement)} ${escapeXml(disclosure.validation)} ${escapeXml(disclosure.uncertainty)} ${escapeXml(disclosure.exposure)} ${escapeXml(disclosure.calibration)}</desc><style>text{font-family:system-ui,sans-serif;fill:#14231f;font-size:12px}.research-chart-axis line{stroke:#64736d}.research-chart-grid line,.research-chart-grid{stroke:#d7dfda;stroke-width:1}.research-model-line{fill:none;stroke:#0b594e;stroke-width:2.5}.research-observed-point{fill:#d77a25}.research-residual-point{fill:#0b594e}.research-zero-line{stroke:#a43e36;stroke-dasharray:5 4}.research-interval-line,.research-interval-cap{stroke:#0b594e;stroke-width:5}.research-interval-median{fill:#d77a25}.research-bar-local{fill:#0b594e}.research-bar-morris{fill:#2a8f7e}.research-bar-sobol-first{fill:#d77a25}.research-bar-sobol-total{fill:#8d5a13}.research-heat-value{fill:#fff;font-weight:700;paint-order:stroke;stroke:#14231f;stroke-width:2px}.panel{fill:#fff;stroke:#d7dfda;stroke-width:1}</style><rect width="1600" height="1360" fill="#f2f5f0"/><text x="30" y="36" font-size="26" font-weight="700">${escapeXml(exportText.title)}</text><text x="30" y="62">${escapeXml(exportText.run)} · ${escapeXml(exportText.source)} · ${escapeXml(RESEARCH_EXPORT_DISCLOSURES.license)}</text><text x="30" y="82">${escapeXml(exportText.article)}</text><text x="30" y="102">${escapeXml(disclosure.measurement)}</text><text x="30" y="122">${escapeXml(disclosure.validation)}</text><text x="30" y="142">${escapeXml(disclosure.uncertainty)} ${escapeXml(disclosure.exposure)}</text><text x="30" y="162">${escapeXml(disclosure.calibration)}</text>${panels.map((panel) => `<g transform="translate(${panel.x} ${panel.y + 70})"><rect class="panel" width="${panel.w}" height="${panel.h}" rx="12"/><g transform="translate(10 10) scale(${panel.scale})">${panel.body}</g></g>`).join("")}</svg>\n`;
}
