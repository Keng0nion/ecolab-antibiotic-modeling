import modelParameters from "../data/model-parameters.json" with { type: "json" };

const { baseline, populationModel, drugs } = modelParameters;

export const BASELINE = Object.freeze({
  organism: baseline.organism,
  medium: baseline.medium,
  doublingMinutes: baseline.doublingTimeMinutes,
  doublingUncertaintyMinutes: baseline.uncertaintyMinutes,
  psiMax: Math.log10(2) / (baseline.doublingTimeMinutes / 60),
  initialPopulation: populationModel.initialCfuPerMl,
  carryingCapacity: populationModel.carryingCapacityCfuPerMl,
  detectionFloor: populationModel.detectionFloorCfuPerMl,
  timeStepMinutes: populationModel.timeStepMinutes,
});

export const DRUGS = Object.freeze({
  none: {
    id: "none",
    name: "无药对照",
    latin: "No antibiotic",
    short: "CTRL",
    color: "#93a4b8",
    glow: "rgba(147, 164, 184, 0.3)",
    mechanism: "仅观察营养限制下的逻辑斯蒂增长。",
    kind: "control",
    mic: null,
    hill: null,
    psiMin: null,
  },
  ampicillin: {
    id: "ampicillin",
    name: "氨苄西林",
    latin: "Ampicillin",
    short: "AMP",
    color: "#ffb15d",
    glow: "rgba(255, 177, 93, 0.35)",
    mechanism: "β-内酰胺类；干扰细胞壁合成，属于杀菌性药物。",
    kind: "bactericidal",
    mic: drugs.ampicillin.zMicMgPerL,
    hill: drugs.ampicillin.hillKappa,
    psiMin: drugs.ampicillin.psiMinLog10PerHour,
    paperMic: drugs.ampicillin.paperBrothDilutionMicMgPerL,
  },
  tetracycline: {
    id: "tetracycline",
    name: "四环素",
    latin: "Tetracycline",
    short: "TET",
    color: "#ffd85d",
    glow: "rgba(255, 216, 93, 0.32)",
    mechanism: "结合 30S 核糖体亚基并抑制蛋白质合成；主要为抑菌性。",
    kind: "bacteriostatic",
    mic: drugs.tetracycline.zMicMgPerL,
    hill: drugs.tetracycline.hillKappa,
    psiMin: drugs.tetracycline.psiMinLog10PerHour,
    paperMic: drugs.tetracycline.paperBrothDilutionMicMgPerL,
  },
  ciprofloxacin: {
    id: "ciprofloxacin",
    name: "环丙沙星",
    latin: "Ciprofloxacin",
    short: "CIP",
    color: "#67e8f9",
    glow: "rgba(103, 232, 249, 0.34)",
    mechanism: "抑制 DNA gyrase（拓扑异构酶 II）与拓扑异构酶 IV；属于杀菌性药物。",
    kind: "bactericidal",
    mic: drugs.ciprofloxacin.zMicMgPerL,
    hill: drugs.ciprofloxacin.hillKappa,
    psiMin: drugs.ciprofloxacin.psiMinLog10PerHour,
    paperMic: drugs.ciprofloxacin.paperBrothDilutionMicMgPerL,
  },
});

export function concentrationRatio(drugId, concentration) {
  const drug = DRUGS[drugId];
  if (!drug || !drug.mic) return 0;
  const numericConcentration = Number(concentration);
  if (!Number.isFinite(numericConcentration)) return 0;
  return Math.max(0, numericConcentration) / drug.mic;
}

export function pharmacodynamicGrowth(drugId, concentration, psiMax = BASELINE.psiMax) {
  const drug = DRUGS[drugId];
  const numericConcentration = Number(concentration);
  if (
    !drug ||
    drugId === "none" ||
    !Number.isFinite(numericConcentration) ||
    numericConcentration <= 0
  ) {
    return psiMax;
  }

  const ratio = concentrationRatio(drugId, numericConcentration);
  const powered = ratio ** drug.hill;
  const denominator = powered - drug.psiMin / psiMax;

  return psiMax - ((psiMax - drug.psiMin) * powered) / denominator;
}

export function effectiveGrowth(state) {
  const raw = pharmacodynamicGrowth(state.drugId, state.concentration);
  if (raw <= 0) return raw;
  const crowding = Math.max(0, 1 - state.population / BASELINE.carryingCapacity);
  return raw * crowding;
}

export function createInitialState() {
  return {
    timeMinutes: 0,
    population: BASELINE.initialPopulation,
    drugId: "none",
    concentration: 0,
    netGrowth: BASELINE.psiMax,
    cumulativeDeaths: 0,
  };
}

export function stepSimulation(state, dtMinutes = BASELINE.timeStepMinutes) {
  const numericDuration = Number(dtMinutes);
  const safeDuration = Number.isFinite(numericDuration)
    ? Math.max(0, numericDuration)
    : BASELINE.timeStepMinutes;
  const dtHours = safeDuration / 60;
  const growth = effectiveGrowth(state);
  const previous = Math.min(
    BASELINE.carryingCapacity,
    Math.max(BASELINE.detectionFloor, Number(state.population) || BASELINE.detectionFloor),
  );
  const projected = previous * 10 ** (growth * dtHours);
  const population = Math.min(
    BASELINE.carryingCapacity,
    Math.max(BASELINE.detectionFloor, projected),
  );

  return {
    ...state,
    timeMinutes: state.timeMinutes + safeDuration,
    population,
    netGrowth: growth,
    cumulativeDeaths:
      state.cumulativeDeaths + (population < previous ? previous - population : 0),
  };
}

export function applyDose(state, drugId, multipleOfMic) {
  const drug = DRUGS[drugId];
  if (!drug || drugId === "none") return washout(state);
  const multiple = Math.max(0, Number(multipleOfMic) || 0);
  return {
    ...state,
    drugId,
    concentration: drug.mic * multiple,
  };
}

export function washout(state) {
  return {
    ...state,
    drugId: "none",
    concentration: 0,
  };
}

export function dilute(state, fractionRemaining = 0.5) {
  const numericFraction = Number(fractionRemaining);
  const fraction = Number.isFinite(numericFraction)
    ? Math.min(1, Math.max(0, numericFraction))
    : 0.5;
  const concentration = state.concentration * fraction;
  return {
    ...state,
    drugId: concentration < 1e-12 ? "none" : state.drugId,
    concentration,
  };
}

export function formatPopulation(value) {
  if (value <= BASELINE.detectionFloor) return "≤10";
  return value.toExponential(2).replace("e+", " × 10^");
}
