# Ecolab 6.2.0 release notes

Date: 2026-11-26. Application `6.2.0`; analysis engine `2.2.0`; scientific core `2.0.0`; teaching model `1.0.0`.

This release has two parts: an application-level import and provenance update, and an analysis-engine precision update that was already prepared as `2.2.0`.

## Excel import

- The Research Workspace file picker now accepts `.xlsx` alongside normalized JSON and CSV.
- `src/app/research/xlsx-import.js` reads the ZIP container and the first worksheet with no third-party dependency, converts that worksheet to CSV text, and hands the text to the existing strict importer. Headers, units, measurement types, ranges and censoring are still validated by `src/analysis/dataset-import.js`; Excel is a transport format only.
- Only the first worksheet is read. Formulas use their cached values, Excel date serials are not converted, and merged cells, hidden rows and styles are ignored. The conversion is recorded as an `XLSX_FIRST_WORKSHEET_ONLY` import warning with the worksheet name, worksheet count and grid size, and the dataset record keeps `sourceFormat: "xlsx"`.
- CSV and Excel imports both require the explicit dataset ID, title and license. Nothing is inferred from the file name or the sheet.
- Stable rejection codes: `XLSX_LEGACY_FORMAT` (`.xls`), `XLSX_ENCRYPTED`, `XLSX_ZIP64`, `XLSX_COMPRESSION`, `XLSX_UNSAFE_PATH`, `XLSX_EMPTY`, `XLSX_NO_WORKSHEET`, `XLSX_TOO_WIDE`, `XLSX_CORRUPT`, `XLSX_INFLATE_UNAVAILABLE`.
- The grid limit is 100,000 rows by 256 columns, matching the strict importer. Wide plate layouts such as a 96-well matrix are rejected with a message asking for the long observation layout; they are not reshaped automatically.

## Provenance manifest

- `data/raw/figshare-bw25113-growth-v1/acquisition.json` is now tracked in git while the three XLSX payloads remain ignored. `npm run audit:data` requires the manifest, so an untracked copy made a fresh clone fail with `ENOENT`; that is the missing-file error reported against 6.1.0.
- The audit error now names both recovery paths: `git checkout -- data/raw/figshare-bw25113-growth-v1/acquisition.json` or `npm run data:acquire:figshare`.
- Published products still exclude `data/raw/` and every `.xlsx`; the manifest is repository provenance, not a web asset.

## Profile precision (analysis 2.2.0)

- Profile-likelihood endpoints are solved with a deterministic bracket-and-bisection refinement. The five-point grid reported `psiMax` at `±0.345%`; the refined IID interval is `[0.407965, 0.438915]`, `±3.66%`. Eight iterations agree with twenty to `1.0e-6` relative.
- A random-intercept AR(1) sensitivity interval is reported by the `precision` preset. It is anchored at the IID estimate, reoptimizes nuisance parameters under IID least squares, and is explicitly not a joint AR(1) refit. It widens the interval overall; its upper `psiMax` bound is closer to the estimate than the IID upper bound, which is an artefact of the anchoring and must not be quoted as a tighter limit.
- `small` and `standard` presets keep their previous behaviour and `small` remains the default.
- The release audit now compares a recorded preset with the resolved configuration in both directions, so a `precision` run can no longer be relabelled `standard`.

## Versioned examples and replay

- The current example is `data/examples/ecolab-stage6-research-6.2.0.{json,md}`, generated with the `precision` preset and analysis `2.2.0`.
- The `5.0.0`, `6.0.0` and `6.1.0` examples are byte-frozen. The `6.1.0` pair was restored to its released bytes before this release; it is not regenerated.
- Replay requires application `6.2.0` and analysis `2.2.0` exactly. A `6.1.0` package is inspect-only and is refused with `UNSUPPORTED_SOFTWARE_VERSION`.

## Boundaries

Excel import does not turn a plate matrix into observations, does not convert dates, and does not relax any scientific validation. The precision work does not identify `K`, absolute CFU scale, `scaleOd` absolute scale, `psiMin`, `kappa` or `zMIC`; those require new experiments or calibration data, not more optimizer budget. Profile intervals remain conditional on the model, the Gaussian error assumption, the parameter bounds and the fitted dataset.
