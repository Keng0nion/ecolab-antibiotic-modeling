#!/usr/bin/env python3
"""Extract the reference values and background evidence for the Cond00003 replication experiment.

Inputs (data/, downloaded from figshare dataset 28342064, CC BY 4.0; see README.md):
- BW25113_GrowthDataEvaluation.xlsx : the authors' per-curve K and r values and reliability flags
- BW25113_Growth_Round01.xlsx       : raw Round 01 OD600 records (time axis 0.5 .. 48.5 h)
- BW25113_Medium_composition.xlsx   : label -> condition mapping and per-condition composition

Outputs (derived/):
- reference-values.json    : K, r and flags for the twelve Cond00003 curves Curve00025..Curve00036
- background-evidence.json : statistics of flat (no-growth / media-only) wells observed in Round 01
                             and the full Cond00003 composition row

The script refuses to run if any input file does not match the recorded SHA-256, so the
derived values cannot silently drift from the deposited files.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import openpyxl

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
DERIVED = HERE / "derived"

EXPECTED_SHA256 = {
    "BW25113_GrowthDataEvaluation.xlsx": "2ae299c04f6a4de7401d3896413030db050b28691764be7940da471f351e03b1",
    "BW25113_Growth_Round01.xlsx": "d81c738fdf7885195203de9b8b28bc221cf81992dffe1288c42b81aa6876d921",
    "BW25113_Medium_composition.xlsx": "e3d82236c0f9a65cff55bebf1d5478b15a0972111422c32a3395deb5c5509cdd",
}

TARGET_LABELS = [f"Curve{index:05d}" for index in range(25, 37)]
FLAT_RANGE_LIMIT = 0.002
FLAT_MIN_POINTS = 30


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_rows(path: Path):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    return list(sheet.iter_rows(values_only=True))


def main() -> None:
    DERIVED.mkdir(exist_ok=True)

    input_digests = {}
    for name, expected in EXPECTED_SHA256.items():
        actual = sha256_of(DATA / name)
        if actual != expected:
            raise SystemExit(f"input hash mismatch for {name}: {actual} != {expected}")
        input_digests[name] = actual

    # --- reference K/r values for the twelve Cond00003 curves -----------------
    evaluation_rows = load_rows(DATA / "BW25113_GrowthDataEvaluation.xlsx")
    curves = []
    for row in evaluation_rows[1:]:
        label = row[0]
        if label in TARGET_LABELS:
            curves.append({
                "label": label,
                "assayId": row[1],
                "conditionId": row[2],
                "K": row[3],
                "r": row[4],
                "kInfo": row[5],
                "rInfo": row[6],
            })
    curves.sort(key=lambda record: record["label"])
    if len(curves) != len(TARGET_LABELS):
        raise SystemExit(f"expected {len(TARGET_LABELS)} reference rows, found {len(curves)}")

    # --- flat (no-growth / media-only) wells in Round 01 ----------------------
    round01_rows = load_rows(DATA / "BW25113_Growth_Round01.xlsx")
    header = round01_rows[0]
    composition = load_rows(DATA / "BW25113_Medium_composition.xlsx")
    condition_of = {row[0]: row[2] for row in composition[1:] if row and row[0]}

    flat_wells = []
    for column_index in range(1, len(header)):
        label = header[column_index]
        if label is None:
            continue
        values = [row[column_index] for row in round01_rows[1:] if row[column_index] is not None]
        if len(values) >= FLAT_MIN_POINTS and (max(values) - min(values)) <= FLAT_RANGE_LIMIT:
            flat_wells.append({
                "label": label,
                "conditionId": condition_of.get(label),
                "points": len(values),
                "meanOd": round(sum(values) / len(values), 6),
                "minOd": min(values),
                "maxOd": max(values),
            })

    # --- composition row for Cond00003 ----------------------------------------
    cond00003_header = None
    cond00003_row = None
    for row in composition[1:]:
        if row and row[2] == "Cond00003":
            cond00003_header = [cell for cell in composition[0]]
            cond00003_row = row
            break
    cond00003_composition = {}
    if cond00003_row is not None:
        for name, value in zip(cond00003_header[3:], cond00003_row[3:]):
            if value is None:
                continue
            cond00003_composition[str(name).replace("\n", " ").strip()] = value

    reference = {
        "note": "Reference K and r as deposited by the dataset authors (figshare 28342064,"
                " BW25113_GrowthDataEvaluation.xlsx, CC BY 4.0). K is the background-subtracted"
                " plateau OD600; r is the maximum consecutive log-slope triplet average.",
        "inputs": input_digests,
        "curves": curves,
    }
    background = {
        "note": "Flat wells observed in Round 01 (range <= 0.002 OD over at least 30 points)."
                " They bound the optical background of the plate series; the authors' own"
                " media-only blank wells were not deposited.",
        "inputs": input_digests,
        "flatWells": flat_wells,
        "cond00003Composition": cond00003_composition,
    }

    (DERIVED / "reference-values.json").write_text(
        json.dumps(reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (DERIVED / "background-evidence.json").write_text(
        json.dumps(background, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"reference curves: {len(curves)}")
    print("  K range: %.4f .. %.4f" % (min(c["K"] for c in curves), max(c["K"] for c in curves)))
    print("  r range: %.4f .. %.4f" % (min(c["r"] for c in curves), max(c["r"] for c in curves)))
    print(f"flat wells: {len(flat_wells)}")
    if flat_wells:
        means = [w["meanOd"] for w in flat_wells]
        print("  mean OD range: %.4f .. %.4f (mean %.4f)"
              % (min(means), max(means), sum(means) / len(means)))
    print(f"Cond00003 composition entries: {len(cond00003_composition)}")


if __name__ == "__main__":
    main()
