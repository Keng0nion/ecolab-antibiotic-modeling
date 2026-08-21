const SVG_NS = "http://www.w3.org/2000/svg";
const DASHBOARD_WIDTH = 840;
const DASHBOARD_HEIGHT = 714;
const PLOT_LEFT = 96;
const PLOT_RIGHT = 814;
const PLOT_HEIGHT = 142;
const PLOT_TOPS = Object.freeze([66, 278, 490]);
const AXIS_COLOR = "#475569";
const GRID_COLOR = "#e2e8f0";
const TEXT_COLOR = "#0f172a";
const MUTED_COLOR = "#64748b";
const POPULATION_COLOR = "#2563eb";
const GROWTH_COLOR = "#7c3aed";
const REFERENCE_COLOR = "#92400e";
const SELECTION_COLOR = "#111827";
const DEFAULT_DRUG_COLOR = "#c2410c";
const renderedDashboards = new WeakMap();
let dashboardSequence = 0;

const COPY = Object.freeze({
  "zh-CN": Object.freeze({
    dashboardTitle: "种群、药物浓度与净增长率",
    dashboardDescription: "三张共享时间轴的纵向图，依次显示细菌种群、药物浓度阶梯和净增长率。",
    population: "种群",
    populationLogAxis: "种群密度 [log₁₀(CFU/mL)]",
    populationLinearAxis: "种群密度 [CFU/mL]",
    concentration: "药物浓度",
    growth: "净增长率",
    growthAxis: "净增长率 [log₁₀ 倍/小时]",
    timeAxis: "时间 [小时]",
    detectionLimit: "检测限",
    zMic: "zMIC",
    zero: "零线",
    selected: "选中",
    sample: "样本",
    detectable: "可检测范围内",
    belowDetection: "低于检测限",
    noDetectionLimit: "未提供检测限",
    keyboard: "可用左右方向键选择相邻样本，Home 和 End 选择首末样本。",
    empty: "没有可绘制的轨迹样本。",
    summaryPrefix: "图表摘要",
    metadata: "导出元数据",
    metadataEmbedded: "完整元数据以 JSON 文本嵌入 SVG metadata 元素。",
    noMetadata: "未提供元数据。",
    warnings: "警告",
    noWarnings: "无警告。",
  }),
  en: Object.freeze({
    dashboardTitle: "Population, drug concentration, and net growth",
    dashboardDescription: "Three vertically stacked charts share a time axis and show bacterial population, stepwise drug concentration, and net growth rate.",
    population: "Population",
    populationLogAxis: "Population density [log₁₀(CFU/mL)]",
    populationLinearAxis: "Population density [CFU/mL]",
    concentration: "Drug concentration",
    growth: "Net growth rate",
    growthAxis: "Net growth rate [log₁₀ fold/hour]",
    timeAxis: "Time [hours]",
    detectionLimit: "Detection limit",
    zMic: "zMIC",
    zero: "Zero line",
    selected: "Selected",
    sample: "sample",
    detectable: "within detectable range",
    belowDetection: "below detection limit",
    noDetectionLimit: "no detection limit supplied",
    keyboard: "Use Left and Right Arrow to select adjacent samples; Home and End select the first and last samples.",
    empty: "There are no trajectory samples to plot.",
    summaryPrefix: "Chart summary",
    metadata: "Export metadata",
    metadataEmbedded: "Complete metadata is embedded as JSON text in the SVG metadata element.",
    noMetadata: "No metadata was supplied.",
    warnings: "Warnings",
    noWarnings: "No warnings.",
  }),
});

function copyFor(locale) {
  return String(locale).toLowerCase().startsWith("zh") ? COPY["zh-CN"] : COPY.en;
}

function localeForIntl(locale) {
  try {
    new Intl.NumberFormat(locale).format(1);
    return locale;
  } catch {
    return "en";
  }
}

function assertContainer(container) {
  if (!container || typeof container.appendChild !== "function" || !container.ownerDocument) {
    throw new TypeError("container must be a DOM element with an ownerDocument.");
  }
}

function replaceChildren(parent, ...children) {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  for (const child of children) parent.appendChild(child);
}

function svgElement(document, name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  setAttributes(element, attributes);
  return element;
}

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== null && value !== undefined) element.setAttribute(name, String(value));
  }
  return element;
}

function appendText(parent, text, attributes = {}) {
  const node = svgElement(parent.ownerDocument, "text", {
    fill: TEXT_COLOR,
    "font-family": "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    "font-size": 12,
    ...attributes,
  });
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return value;
}

function enumValue(value, allowed, fallback, name) {
  const normalized = value ?? fallback;
  if (!allowed.includes(normalized)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(", ")}.`);
  }
  return normalized;
}

function safeColor(value, fallback = DEFAULT_DRUG_COLOR) {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  if (!color || color.length > 80) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,]+\)$/i.test(color)) return color;
  if (/^[a-z]{3,24}$/i.test(color) && !/^(?:none|inherit|transparent|currentcolor)$/i.test(color)) {
    return color;
  }
  return fallback;
}

function firstFinite(row, names) {
  for (const name of names) {
    if (typeof row[name] === "number" && Number.isFinite(row[name])) return row[name];
  }
  return null;
}

function normalizeTrajectory(trajectory) {
  if (!Array.isArray(trajectory)) throw new TypeError("options.trajectory must be an array.");
  let previousTime = -Infinity;
  return trajectory.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`options.trajectory[${index}] must be an object.`);
    }

    let timeHours = firstFinite(row, ["timeHours"]);
    if (timeHours === null) {
      const timeMinutes = firstFinite(row, ["timeMinutes"]);
      if (timeMinutes !== null) timeHours = timeMinutes / 60;
    }
    if (timeHours === null) {
      throw new TypeError(`options.trajectory[${index}].timeHours must be a finite number.`);
    }
    if (timeHours < previousTime) {
      throw new TypeError("options.trajectory must be ordered by nondecreasing time.");
    }
    previousTime = timeHours;

    let populationLog10 = firstFinite(row, [
      "latentLog10PopulationDensity",
      "log10PopulationDensity",
      "populationLog10",
    ]);
    if (populationLog10 === null) {
      const linearPopulation = firstFinite(row, ["populationCfuPerMl", "population"]);
      if (linearPopulation !== null && linearPopulation > 0) {
        populationLog10 = Math.log10(linearPopulation);
      }
    }
    if (populationLog10 === null) {
      throw new TypeError(
        `options.trajectory[${index}].latentLog10PopulationDensity must be a finite number.`,
      );
    }

    const concentrationMgPerL = firstFinite(row, ["concentrationMgPerL", "concentration"]);
    if (concentrationMgPerL === null || concentrationMgPerL < 0) {
      throw new TypeError(
        `options.trajectory[${index}].concentrationMgPerL must be a finite number >= 0.`,
      );
    }

    const netGrowthLog10PerHour = firstFinite(row, [
      "netGrowthLog10PerHour",
      "netGrowth",
      "growthRate",
    ]);
    if (netGrowthLog10PerHour === null) {
      throw new TypeError(
        `options.trajectory[${index}].netGrowthLog10PerHour must be a finite number.`,
      );
    }

    const detectionLimitLog10 = firstFinite(row, ["detectionLimitLog10"]);
    const belowDetectionLimit = typeof row.belowDetectionLimit === "boolean"
      ? row.belowDetectionLimit
      : detectionLimitLog10 !== null && populationLog10 < detectionLimitLog10;

    return {
      index,
      source: row,
      timeHours,
      populationLog10,
      concentrationMgPerL,
      netGrowthLog10PerHour,
      detectionLimitLog10,
      belowDetectionLimit,
    };
  });
}

function log10ToLinear(value) {
  if (value > 308) return Number.MAX_VALUE;
  if (value < -323) return 0;
  return 10 ** value;
}

function clampIndex(index, length) {
  if (length === 0) return -1;
  if (typeof index !== "number" || !Number.isFinite(index)) return length - 1;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object.");
  }
  const points = normalizeTrajectory(options.trajectory);
  const populationScale = enumValue(
    options.populationScale,
    ["log", "linear"],
    "log",
    "options.populationScale",
  );
  const concentrationScale = enumValue(
    options.concentrationScale,
    ["mg", "xzmic"],
    "mg",
    "options.concentrationScale",
  );
  const zMic = typeof options.zMic === "number" && Number.isFinite(options.zMic) && options.zMic > 0
    ? options.zMic
    : null;
  if (
    concentrationScale === "xzmic" &&
    zMic === null &&
    points.some((point) => point.concentrationMgPerL !== 0)
  ) {
    throw new TypeError(
      "options.zMic must be a finite number > 0 when concentrationScale is 'xzmic' and concentration is nonzero.",
    );
  }

  return {
    points,
    selectedIndex: clampIndex(options.selectedIndex, points.length),
    populationScale,
    concentrationScale,
    zMic,
    drugColor: safeColor(options.drugColor),
    locale: typeof options.locale === "string" && options.locale ? options.locale : "en",
    onSelect: typeof options.onSelect === "function" ? options.onSelect : null,
  };
}

function extent(values, fallback = [0, 1]) {
  const finite = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return [...fallback];
  return [Math.min(...finite), Math.max(...finite)];
}

function paddedDomain(minimum, maximum, { includeZero = false, positiveFromZero = false } = {}) {
  let min = minimum;
  let max = maximum;
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (positiveFromZero) min = 0;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (positiveFromZero) return [0, max > 0 ? max * 1.15 : 1];
    const pad = Math.max(Math.abs(min) * 0.1, 0.5);
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  return positiveFromZero ? [0, max + pad] : [min - pad, max + pad];
}

function createScale(domainMinimum, domainMaximum, rangeMinimum, rangeMaximum) {
  const span = domainMaximum - domainMinimum || 1;
  return (value) => rangeMinimum + ((value - domainMinimum) / span) * (rangeMaximum - rangeMinimum);
}

function tickValues(minimum, maximum, count = 5) {
  if (count <= 1 || minimum === maximum) return [minimum];
  return Array.from(
    { length: count },
    (_, index) => minimum + ((maximum - minimum) * index) / (count - 1),
  );
}

function coordinate(value) {
  const rounded = Math.abs(value) < 0.0005 ? 0 : Number(value.toFixed(3));
  return String(rounded);
}

function numberFormatter(locale, options) {
  try {
    return new Intl.NumberFormat(localeForIntl(locale), options);
  } catch {
    return new Intl.NumberFormat("en", options);
  }
}

function formatNumber(value, locale, { scientific = false, maximumFractionDigits = 3 } = {}) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (scientific || absolute >= 100_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2).replace("e+", "e");
  }
  return numberFormatter(locale, { maximumFractionDigits }).format(value);
}

function formatAxisNumber(value, locale, scientific = false) {
  return formatNumber(value, locale, {
    scientific: scientific || Math.abs(value) >= 100_000,
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  });
}

function linePath(points, xValue, yValue) {
  if (points.length === 0) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${coordinate(xValue(point))},${coordinate(yValue(point))}`)
    .join(" ");
}

function pathWithGaps(points, xValue, yValue) {
  let path = "";
  let active = false;
  for (const point of points) {
    const y = yValue(point);
    if (typeof y !== "number" || !Number.isFinite(y)) {
      active = false;
      continue;
    }
    path += `${active ? " L" : path ? " M" : "M"}${coordinate(xValue(point))},${coordinate(y)}`;
    active = true;
  }
  return path;
}

function stepPath(points, xValue, yValue) {
  if (points.length === 0) return "";
  let path = `M${coordinate(xValue(points[0]))},${coordinate(yValue(points[0]))}`;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    path += ` H${coordinate(xValue(point))} V${coordinate(yValue(point))}`;
  }
  return path;
}

function addLine(parent, attributes) {
  const line = svgElement(parent.ownerDocument, "line", attributes);
  parent.appendChild(line);
  return line;
}

function drawAxes(svg, specification, xDomain, yDomain, strings, locale, isLastPanel) {
  const { top, title, yAxisLabel, scientificY = false, key } = specification;
  const bottom = top + PLOT_HEIGHT;
  const xScale = createScale(xDomain[0], xDomain[1], PLOT_LEFT, PLOT_RIGHT);
  const yScale = createScale(yDomain[0], yDomain[1], bottom, top);
  const group = svgElement(svg.ownerDocument, "g", {
    "data-chart-panel": key,
    class: `chart-panel chart-${key}`,
  });
  svg.appendChild(group);

  group.appendChild(svgElement(svg.ownerDocument, "rect", {
    x: PLOT_LEFT,
    y: top,
    width: PLOT_RIGHT - PLOT_LEFT,
    height: PLOT_HEIGHT,
    fill: "#ffffff",
    stroke: AXIS_COLOR,
    "stroke-width": 1,
  }));

  const xTicks = tickValues(xDomain[0], xDomain[1]);
  for (const tick of xTicks) {
    const x = xScale(tick);
    addLine(group, {
      x1: x,
      y1: top,
      x2: x,
      y2: bottom,
      stroke: GRID_COLOR,
      "stroke-width": 1,
      "aria-hidden": "true",
    });
    appendText(group, formatAxisNumber(tick, locale), {
      x,
      y: bottom + 19,
      fill: MUTED_COLOR,
      "text-anchor": "middle",
      "data-axis-tick": "time",
    });
  }

  const yTicks = tickValues(yDomain[0], yDomain[1]);
  for (const tick of yTicks) {
    const y = yScale(tick);
    addLine(group, {
      x1: PLOT_LEFT,
      y1: y,
      x2: PLOT_RIGHT,
      y2: y,
      stroke: GRID_COLOR,
      "stroke-width": 1,
      "aria-hidden": "true",
    });
    appendText(group, formatAxisNumber(tick, locale, scientificY), {
      x: PLOT_LEFT - 10,
      y: y + 4,
      fill: MUTED_COLOR,
      "text-anchor": "end",
      "data-axis-tick": key,
    });
  }

  appendText(group, title, {
    x: PLOT_LEFT,
    y: top - 15,
    "font-size": 14,
    "font-weight": 700,
    "data-chart-title": key,
  });
  appendText(group, yAxisLabel, {
    x: 0,
    y: 0,
    transform: `translate(24 ${coordinate(top + PLOT_HEIGHT / 2)}) rotate(-90)`,
    "text-anchor": "middle",
    "font-weight": 600,
    "data-axis-label": "y",
    "data-chart": key,
  });
  if (isLastPanel) {
    appendText(group, strings.timeAxis, {
      x: (PLOT_LEFT + PLOT_RIGHT) / 2,
      y: bottom + 53,
      "text-anchor": "middle",
      "font-weight": 600,
      "data-axis-label": "x",
    });
  }

  return { group, xScale, yScale, top, bottom };
}

function appendCircleMarker(parent, x, y, attributes = {}) {
  const marker = svgElement(parent.ownerDocument, "circle", {
    cx: x,
    cy: y,
    r: 3.2,
    ...attributes,
  });
  parent.appendChild(marker);
  return marker;
}

function appendSquareMarker(parent, x, y, attributes = {}) {
  const size = attributes.size ?? 6.5;
  const { size: _size, ...rest } = attributes;
  const marker = svgElement(parent.ownerDocument, "rect", {
    x: x - size / 2,
    y: y - size / 2,
    width: size,
    height: size,
    ...rest,
  });
  parent.appendChild(marker);
  return marker;
}

function diamondPoints(x, y, radius) {
  return `${coordinate(x)},${coordinate(y - radius)} ${coordinate(x + radius)},${coordinate(y)} ${coordinate(x)},${coordinate(y + radius)} ${coordinate(x - radius)},${coordinate(y)}`;
}

function appendDiamondMarker(parent, x, y, attributes = {}) {
  const radius = attributes.radius ?? 4;
  const { radius: _radius, ...rest } = attributes;
  const marker = svgElement(parent.ownerDocument, "polygon", {
    points: diamondPoints(x, y, radius),
    ...rest,
  });
  parent.appendChild(marker);
  return marker;
}

function appendTriangleMarker(parent, x, y, attributes = {}) {
  const radius = attributes.radius ?? 4;
  const { radius: _radius, ...rest } = attributes;
  const marker = svgElement(parent.ownerDocument, "polygon", {
    points: `${coordinate(x)},${coordinate(y - radius)} ${coordinate(x + radius)},${coordinate(y + radius)} ${coordinate(x - radius)},${coordinate(y + radius)}`,
    ...rest,
  });
  parent.appendChild(marker);
  return marker;
}

function populationValue(point, scale) {
  return scale === "linear" ? log10ToLinear(point.populationLog10) : point.populationLog10;
}

function detectionValue(point, scale) {
  if (point.detectionLimitLog10 === null) return null;
  return scale === "linear" ? log10ToLinear(point.detectionLimitLog10) : point.detectionLimitLog10;
}

function concentrationValue(point, scale, zMic) {
  if (scale === "mg") return point.concentrationMgPerL;
  if (zMic === null) return 0;
  return point.concentrationMgPerL / zMic;
}

function concentrationUnit(scale) {
  return scale === "mg" ? "mg/L" : "×zMIC";
}

function selectedSummary(point, options, strings) {
  if (!point) return `${strings.summaryPrefix}: ${strings.empty}`;
  const population = populationValue(point, options.populationScale);
  const concentration = concentrationValue(point, options.concentrationScale, options.zMic);
  const populationText = options.populationScale === "log"
    ? `${formatNumber(population, options.locale)} log₁₀(CFU/mL)`
    : `${formatNumber(population, options.locale, { scientific: true })} CFU/mL`;
  const concentrationText = `${formatNumber(concentration, options.locale)} ${concentrationUnit(options.concentrationScale)}`;
  const growthText = `${formatNumber(point.netGrowthLog10PerHour, options.locale)} log₁₀ fold/hour`;
  const detectionStatus = point.detectionLimitLog10 === null
    ? strings.noDetectionLimit
    : point.belowDetectionLimit
      ? strings.belowDetection
      : strings.detectable;

  if (copyFor(options.locale) === COPY["zh-CN"]) {
    return `${strings.summaryPrefix}：共 ${options.points.length} 个样本；当前选择第 ${point.index + 1} 个样本，时间 ${formatNumber(point.timeHours, options.locale)} 小时，种群 ${populationText}，浓度 ${concentrationText}，净增长率 ${growthText}，${detectionStatus}。`;
  }
  return `${strings.summaryPrefix}: ${options.points.length} samples; selected sample ${point.index + 1} at ${formatNumber(point.timeHours, options.locale)} hours, population ${populationText}, concentration ${concentrationText}, net growth ${growthText}, ${detectionStatus}.`;
}

function selectedLabel(value, unit, options, strings, scientific = false) {
  return `${strings.selected}: ${formatNumber(value, options.locale, { scientific })} ${unit}`;
}

function createDashboardSvg(document, options, idPrefix) {
  const strings = copyFor(options.locale);
  const svg = svgElement(document, "svg", {
    xmlns: SVG_NS,
    version: "1.1",
    viewBox: `0 0 ${DASHBOARD_WIDTH} ${DASHBOARD_HEIGHT}`,
    width: DASHBOARD_WIDTH,
    height: DASHBOARD_HEIGHT,
    role: "img",
    tabindex: 0,
    focusable: "true",
    lang: options.locale,
    "aria-labelledby": `${idPrefix}-title ${idPrefix}-desc`,
    "aria-keyshortcuts": "ArrowLeft ArrowRight Home End",
    "data-linked-chart-dashboard": "true",
    "data-chart-count": 3,
    "data-selected-index": options.selectedIndex,
    class: "linked-chart-dashboard",
  });
  const title = svgElement(document, "title", { id: `${idPrefix}-title` });
  title.textContent = strings.dashboardTitle;
  svg.appendChild(title);
  const desc = svgElement(document, "desc", { id: `${idPrefix}-desc` });
  svg.appendChild(desc);
  svg.appendChild(svgElement(document, "rect", {
    x: 0,
    y: 0,
    width: DASHBOARD_WIDTH,
    height: DASHBOARD_HEIGHT,
    fill: "#ffffff",
    "data-dashboard-background": "true",
  }));
  appendText(svg, strings.dashboardTitle, {
    x: DASHBOARD_WIDTH / 2,
    y: 28,
    "text-anchor": "middle",
    "font-size": 18,
    "font-weight": 700,
  });

  const timeExtent = extent(options.points.map((point) => point.timeHours), [0, 1]);
  let xDomain = timeExtent;
  if (xDomain[0] === xDomain[1]) {
    xDomain = xDomain[0] === 0
      ? [0, 1]
      : [Math.max(0, xDomain[0] - 0.5), xDomain[1] + 0.5];
  }

  const populationValues = options.points.map((point) => populationValue(point, options.populationScale));
  const detectionValues = options.points.map((point) => detectionValue(point, options.populationScale));
  const populationExtent = extent([...populationValues, ...detectionValues], options.populationScale === "log" ? [0, 1] : [0, 1]);
  const populationDomain = paddedDomain(populationExtent[0], populationExtent[1], {
    positiveFromZero: options.populationScale === "linear",
  });

  const concentrationValues = options.points.map((point) => (
    concentrationValue(point, options.concentrationScale, options.zMic)
  ));
  const zMicReference = options.zMic === null
    ? null
    : options.concentrationScale === "mg"
      ? options.zMic
      : 1;
  const concentrationExtent = extent(
    zMicReference === null ? concentrationValues : [...concentrationValues, zMicReference],
    [0, 1],
  );
  const concentrationDomain = paddedDomain(concentrationExtent[0], concentrationExtent[1], {
    positiveFromZero: true,
  });

  const growthExtent = extent(options.points.map((point) => point.netGrowthLog10PerHour), [-1, 1]);
  const growthDomain = paddedDomain(growthExtent[0], growthExtent[1], { includeZero: true });

  const populationPanel = drawAxes(svg, {
    key: "population",
    top: PLOT_TOPS[0],
    title: strings.population,
    yAxisLabel: options.populationScale === "log"
      ? strings.populationLogAxis
      : strings.populationLinearAxis,
    scientificY: options.populationScale === "linear",
  }, xDomain, populationDomain, strings, options.locale, false);

  const concentrationPanel = drawAxes(svg, {
    key: "concentration",
    top: PLOT_TOPS[1],
    title: strings.concentration,
    yAxisLabel: `${strings.concentration} [${concentrationUnit(options.concentrationScale)}]`,
  }, xDomain, concentrationDomain, strings, options.locale, false);

  const growthPanel = drawAxes(svg, {
    key: "growth",
    top: PLOT_TOPS[2],
    title: strings.growth,
    yAxisLabel: strings.growthAxis,
  }, xDomain, growthDomain, strings, options.locale, true);

  const xScale = populationPanel.xScale;

  const detectionPath = pathWithGaps(
    options.points,
    (point) => xScale(point.timeHours),
    (point) => {
      const value = detectionValue(point, options.populationScale);
      return value === null ? null : populationPanel.yScale(value);
    },
  );
  if (detectionPath) {
    populationPanel.group.appendChild(svgElement(document, "path", {
      d: detectionPath,
      fill: "none",
      stroke: REFERENCE_COLOR,
      "stroke-width": 1.5,
      "stroke-dasharray": "3 4",
      "data-reference": "detection-limit",
    }));
    const lastDetection = [...options.points].reverse().find((point) => point.detectionLimitLog10 !== null);
    if (lastDetection) {
      const y = populationPanel.yScale(detectionValue(lastDetection, options.populationScale));
      appendText(populationPanel.group, strings.detectionLimit, {
        x: PLOT_RIGHT - 5,
        y: Math.max(populationPanel.top + 13, y - 6),
        fill: REFERENCE_COLOR,
        "text-anchor": "end",
        "font-size": 11,
      });
    }
  }

  const populationDataPath = linePath(
    options.points,
    (point) => xScale(point.timeHours),
    (point) => populationPanel.yScale(populationValue(point, options.populationScale)),
  );
  if (populationDataPath) {
    populationPanel.group.appendChild(svgElement(document, "path", {
      d: populationDataPath,
      fill: "none",
      stroke: POPULATION_COLOR,
      "stroke-width": 2.5,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "data-series": "population",
      "data-line-style": "solid-with-circle-or-triangle-markers",
    }));
  }
  for (const point of options.points) {
    const x = xScale(point.timeHours);
    const y = populationPanel.yScale(populationValue(point, options.populationScale));
    const markerAttributes = {
      fill: point.belowDetectionLimit ? "#ffffff" : POPULATION_COLOR,
      stroke: POPULATION_COLOR,
      "stroke-width": point.belowDetectionLimit ? 1.8 : 1,
      "data-sample-index": point.index,
      "data-series-marker": "population",
    };
    if (point.belowDetectionLimit) {
      appendTriangleMarker(populationPanel.group, x, y, markerAttributes);
    } else {
      appendCircleMarker(populationPanel.group, x, y, markerAttributes);
    }
  }

  const concentrationZeroY = concentrationPanel.yScale(0);
  addLine(concentrationPanel.group, {
    x1: PLOT_LEFT,
    y1: concentrationZeroY,
    x2: PLOT_RIGHT,
    y2: concentrationZeroY,
    stroke: AXIS_COLOR,
    "stroke-width": 1.4,
    "data-reference": "zero",
    "data-chart": "concentration",
  });
  if (zMicReference !== null) {
    const referenceY = concentrationPanel.yScale(zMicReference);
    addLine(concentrationPanel.group, {
      x1: PLOT_LEFT,
      y1: referenceY,
      x2: PLOT_RIGHT,
      y2: referenceY,
      stroke: REFERENCE_COLOR,
      "stroke-width": 1.5,
      "stroke-dasharray": "8 3 2 3",
      "data-reference": "zmic",
    });
    appendText(concentrationPanel.group, strings.zMic, {
      x: PLOT_RIGHT - 5,
      y: Math.max(concentrationPanel.top + 13, referenceY - 6),
      fill: REFERENCE_COLOR,
      "text-anchor": "end",
      "font-size": 11,
    });
  }

  const concentrationDataPath = stepPath(
    options.points,
    (point) => xScale(point.timeHours),
    (point) => concentrationPanel.yScale(
      concentrationValue(point, options.concentrationScale, options.zMic),
    ),
  );
  if (concentrationDataPath) {
    concentrationPanel.group.appendChild(svgElement(document, "path", {
      d: concentrationDataPath,
      fill: "none",
      stroke: options.drugColor,
      "stroke-width": 2.5,
      "stroke-dasharray": "10 4",
      "stroke-linejoin": "miter",
      "data-series": "concentration",
      "data-line-style": "step-dashed-with-square-markers",
    }));
  }
  for (const point of options.points) {
    appendSquareMarker(
      concentrationPanel.group,
      xScale(point.timeHours),
      concentrationPanel.yScale(concentrationValue(point, options.concentrationScale, options.zMic)),
      {
        fill: "#ffffff",
        stroke: options.drugColor,
        "stroke-width": 1.8,
        "data-sample-index": point.index,
        "data-series-marker": "concentration",
      },
    );
  }

  const growthZeroY = growthPanel.yScale(0);
  addLine(growthPanel.group, {
    x1: PLOT_LEFT,
    y1: growthZeroY,
    x2: PLOT_RIGHT,
    y2: growthZeroY,
    stroke: REFERENCE_COLOR,
    "stroke-width": 1.5,
    "stroke-dasharray": "7 4",
    "data-reference": "zero",
    "data-chart": "growth",
  });
  appendText(growthPanel.group, strings.zero, {
    x: PLOT_RIGHT - 5,
    y: Math.max(growthPanel.top + 13, growthZeroY - 6),
    fill: REFERENCE_COLOR,
    "text-anchor": "end",
    "font-size": 11,
  });

  const growthDataPath = linePath(
    options.points,
    (point) => xScale(point.timeHours),
    (point) => growthPanel.yScale(point.netGrowthLog10PerHour),
  );
  if (growthDataPath) {
    growthPanel.group.appendChild(svgElement(document, "path", {
      d: growthDataPath,
      fill: "none",
      stroke: GROWTH_COLOR,
      "stroke-width": 2.5,
      "stroke-dasharray": "2 4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "data-series": "growth",
      "data-line-style": "dotted-with-diamond-markers",
    }));
  }
  for (const point of options.points) {
    appendDiamondMarker(
      growthPanel.group,
      xScale(point.timeHours),
      growthPanel.yScale(point.netGrowthLog10PerHour),
      {
        fill: "#ffffff",
        stroke: GROWTH_COLOR,
        "stroke-width": 1.8,
        "data-sample-index": point.index,
        "data-series-marker": "growth",
      },
    );
  }

  const selectionGroup = svgElement(document, "g", {
    "data-selection": "shared",
    "aria-hidden": "true",
  });
  svg.appendChild(selectionGroup);
  const selectionLine = addLine(selectionGroup, {
    x1: PLOT_LEFT,
    y1: PLOT_TOPS[0],
    x2: PLOT_LEFT,
    y2: PLOT_TOPS[2] + PLOT_HEIGHT,
    stroke: SELECTION_COLOR,
    "stroke-width": 1.5,
    "stroke-dasharray": "5 4",
    "data-selection-line": "shared-time",
    "vector-effect": "non-scaling-stroke",
  });
  const populationSelection = appendCircleMarker(selectionGroup, PLOT_LEFT, PLOT_TOPS[0], {
    r: 7,
    fill: "#ffffff",
    stroke: POPULATION_COLOR,
    "stroke-width": 3,
    "data-selected-marker": "population",
  });
  const concentrationSelection = appendSquareMarker(selectionGroup, PLOT_LEFT, PLOT_TOPS[1], {
    size: 13,
    fill: "#ffffff",
    stroke: options.drugColor,
    "stroke-width": 3,
    "data-selected-marker": "concentration",
  });
  const growthSelection = appendDiamondMarker(selectionGroup, PLOT_LEFT, PLOT_TOPS[2], {
    radius: 8,
    fill: "#ffffff",
    stroke: GROWTH_COLOR,
    "stroke-width": 3,
    "data-selected-marker": "growth",
  });

  const populationSelectionLabel = appendText(populationPanel.group, "", {
    x: PLOT_RIGHT,
    y: populationPanel.top - 15,
    fill: POPULATION_COLOR,
    "text-anchor": "end",
    "font-weight": 600,
    "data-selected-value": "population",
  });
  const concentrationSelectionLabel = appendText(concentrationPanel.group, "", {
    x: PLOT_RIGHT,
    y: concentrationPanel.top - 15,
    fill: options.drugColor,
    "text-anchor": "end",
    "font-weight": 600,
    "data-selected-value": "concentration",
  });
  const growthSelectionLabel = appendText(growthPanel.group, "", {
    x: PLOT_RIGHT,
    y: growthPanel.top - 15,
    fill: GROWTH_COLOR,
    "text-anchor": "end",
    "font-weight": 600,
    "data-selected-value": "growth",
  });

  function updateSelection(index, caption) {
    const selectedIndex = clampIndex(index, options.points.length);
    const point = selectedIndex < 0 ? null : options.points[selectedIndex];
    options.selectedIndex = selectedIndex;
    svg.setAttribute("data-selected-index", selectedIndex);
    if (caption?.parentNode) caption.parentNode.setAttribute("data-selected-index", selectedIndex);

    if (!point) {
      selectionGroup.setAttribute("display", "none");
      populationSelectionLabel.textContent = "";
      concentrationSelectionLabel.textContent = "";
      growthSelectionLabel.textContent = "";
    } else {
      selectionGroup.removeAttribute("display");
      const x = xScale(point.timeHours);
      setAttributes(selectionLine, { x1: x, x2: x });
      setAttributes(populationSelection, {
        cx: x,
        cy: populationPanel.yScale(populationValue(point, options.populationScale)),
        "data-sample-index": point.index,
      });
      const concentrationY = concentrationPanel.yScale(
        concentrationValue(point, options.concentrationScale, options.zMic),
      );
      setAttributes(concentrationSelection, {
        x: x - 6.5,
        y: concentrationY - 6.5,
        "data-sample-index": point.index,
      });
      setAttributes(growthSelection, {
        points: diamondPoints(x, growthPanel.yScale(point.netGrowthLog10PerHour), 8),
        "data-sample-index": point.index,
      });

      const displayedPopulation = populationValue(point, options.populationScale);
      populationSelectionLabel.textContent = selectedLabel(
        displayedPopulation,
        options.populationScale === "log" ? "log₁₀(CFU/mL)" : "CFU/mL",
        options,
        strings,
        options.populationScale === "linear",
      );
      concentrationSelectionLabel.textContent = selectedLabel(
        concentrationValue(point, options.concentrationScale, options.zMic),
        concentrationUnit(options.concentrationScale),
        options,
        strings,
      );
      growthSelectionLabel.textContent = selectedLabel(
        point.netGrowthLog10PerHour,
        "log₁₀ fold/hour",
        options,
        strings,
      );
    }

    const summary = selectedSummary(point, options, strings);
    desc.textContent = `${strings.dashboardDescription} ${summary} ${strings.keyboard}`;
    if (caption) caption.textContent = summary;
    return point;
  }

  return {
    svg,
    strings,
    xScale,
    xDomain,
    updateSelection,
  };
}

function sampleIndexFromTarget(target, svg) {
  let node = target;
  while (node && node !== svg) {
    if (typeof node.getAttribute === "function") {
      const value = node.getAttribute("data-sample-index");
      if (value !== null && /^\d+$/.test(value)) return Number(value);
    }
    node = node.parentNode;
  }
  return null;
}

function pointerXInViewBox(event, svg) {
  const rect = typeof svg.getBoundingClientRect === "function"
    ? svg.getBoundingClientRect()
    : null;
  if (
    rect &&
    rect.width > 0 &&
    typeof event.clientX === "number" &&
    Number.isFinite(event.clientX)
  ) {
    return ((event.clientX - rect.left) / rect.width) * DASHBOARD_WIDTH;
  }
  if (typeof event.offsetX === "number" && Number.isFinite(event.offsetX)) {
    const renderedWidth = rect?.width > 0 ? rect.width : DASHBOARD_WIDTH;
    return (event.offsetX / renderedWidth) * DASHBOARD_WIDTH;
  }
  return null;
}

function nearestSampleIndex(points, x, xScale) {
  if (points.length === 0) return -1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(xScale(point.timeHours) - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = point.index;
    }
  }
  return bestIndex;
}

/**
 * Render three linked, accessible SVG charts into a container.
 *
 * @param {Element} container A figure element or a container that will receive one.
 * @param {object} options Chart data, scales, selection, color, locale, and callback.
 * @returns {HTMLElement} The rendered figure element.
 */
export function renderLinkedCharts(container, options) {
  assertContainer(container);
  const normalized = normalizeOptions(options);
  const document = container.ownerDocument;
  const isFigure = String(container.localName || container.tagName || "").toLowerCase() === "figure";
  const figure = isFigure ? container : document.createElement("figure");
  figure.setAttribute("data-linked-charts", "true");
  figure.setAttribute("data-selected-index", normalized.selectedIndex);

  dashboardSequence += 1;
  const dashboard = createDashboardSvg(document, normalized, `linked-charts-${dashboardSequence}`);
  const caption = document.createElement("figcaption");
  caption.setAttribute("data-chart-summary", "true");
  caption.setAttribute("aria-live", "polite");
  dashboard.updateSelection(normalized.selectedIndex, caption);
  replaceChildren(figure, dashboard.svg, caption);
  if (!isFigure) replaceChildren(container, figure);

  const state = {
    figure,
    svg: dashboard.svg,
    options: normalized,
    caption,
    updateSelection: dashboard.updateSelection,
  };
  renderedDashboards.set(container, state);
  renderedDashboards.set(figure, state);
  renderedDashboards.set(dashboard.svg, state);

  function select(index, notify = true) {
    const point = dashboard.updateSelection(index, caption);
    state.options.selectedIndex = point ? point.index : -1;
    if (notify && point && normalized.onSelect) normalized.onSelect(point.index, point.source);
  }

  dashboard.svg.addEventListener("click", (event) => {
    const directIndex = sampleIndexFromTarget(event.target, dashboard.svg);
    if (directIndex !== null) {
      select(directIndex);
      return;
    }
    const x = pointerXInViewBox(event, dashboard.svg);
    if (x === null || x < PLOT_LEFT || x > PLOT_RIGHT) return;
    select(nearestSampleIndex(normalized.points, x, dashboard.xScale));
  });

  dashboard.svg.addEventListener("keydown", (event) => {
    if (normalized.points.length === 0) return;
    let nextIndex = normalized.selectedIndex;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, normalized.selectedIndex - 1);
    else if (event.key === "ArrowRight") {
      nextIndex = Math.min(normalized.points.length - 1, normalized.selectedIndex + 1);
    } else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = normalized.points.length - 1;
    else return;
    event.preventDefault();
    select(nextIndex);
  });

  return figure;
}

function findDashboardSvg(container) {
  if (!container) return null;
  const localName = String(container.localName || container.tagName || "").toLowerCase();
  if (localName === "svg" && container.getAttribute?.("data-linked-chart-dashboard") === "true") {
    return container;
  }
  if (typeof container.querySelector === "function") {
    return container.querySelector('svg[data-linked-chart-dashboard="true"]');
  }
  return null;
}

function safeJsonValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 12) return "[Maximum depth reached]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => safeJsonValue(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    try {
      result[key] = safeJsonValue(value[key], seen, depth + 1);
    } catch (error) {
      result[key] = `[Unreadable: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  seen.delete(value);
  return result;
}

function warningCandidates(metadata) {
  if (!metadata || typeof metadata !== "object") return [];
  const candidates = [
    metadata.warnings,
    metadata.diagnostics?.warnings,
    metadata.result?.diagnostics?.warnings,
    metadata.resolvedModel?.warnings,
  ];
  const warnings = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const warning of candidate) {
      let key;
      try {
        key = JSON.stringify(safeJsonValue(warning));
      } catch {
        key = String(warning);
      }
      if (!seen.has(key)) {
        seen.add(key);
        warnings.push(warning);
      }
    }
  }
  return warnings;
}

function localizedValue(value, locale) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value[locale] ?? value.en ?? value["zh-CN"] ?? null;
  }
  return null;
}

function warningText(warning, locale) {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return String(warning);
  const code = warning.code ? `[${String(warning.code)}] ` : "";
  const message = localizedValue(warning.message, locale)
    ?? localizedValue(warning.text, locale)
    ?? localizedValue(warning.description, locale);
  if (message) return `${code}${message}`;
  try {
    return `${code}${JSON.stringify(safeJsonValue(warning))}`;
  } catch {
    return `${code}${String(warning)}`;
  }
}

function metadataPreviewLines(metadata, locale, maximum = 8) {
  if (!metadata || typeof metadata !== "object") return [];
  const lines = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "warnings") continue;
    if (value === null || ["string", "number", "boolean", "bigint"].includes(typeof value)) {
      lines.push(`${key}: ${String(value)}`);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const identity = [value.id, value.version].filter((item) => item !== undefined).join(" @ ");
      if (identity) lines.push(`${key}: ${identity}`);
    }
    if (lines.length >= maximum) break;
  }
  if (lines.length === 0 && Object.keys(metadata).length > 0) {
    lines.push(copyFor(locale).metadataEmbedded);
  }
  return lines;
}

function wrapText(text, maximumCharacters = 105) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines = [];
  let remaining = normalized;
  while (remaining.length > maximumCharacters) {
    let splitAt = remaining.lastIndexOf(" ", maximumCharacters);
    if (splitAt < Math.floor(maximumCharacters * 0.55)) splitAt = maximumCharacters;
    lines.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

function numericAttribute(element, name, fallback) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : fallback;
}

function viewBoxDimensions(svg) {
  const parts = String(svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return {
    x: 0,
    y: 0,
    width: numericAttribute(svg, "width", DASHBOARD_WIDTH),
    height: numericAttribute(svg, "height", DASHBOARD_HEIGHT),
  };
}

function childWithAttribute(parent, attribute) {
  for (const child of parent.childNodes) {
    if (child.nodeType === 1 && child.getAttribute?.(attribute) !== null) return child;
  }
  return null;
}

function appendExportInformation(svg, metadata, locale) {
  const document = svg.ownerDocument;
  const strings = copyFor(locale);
  const safeMetadata = safeJsonValue(metadata ?? {});
  const metadataNode = svgElement(document, "metadata", {
    id: "chart-export-metadata",
    "data-format": "application/json",
  });
  metadataNode.textContent = JSON.stringify(safeMetadata, null, 2);
  svg.appendChild(metadataNode);

  const metadataLines = metadataPreviewLines(metadata, locale);
  const warnings = warningCandidates(metadata);
  const contentLines = [];
  contentLines.push({ kind: "heading", text: strings.metadata });
  if (metadataLines.length === 0) contentLines.push({ kind: "body", text: strings.noMetadata });
  else {
    for (const line of metadataLines) {
      for (const wrapped of wrapText(line)) contentLines.push({ kind: "body", text: wrapped });
    }
    contentLines.push({ kind: "body", text: strings.metadataEmbedded });
  }
  contentLines.push({ kind: "heading", text: strings.warnings });
  if (warnings.length === 0) contentLines.push({ kind: "body", text: strings.noWarnings });
  else {
    for (const warning of warnings) {
      for (const wrapped of wrapText(warningText(warning, locale))) {
        contentLines.push({ kind: "warning", text: wrapped });
      }
    }
  }

  const dimensions = viewBoxDimensions(svg);
  const lineHeight = 18;
  const footerPadding = 24;
  const footerHeight = footerPadding * 2 + contentLines.length * lineHeight;
  const footerTop = dimensions.y + dimensions.height;
  const newHeight = dimensions.height + footerHeight;
  svg.setAttribute("viewBox", `${dimensions.x} ${dimensions.y} ${dimensions.width} ${newHeight}`);
  svg.setAttribute("width", dimensions.width);
  svg.setAttribute("height", newHeight);
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("version", "1.1");
  svg.removeAttribute("tabindex");
  svg.removeAttribute("aria-keyshortcuts");
  svg.setAttribute("focusable", "false");

  const background = childWithAttribute(svg, "data-dashboard-background");
  if (background) background.setAttribute("height", newHeight);

  const footer = svgElement(document, "g", {
    transform: `translate(0 ${coordinate(footerTop)})`,
    "data-chart-export-footer": "true",
  });
  footer.appendChild(svgElement(document, "rect", {
    x: 0,
    y: 0,
    width: dimensions.width,
    height: footerHeight,
    fill: "#f8fafc",
    stroke: GRID_COLOR,
    "stroke-width": 1,
  }));
  let y = footerPadding;
  for (const line of contentLines) {
    appendText(footer, line.text, {
      x: PLOT_LEFT,
      y,
      fill: line.kind === "warning" ? REFERENCE_COLOR : TEXT_COLOR,
      "font-size": line.kind === "heading" ? 13 : 11,
      "font-weight": line.kind === "heading" ? 700 : 400,
      "data-export-line": line.kind,
    });
    y += lineHeight;
  }
  svg.appendChild(footer);

  const desc = Array.from(svg.childNodes).find(
    (child) => child.nodeType === 1 && String(child.localName).toLowerCase() === "desc",
  );
  if (desc) {
    const warningSummary = warnings.length === 0
      ? strings.noWarnings
      : `${strings.warnings}: ${warnings.map((warning) => warningText(warning, locale)).join("; ")}`;
    desc.textContent = `${desc.textContent || ""} ${warningSummary}`.trim();
  }
}

const SAFE_ELEMENTS = new Set([
  "svg",
  "title",
  "desc",
  "metadata",
  "g",
  "rect",
  "line",
  "path",
  "circle",
  "polygon",
  "text",
  "tspan",
]);

const SAFE_ATTRIBUTES = new Set([
  "xmlns",
  "version",
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "display",
  "text-anchor",
  "dominant-baseline",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "vector-effect",
  "preserveAspectRatio",
  "role",
  "focusable",
  "lang",
  "id",
  "class",
]);

function validXmlString(value) {
  let result = "";
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    const allowed = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (allowed) result += character;
  }
  return result;
}

function escapeXmlText(value) {
  return validXmlString(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replaceAll('"', "&quot;");
}

function safeAttribute(name, value) {
  const normalizedName = String(name);
  const lowerName = normalizedName.toLowerCase();
  const allowedName = SAFE_ATTRIBUTES.has(normalizedName) ||
    lowerName.startsWith("aria-") ||
    lowerName.startsWith("data-");
  if (!allowedName || lowerName.startsWith("on")) return false;
  return !/(?:url\s*\(|javascript:|vbscript:|data:|https?:|\/\/)/i.test(String(value));
}

function serializeSafeNode(node) {
  if (node.nodeType === 3 || node.nodeType === 4) return escapeXmlText(node.nodeValue || "");
  if (node.nodeType !== 1) return "";
  const name = String(node.localName || node.tagName || "").toLowerCase();
  if (!SAFE_ELEMENTS.has(name)) return "";

  const attributes = [];
  for (const attribute of Array.from(node.attributes || [])) {
    if (safeAttribute(attribute.name, attribute.value)) {
      attributes.push(`${attribute.name}="${escapeXmlAttribute(attribute.value)}"`);
    }
  }
  if (name === "svg" && !attributes.some((attribute) => attribute.startsWith("xmlns="))) {
    attributes.unshift(`xmlns="${SVG_NS}"`);
  }
  const opening = attributes.length > 0 ? `<${name} ${attributes.join(" ")}>` : `<${name}>`;
  const children = Array.from(node.childNodes || []).map(serializeSafeNode).join("");
  return `${opening}${children}</${name}>`;
}

/**
 * Serialize a rendered dashboard as a standalone, self-contained, filtered SVG string.
 * Metadata is embedded as JSON text and warnings are also rendered in a text-only footer.
 *
 * @param {Element} container A rendered figure, its parent container, or the dashboard SVG.
 * @param {object} metadata Serializable run/model metadata; warnings may be supplied on common warning paths.
 * @returns {string} A standalone SVG document string.
 */
export function serializeChartDashboard(container, metadata = {}) {
  if (!container || typeof container !== "object") {
    throw new TypeError("container must contain a dashboard rendered by renderLinkedCharts().");
  }
  const sourceSvg = findDashboardSvg(container);
  if (!sourceSvg || typeof sourceSvg.cloneNode !== "function") {
    throw new TypeError("No linked chart dashboard SVG was found in container.");
  }
  const panelCount = typeof sourceSvg.querySelectorAll === "function"
    ? sourceSvg.querySelectorAll("[data-chart-panel]").length
    : 0;
  if (panelCount !== 3) {
    throw new TypeError("The dashboard must contain exactly three chart panels before serialization.");
  }

  const clone = sourceSvg.cloneNode(true);
  const state = renderedDashboards.get(container) ?? renderedDashboards.get(sourceSvg);
  const locale = state?.options.locale || sourceSvg.getAttribute("lang") || "en";
  appendExportInformation(clone, metadata, locale);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serializeSafeNode(clone)}`;
}
