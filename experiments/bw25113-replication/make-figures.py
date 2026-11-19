#!/usr/bin/env python3
"""Figures for the Cond00003 replication report.

Reads derived/results.json, derived/reference-values.json and the bundled dataset JSON;
writes figures/fig1..fig4 as 200 dpi PNG files sized for an A4 report column.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DERIVED = HERE / "derived"
FIGURES = HERE / "figures"

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
    "mathtext.fontset": "stix",
    "font.size": 9,
    "axes.titlesize": 9.5,
    "axes.labelsize": 9,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "legend.fontsize": 7.5,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "figure.dpi": 200,
    "savefig.dpi": 200,
})

WORKED_CURVE = "Curve00032"
ANCHOR_MIN, ANCHOR_VALUE, ANCHOR_MAX = 30.0, 42.0, 54.0
C_RAW = "#3b6ea5"
C_ACCENT = "#b3541e"
C_GREEN = "#2e7d5b"
C_GREY = "#666666"


def load():
    results = json.load(open(DERIVED / "results.json", encoding="utf-8"))
    reference = json.load(open(DERIVED / "reference-values.json", encoding="utf-8"))
    dataset = json.load(open(ROOT / "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", encoding="utf-8"))
    series = {}
    for observation in dataset["observations"]:
        series.setdefault(observation["seriesId"], []).append((observation["timeHours"], observation["value"]))
    for key in series:
        series[key].sort()
    return results, reference, series


def fig1_raw_curves(series):
    fig, ax = plt.subplots(figsize=(6.4, 3.1))
    for series_id, points in sorted(series.items()):
        times = [p[0] for p in points]
        values = [p[1] for p in points]
        label = series_id.split("|")[0]
        if label == WORKED_CURVE:
            ax.plot(times, values, color=C_ACCENT, lw=1.6, zorder=5, label=f"{label} (worked example)")
        else:
            ax.plot(times, values, color=C_RAW, lw=0.7, alpha=0.55)
    ax.axvspan(0.5, 5.0, color="#d9d9d9", alpha=0.45, zorder=0)
    ax.annotate("pre-growth plateau\n(background window)", xy=(2.7, 0.105), ha="center", fontsize=7.5, color=C_GREY)
    ax.annotate("exponential-like rise", xy=(9.2, 0.135), rotation=38, fontsize=7.5, color=C_GREY)
    ax.annotate("stationary / decline", xy=(17.5, 0.317), ha="center", fontsize=7.5, color=C_GREY)
    ax.set_xlabel("Time (h)")
    ax.set_ylabel(r"OD$_{600}$ (raw, unblanked)")
    ax.set_title("Figure 1. All twelve Cond00003 growth curves (BW25113, 37 °C, untreated)")
    ax.legend(frameon=False, loc="lower right")
    ax.set_xlim(0, 22.3)
    fig.tight_layout()
    fig.savefig(FIGURES / "fig1-raw-curves.png")
    plt.close(fig)


def fig2_worked_example(results, series):
    curve = next(c for c in results["perCurve"] if c["label"] == WORKED_CURVE)
    points = series[curve["seriesId"]]
    times = np.array([p[0] for p in points])
    raw = np.array([p[1] for p in points])
    mid = curve["byScenario"]["mid"]
    high = curve["byScenario"]["high"]
    low = curve["byScenario"]["low"]

    fig, (left, right) = plt.subplots(1, 2, figsize=(6.6, 3.3))

    left.plot(times, raw, "o-", color=C_RAW, ms=2.6, lw=0.8, label="raw OD")
    for scenario, color, style in ((high, C_GREEN, ":"), (mid, C_ACCENT, "--"), (low, C_GREY, "-.")):
        left.axhline(scenario["background"], color=color, lw=0.9, ls=style,
                     label=f"{scenario['background']:.3f}")
    left.axvspan(0.5, 5.0, color="#d9d9d9", alpha=0.4, zorder=0)
    left.set_xlabel("Time (h)")
    left.set_ylabel(r"OD$_{600}$")
    left.set_title("(a) raw curve and three backgrounds")
    left.legend(frameon=False, loc="upper left", title="Background (OD)", title_fontsize=7)
    left.set_xlim(0, 15)

    inset = left.inset_axes([0.50, 0.14, 0.40, 0.30])
    window = (times >= 5.5) & (times <= 8.5)
    inset.plot(times[window], raw[window], "o", color=C_RAW, ms=2.2)
    inset.set_title("0.001 OD staircase", fontsize=6.5)
    inset.tick_params(labelsize=5.5, length=2)
    inset.set_xlim(5.7, 8.3)
    inset.set_ylim(0.0825, 0.1125)

    band_lo, band_hi = results["config"]["robustNetWindowOd"]
    for scenario, color, tag, tag_dy in ((high, C_GREEN, "high", 1.5), (mid, C_ACCENT, "mid", 1.5), (low, C_GREY, "low", 0.55)):
        background = scenario["background"]
        net = raw - background
        mask = net > 0
        right.semilogy(times[mask], net[mask], color=color, lw=1.1,
                       label=f"net, B={background:.3f}")
        peak = scenario["rate"]["peakPairHours"]
        peak_t = 0.5 * (peak[0] + peak[1])
        peak_y = float(np.interp(peak_t, times, net))
        right.plot([peak_t], [peak_y], "x", color=color, ms=5, mew=1.4)
        right.text(peak_t + 0.35, peak_y * tag_dy, f"max-pair\n{tag}", fontsize=6.2, color=color, va="center")
    right.axhspan(band_lo, band_hi, color="#f2d17c", alpha=0.35, zorder=0)
    right.annotate(f"robust window\n{band_lo:g}–{band_hi:g} OD", xy=(13.2, 0.033), fontsize=7, color="#7a5c00")
    right.set_xlabel("Time (h)")
    right.set_ylabel(r"Net signal $\mathrm{OD}_{600}-B$ (log scale)")
    right.set_title("(b) net signal; × marks the literal max-slope pair")
    right.legend(frameon=False, loc="lower right")
    right.set_ylim(5e-4, 0.6)
    right.set_xlim(4.5, 22)

    fig.tight_layout()
    fig.savefig(FIGURES / "fig2-worked-example.png")
    plt.close(fig)


def fig3_replication(results, reference):
    by_label = {c["label"]: c for c in results["perCurve"]}
    labels = [c["label"] for c in reference["curves"]]
    ref_r = np.array([c["r"] for c in reference["curves"]])
    ref_k = np.array([c["K"] for c in reference["curves"]])
    lit_r = np.array([by_label[l]["byScenario"]["mid"]["rate"]["rLn"] for l in labels])
    cw_r = np.array([by_label[l]["byScenario"]["mid"]["rate"]["rCenteredWindowMax"]["rLn"] for l in labels])
    scenario_ids = ("high", "mid", "low")
    r_err = np.array([
        [
            by_label[l]["byScenario"]["mid"]["rate"]["rLn"] - min(
                by_label[l]["byScenario"][s]["rate"]["rLn"] for s in scenario_ids),
            max(by_label[l]["byScenario"][s]["rate"]["rLn"] for s in scenario_ids)
            - by_label[l]["byScenario"]["mid"]["rate"]["rLn"],
        ]
        for l in labels]).T
    k_rep = np.array([by_label[l]["byScenario"]["mid"]["carryingCapacity"]["k"] for l in labels])

    fig, (left, right) = plt.subplots(1, 2, figsize=(6.6, 3.2))
    limit = [0.9, 1.55]
    left.plot(limit, limit, color=C_GREY, lw=0.8, zorder=0)
    left.errorbar(ref_r, lit_r, yerr=r_err, fmt="o", mfc="none", mec=C_RAW, ms=4.5, ecolor=C_RAW,
                  elinewidth=0.8, capsize=2, lw=0, label="literal reading (± scenario span)")
    left.plot(ref_r, cw_r, "^", color=C_ACCENT, ms=4.5, label="stabilized (window-max) reading")
    left.annotate("Curve00030, 00036: captured\nby a ±1-quantum plateau step (→ 0)",
                  xy=(1.075, 0.005), xytext=(1.26, 0.52), fontsize=6.8, color=C_GREY,
                  arrowprops=dict(arrowstyle="->", color=C_GREY, lw=0.7,
                                  connectionstyle="arc3,rad=-0.25"))
    left.set_xlabel(r"Reference $r$ from Aida & Ying (2025) (h$^{-1}$)")
    left.set_ylabel(r"Replicated $r$ (h$^{-1}$)")
    left.set_title(r"(a) maximum rate: $r$")
    left.set_xlim(1.0, 1.5)
    left.set_ylim(-0.05, 1.6)
    left.legend(frameon=False, loc="lower right")

    k_limit = [0.24, 0.262]
    right.plot(k_limit, k_limit, color=C_GREY, lw=0.8, zorder=0)
    right.plot(ref_k, k_rep, "o", color=C_GREEN, ms=4.5)
    right.set_xlabel("Reference $K$ from Aida & Ying (2025) (OD)")
    right.set_ylabel("Replicated $K$ (OD)")
    right.set_title("(b) carrying capacity: $K$")
    right.set_xlim(*k_limit)
    right.set_ylim(*k_limit)
    right.text(0.245, 0.2575, "mean absolute deviation\n0.77 % (max 2.5 %)", fontsize=7, color=C_GREY)

    fig.tight_layout()
    fig.savefig(FIGURES / "fig3-replication.png")
    plt.close(fig)


def fig4_doubling_times(results, reference):
    by_label = {c["label"]: c for c in results["perCurve"]}
    labels = [c["label"] for c in reference["curves"]]
    td_paper = np.array([np.log(2) / c["r"] * 60 for c in reference["curves"]])
    td_cw = np.array([np.log(2) / by_label[l]["byScenario"]["mid"]["rate"]["rCenteredWindowMax"]["rLn"] * 60 for l in labels])
    td_robust = np.array([np.log(2) / by_label[l]["byScenario"]["mid"]["robust"]["slopePerHour"] * 60 for l in labels])

    fig, ax = plt.subplots(figsize=(6.4, 2.7))
    ax.axvspan(ANCHOR_MIN, ANCHOR_MAX, color="#f2d17c", alpha=0.35, zorder=0)
    ax.axvline(ANCHOR_VALUE, color="#a67c00", lw=1.0, ls="--", zorder=1)
    rows = [
        (3.0, td_paper, C_RAW, "from published $r$"),
        (2.0, td_cw, C_ACCENT, "stabilized max-rate reading"),
        (1.0, td_robust, C_GREEN, "mid-rise average (robust window)"),
    ]
    for y, values, color, label in rows:
        jitter = (np.arange(len(values)) % 3 - 1) * 0.055
        ax.plot(values, y + jitter, "o", color=color, ms=4.5, alpha=0.85)
        mean_value = values.mean()
        ax.plot([mean_value], [y], "D", color=color, ms=6, mec="white", mew=0.7, zorder=5)
        ax.text(mean_value + 1.2, y + 0.26, f"mean {mean_value:.1f} min", fontsize=6.8, color=color)
    ax.text(ANCHOR_VALUE + 1.0, 3.42, "literature anchor: 42 ± 12 min\n(BW25113, supplemented M9,\nsingle cell; BioNumbers 111767)",
            fontsize=7, color="#7a5c00")
    ax.set_yticks([1, 2, 3], ["mid-rise average\n(robust window)", "stabilized max-rate\nreading", "from published $r$"])
    ax.set_xlabel("Doubling time (min)")
    ax.set_title("Figure 4. Doubling-time statistics from the twelve wells vs the literature anchor")
    ax.set_xlim(22, 82)
    ax.set_ylim(0.55, 3.85)
    fig.tight_layout()
    fig.savefig(FIGURES / "fig4-doubling-times.png")
    plt.close(fig)


def main():
    FIGURES.mkdir(exist_ok=True)
    results, reference, series = load()
    fig1_raw_curves(series)
    fig2_worked_example(results, series)
    fig3_replication(results, reference)
    fig4_doubling_times(results, reference)
    print("figures written to", FIGURES)


if __name__ == "__main__":
    main()
