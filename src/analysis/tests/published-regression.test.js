import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateRegoesNetGrowth } from "../../model.js";

const fixture = JSON.parse(await readFile(
  new URL("../../../data/fixtures/foerster-2016-identifiable-parameter-references.json", import.meta.url),
  "utf8",
));

function parametersFor(row) {
  return {
    psiMaxLog10PerHour: row.psiMaxPerHour,
    carryingCapacityLog10CfuPerMl: 9.5,
    drugs: {
      ciprofloxacin: {
        zMicMgPerL: row.zMicMicrogramPerMl,
        hillKappa: row.kappa,
        psiMinLog10PerHour: row.psiMinPerHour,
      },
    },
  };
}

test("Foerster 2016 Tables S1/S2 fixture keeps only informative published SE rows", () => {
  assert.equal(fixture.kind, "published-parameter-reference-fixture");
  assert.equal(fixture.source.doi, "10.1186/s12866-016-0838-9");
  assert.match(fixture.source.supplementUrl, /12866_2016_838_MOESM1_ESM\.pdf/);
  assert.equal(fixture.includedRows.filter(({ table }) => table === "S1").length, 15);
  assert.equal(fixture.includedRows.filter(({ table }) => table === "S2").length, 5);
  assert.deepEqual(fixture.includedRows.map(({ table, row }) => `${table}:${row}`), [
    "S1:1", "S1:2", "S1:4", "S1:6", "S1:7", "S1:8", "S1:10", "S1:11", "S1:12", "S1:13",
    "S1:14", "S1:15", "S1:16", "S1:17", "S1:18", "S2:19", "S2:20", "S2:21", "S2:22", "S2:23",
  ]);
  assert.deepEqual(fixture.excludedRows.map(({ table, row }) => `${table}:${row}`), ["S1:3", "S1:5", "S1:9", "S2:24"]);
  assert.match(fixture.excludedRows.find(({ row }) => row === 9).reason, /weakly resolved/);
  assert.match(fixture.excludedRows.find(({ table, row }) => table === "S2" && row === 24).reason, /repeats/);

  for (const row of fixture.includedRows) {
    const pairs = [
      [row.kappa, row.kappaSe],
      [row.psiMaxPerHour, row.psiMaxSePerHour],
      [row.psiMinPerHour, row.psiMinSePerHour],
      [row.zMicMicrogramPerMl, row.zMicSeMicrogramPerMl],
    ];
    for (const [estimate, standardError] of pairs) {
      assert.ok(Number.isFinite(estimate) && Number.isFinite(standardError), `${row.table}:${row.row}`);
      assert.ok(standardError > 0 && standardError < Math.abs(estimate), `${row.table}:${row.row}`);
    }
  }
  assert.match(fixture.interpretationLimit, /does not refit the original observations/);
});

test("Regoes stable logistic evaluation matches its algebraic parameterization on S1/S2 references", () => {
  const concentrationMultipliers = [0, 0.01, 0.1, 0.5, 1, 2, 10, 100];
  for (const row of fixture.includedRows) {
    const modelParameters = parametersFor(row);
    for (const multiplier of concentrationMultipliers) {
      const concentrationMgPerL = row.zMicMicrogramPerMl * multiplier;
      const actual = evaluateRegoesNetGrowth(modelParameters, "ciprofloxacin", concentrationMgPerL);
      const ratioPower = multiplier === 0 ? 0 : multiplier ** row.kappa;
      const expected = multiplier === 0
        ? row.psiMaxPerHour
        : row.psiMaxPerHour * (1 - ratioPower)
          / (1 - ratioPower * row.psiMaxPerHour / row.psiMinPerHour);
      assert.ok(Math.abs(actual - expected) <= 1e-11 * Math.max(1, Math.abs(expected)), `${row.table}:${row.row}, C/zMIC=${multiplier}`);
    }
    assert.equal(evaluateRegoesNetGrowth(modelParameters, "ciprofloxacin", row.zMicMicrogramPerMl), 0,
      `${row.table}:${row.row} must have the zero-growth point at zMIC`);
    const highConcentration = evaluateRegoesNetGrowth(modelParameters, "ciprofloxacin", row.zMicMicrogramPerMl * 1e12);
    assert.ok(Math.abs(highConcentration - row.psiMinPerHour) < 1e-6, `${row.table}:${row.row} must approach psiMin`);
  }
});
