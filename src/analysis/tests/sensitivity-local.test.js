import test from "node:test";
import assert from "node:assert/strict";
import { localSensitivity } from "../sensitivity-local.js";

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("local central differences recover a linear derivative", () => {
  const result = localSensitivity({
    parameterSpace: {
      parameters: [
        {
          name: "psiMaxLog10PerHour",
          lower: 0,
          upper: 2,
          rationale: "Synthetic linear derivative test.",
        },
      ],
    },
    baseline: { psiMaxLog10PerHour: 0.7 },
    scheme: "central",
    step: 1e-4,
    evaluator: ({ psiMaxLog10PerHour }) => 3 * psiMaxLog10PerHour + 4,
  });
  close(result.byParameter.psiMaxLog10PerHour.derivative, 3);
  assert.equal(result.byParameter.psiMaxLog10PerHour.scheme, "central");
});

test("local sensitivity uses one-sided differences at a transformed-space bound", () => {
  const result = localSensitivity({
    parameterSpace: {
      parameters: [
        {
          name: "psiMaxLog10PerHour",
          lower: 0.1,
          upper: 10,
          transform: "log",
          rationale: "Synthetic transformed derivative test.",
        },
      ],
    },
    baseline: { psiMaxLog10PerHour: 0.1 },
    evaluator: ({ psiMaxLog10PerHour }) => Math.log(psiMaxLog10PerHour),
  });
  close(result.byParameter.psiMaxLog10PerHour.derivative, 1, 1e-6);
  assert.equal(result.byParameter.psiMaxLog10PerHour.scheme, "forward");
});
