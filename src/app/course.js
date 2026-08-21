export const COURSE_STEPS = Object.freeze([
  {
    id: "limits",
    titleKey: "course.limits.title",
    bodyKey: "course.limits.body",
    action: "open-sources",
  },
  {
    id: "control-growth",
    titleKey: "course.control.title",
    bodyKey: "course.control.body",
    action: "run-control",
  },
  {
    id: "zmic",
    titleKey: "course.zmic.title",
    bodyKey: "course.zmic.body",
    action: "run-zmic",
  },
  {
    id: "high-dose",
    titleKey: "course.high.title",
    bodyKey: "course.high.body",
    action: "run-high",
  },
  {
    id: "washout",
    titleKey: "course.washout.title",
    bodyKey: "course.washout.body",
    action: "run-washout",
  },
  {
    id: "compare",
    titleKey: "course.compare.title",
    bodyKey: "course.compare.body",
    action: "compare-drugs",
  },
  {
    id: "reproducibility",
    titleKey: "course.repro.title",
    bodyKey: "course.repro.body",
    action: "save-export",
  },
]);

export function courseStep(index) {
  return COURSE_STEPS[Math.max(0, Math.min(COURSE_STEPS.length - 1, index))];
}

export function coursePreset(action, resolvedModel) {
  const ciprofloxacin = resolvedModel.parameters.drugs.ciprofloxacin;
  const fourZMic = ciprofloxacin.zMicMgPerL * 4;
  const base = {
    drugId: "ciprofloxacin",
    initialPopulationCfuPerMl: 1_000_000,
    detectionLimitCfuPerMl: 10,
    sampleIntervalMinutes: 5,
  };

  switch (action) {
    case "run-control":
      return {
        ...base,
        drugId: "none",
        segments: [{ durationMinutes: 240, concentrationMgPerL: 0 }],
      };
    case "run-zmic":
      return {
        ...base,
        segments: [
          { durationMinutes: 60, concentrationMgPerL: ciprofloxacin.zMicMgPerL },
        ],
      };
    case "run-high":
      return {
        ...base,
        segments: [{ durationMinutes: 60, concentrationMgPerL: fourZMic }],
      };
    case "run-washout":
      return {
        ...base,
        segments: [
          { durationMinutes: 60, concentrationMgPerL: fourZMic },
          { durationMinutes: 30, concentrationMgPerL: fourZMic / 2, operation: "dilute" },
          { durationMinutes: 60, concentrationMgPerL: 0, operation: "washout" },
        ],
      };
    case "compare-drugs":
      return {
        ...base,
        compareAtZMicMultiple: 4,
        segments: [{ durationMinutes: 60, concentrationMgPerL: fourZMic }],
      };
    default:
      return null;
  }
}
