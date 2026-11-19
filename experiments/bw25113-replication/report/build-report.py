#!/usr/bin/env python3
"""Build the IA format report PDF (stage based; the browser is launched by the caller).

Stages (run in order; the two headless Chrome print commands that run in between are
documented in the experiment README, section "Rebuilding the report"):

  --fill    fill the template into report.html: tables, figure captures, word count;
            table of contents numbers preset to 0.
  --toc     read report/draft.pdf, map every heading to its page, patch the contents.
  --stamp   verify report/bw25113-replication-report.pdf against the draft page map and
            stamp page numbers: title page unnumbered, contents in roman numerals,
            body in arabic numerals.

This script never launches external processes; it only reads and writes files with
PyMuPDF and the standard library.
"""

from __future__ import annotations

import html as html_module
import json
import math
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
EXP = HERE.parent
TEMPLATE = HERE / "report.source.html"
FILLED = HERE / "report.html"
DRAFT = HERE / "draft.pdf"
FINAL = HERE / "bw25113-replication-report.pdf"

# (level, display text, search fragment, anchor id)
# Search fragments are matched case-sensitively against whitespace-normalized page text
# and carry the section number, so ordinary prose can never be mistaken for a heading.
TOC_SPEC = [
    (2, "1 Introduction", "1 Introduction", "s1"),
    (2, "2 Background Information", "2 Background Information", "s2"),
    (3, "2.1 Growth rate and doubling time in batch culture", "2.1 Growth rate and doubling time in batch culture", "s2-1"),
    (3, "2.2 Why OD600 data need a background treatment", "2.2 Why OD", "s2-2"),
    (3, "2.3 The dataset and its published parameters", "2.3 The dataset and its published parameters", "s2-3"),
    (3, "2.4 The literature value for BW25113", "2.4 The literature value for BW25113", "s2-4"),
    (2, "3 Methodology", "3 Methodology", "s3"),
    (3, "3.1 Data and variables", "3.1 Data and variables", "s3-1"),
    (3, "3.2 Software, data integrity and reproducibility", "3.2 Software, data integrity and reproducibility", "s3-2"),
    (3, "3.3 The published definitions", "3.3 The published definitions", "s3-3"),
    (3, "3.4 Background scenarios", "3.4 Background scenarios", "s3-4"),
    (3, "3.5 Companion estimate and uncertainty analysis", "3.5 Companion estimate", "s3-5"),
    (2, "4 Data Analysis", "4 Data Analysis", "s4"),
    (3, "4.1 Raw data", "4.1 Raw data", "s4-1"),
    (3, "4.2 The 0.001 OD staircase", "4.2 The 0.001 OD staircase", "s4-2"),
    (3, "4.3 The carrying capacity K replicates", "4.3 The carrying capacity", "s4-3"),
    (3, "4.4 The maximum rate r does not replicate under the literal reading", "4.4 The maximum rate", "s4-4"),
    (3, "4.5 Which logarithm did the authors use?", "4.5 Which logarithm", "s4-5"),
    (3, "4.6 The resolved middle of the rise", "4.6 The resolved middle", "s4-6"),
    (3, "4.7 Validation wells and internal consistency", "4.7 Validation wells", "s4-7"),
    (2, "5 Discussion", "5 Discussion", "s5"),
    (3, "5.1 What replicated, and why", "5.1 What replicated", "s5-1"),
    (3, "5.2 What do the curves actually support?", "5.2 What do the curves", "s5-2"),
    (3, "5.3 Comparison with the literature value", "5.3 Comparison with the literature value", "s5-3"),
    (3, "5.4 Implications for data reuse", "5.4 Implications for data reuse", "s5-4"),
    (2, "6 Evaluation", "6 Evaluation", "s6"),
    (3, "6.1 Strengths", "6.1 Strengths", "s6-1"),
    (3, "6.2 Limitations and improvements", "6.2 Limitations and improvements", "s6-2"),
    (3, "6.3 Extensions", "6.3 Extensions", "s6-3"),
    (2, "7 Conclusion", "7 Conclusion", "s7"),
    (2, "References", "References", "refs-h"),
]

FIGURE_CAPTIONS = {
    "fig1": ("Figure 1", "../figures/fig1-raw-curves.png",
             "Raw OD600 readings of the twelve Cond00003 wells (BW25113, 37 &deg;C, untreated; 528 observations). "
             "The shaded band marks the plateau used for the baseline scenarios. All wells follow the same pattern: "
             "a flat background level, a rise from about 6 h, a peak near 13.5 h and a slow decline."),
    "fig2": ("Figure 2", "../figures/fig2-worked-example.png",
             "Worked example (Curve00032). (a) Raw readings with the three background scenarios and an inset showing the "
             "0.001 OD rounding staircase. (b) Net signal on a logarithmic scale with the analysis window (0.02&ndash;0.12 OD, shaded) "
             "and a cross marking the literal maximum pair slope under each scenario; the maximum moves from inside the early staircase "
             "(high scenario) into the genuine rise (mid and low scenarios)."),
    "fig3": ("Figure 3", "../figures/fig3-replication.png",
             "Replication of the published parameters against the authors' own values (grey 1:1 lines). (a) The maximum rate r: "
             "open circles show the literal reading with error bars spanning the three background scenarios, filled triangles the "
             "stabilized reading; two wells collapse to zero under the literal reading. (b) The carrying capacity K: mean absolute "
             "relative deviation 0.77 % (maximum 2.5 %)."),
    "fig4": ("Figure 4", "../figures/fig4-doubling-times.png",
             "Doubling times implied by each statistic (dots, one per well; diamonds, means) against the literature anchor band of "
             "42 &plusmn; 12 min (shaded; BioNumbers 111767, single cell in supplemented M9). The transient statistics fall at or inside "
             "the lower edge of the band; the sustained average through the middle of the rise is clearly slower."),
}

ROMAN = ["", "i", "ii", "iii", "iv", "v"]


def load():
    results = json.load(open(EXP / "derived/results.json", encoding="utf-8"))
    reference = json.load(open(EXP / "derived/reference-values.json", encoding="utf-8"))
    background = json.load(open(EXP / "derived/background-evidence.json", encoding="utf-8"))
    return results, reference, background


def doubling_minutes(rate):
    return math.log(2) / rate * 60


def build_tables(results, reference, background):
    by_label = {c["label"]: c for c in results["perCurve"]}

    table1 = """<table>
<caption>Table 1: Independent, dependent and controlled variables of this investigation</caption>
<tr><th>Type</th><th>Variable</th><th>Specification and method of control</th></tr>
<tr><td>Independent</td><td>Time within each well (0.5&ndash;22.0 h, 30 min intervals)</td><td>Fixed sampling grid of the plate reader; in this archival reanalysis the biological condition is fixed and time is the only independent axis.</td></tr>
<tr><td>Dependent</td><td>OD<sub>600</sub> reading (raw, rounded to 0.001 OD); derived quantities &mu;<sub>j</sub>, <i>r</i>, <i>K</i>, doubling time</td><td>Read directly from the released workbook; no smoothing or interpolation applied.</td></tr>
<tr><td>Controlled (experiment)</td><td>Organism; medium; temperature and plate format</td><td>All wells: <i>E. coli</i> BW25113 from one stock; medium Cond00003 (44 compounds, Table&nbsp;2); 37 &deg;C; 96 well plate; 200 &micro;L; 567 rpm; 1:1000 inoculation; Epoch2 reader.</td></tr>
<tr><td>Controlled (analysis)</td><td>Background scenarios; logarithmic base; fitting window; resampling seed</td><td>Three preset backgrounds (Section&nbsp;3.4); natural logarithm; window 0.02&ndash;0.12 OD net signal; seeded bootstrap (fixed seed string).</td></tr>
</table>"""

    comp = {key.replace(" (mM)", ""): value for key, value in background["cond00003Composition"].items()}

    def value(name):
        return str(comp.get(name, "?"))

    table2 = f"""<table>
<caption>Table 2: Cond00003 chemically defined medium (condensed; all 44 components in the source release)</caption>
<tr><th>Group</th><th>Components</th><th>Concentration</th></tr>
<tr><td>Carbon source</td><td>Glucose</td><td>{value('Glucose')} mM</td></tr>
<tr><td>Phosphate buffer</td><td>K<sub>2</sub>HPO<sub>4</sub>, KH<sub>2</sub>PO<sub>4</sub>, Na<sub>2</sub>HPO<sub>4</sub></td><td>{value('K2HPO4')} + {value('KH2PO4')} + {value('Na2HPO4')} mM (125.8 mM total)</td></tr>
<tr><td>Nitrogen sources</td><td>(NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>, NH<sub>4</sub>Cl</td><td>{value('(NH4)2SO4')} + {value('NH4Cl')} mM</td></tr>
<tr><td>Amino acids (20)</td><td>Alanine, glycine, serine, &hellip; (twenty compounds)</td><td>0.02 mM each; tyrosine 0.01 mM</td></tr>
<tr><td>Bulk salts</td><td>KCl, NaCl, MgSO<sub>4</sub>&middot;7H<sub>2</sub>O, MgCl<sub>2</sub>&middot;6H<sub>2</sub>O, CaCl<sub>2</sub>&middot;2H<sub>2</sub>O, CaSO<sub>4</sub>&middot;2H<sub>2</sub>O, citrate, Na<sub>2</sub>S<sub>2</sub>O<sub>3</sub>&middot;5H<sub>2</sub>O</td><td>0.005&ndash;0.5 mM</td></tr>
<tr><td>Trace elements and vitamins</td><td>Fe, Cu, Mo, Zn (spelled &ldquo;ZuSO<sub>4</sub>&rdquo; in the source workbook), B; thiamine, pyridoxine, folic acid, riboflavin, aminobenzoic acid</td><td>10<sup>&minus;5</sup>&ndash;0.008 mM</td></tr>
</table>"""

    rows = []
    for curve in results["perCurve"]:
        label = curve["label"]
        mid = curve["byScenario"]["mid"]
        entry = by_label[label]["reference"]
        r_lit = mid["rate"]["rLn"]
        r_stab = mid["rate"]["rCenteredWindowMax"]["rLn"]
        k_rep = mid["carryingCapacity"]["k"]
        deviation = abs((r_stab - entry["r"]) / entry["r"]) * 100
        muted = "" if curve["role"] == "training" else " (v)"
        r_lit_display = 0.0 if abs(r_lit) < 0.0005 else r_lit
        rows.append(
            f"<tr><td>{label}{muted}</td>"
            f"<td class='num'>{r_lit_display:.3f}</td><td class='num'>{r_stab:.3f}</td><td class='num'>{entry['r']:.3f}</td>"
            f"<td class='num'>{deviation:.1f}</td>"
            f"<td class='num'>{k_rep:.4f}</td><td class='num'>{entry['k']:.4f}</td>"
            f"<td class='num'>{doubling_minutes(entry['r']):.1f}</td>"
            f"<td class='num'>{doubling_minutes(r_stab):.1f}</td>"
            f"<td class='num'>{doubling_minutes(mid['robust']['slopePerHour']):.1f}</td></tr>"
        )
    table3 = ("<table><caption>Table 3: Per well results (mid background scenario; wells marked (v) are the validation units of the release). "
              "Columns: literal and stabilized maximum rate, published rate, relative deviation of the stabilized value, replicated and published K, "
              "and doubling times implied by the published rate, the stabilized rate and the middle of the rise.</caption>"
              "<tr><th>Well</th><th class='num'>r lit. (h&#8315;&sup1;)</th><th class='num'>r stab. (h&#8315;&sup1;)</th><th class='num'>r publ. (h&#8315;&sup1;)</th>"
              "<th class='num'>dev. (%)</th><th class='num'>K repl. (OD)</th><th class='num'>K publ. (OD)</th>"
              "<th class='num'>Td publ. (min)</th><th class='num'>Td stab. (min)</th><th class='num'>Td mid rise (min)</th></tr>"
              + "\n".join(rows) + "</table>")

    td_pub = [doubling_minutes(c["r"]) for c in reference["curves"]]
    td_stab = [doubling_minutes(by_label[c["label"]]["byScenario"]["mid"]["rate"]["rCenteredWindowMax"]["rLn"]) for c in reference["curves"]]
    td_rob = [doubling_minutes(by_label[c["label"]]["byScenario"]["mid"]["robust"]["slopePerHour"]) for c in reference["curves"]]

    def mean(xs):
        return sum(xs) / len(xs)

    def sd(xs):
        m = mean(xs)
        return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))

    ci = results["bootstrap"]["tdRobustMidMinutes"]["ci95"]
    table4 = f"""<table>
<caption>Table 4: Doubling times implied by each statistic, against the literature anchor (all values in minutes)</caption>
<tr><th>Statistic</th><th class="num">Mean</th><th class="num">Spread</th><th class="num">Range or 95 % CI</th></tr>
<tr><td>Published r (as deposited)</td><td class="num">{mean(td_pub):.1f}</td><td class="num">SD {sd(td_pub):.1f}</td><td class="num">{min(td_pub):.1f}&ndash;{max(td_pub):.1f}</td></tr>
<tr><td>Stabilized transient reading (Equation 3)</td><td class="num">{mean(td_stab):.1f}</td><td class="num">SD {sd(td_stab):.1f}</td><td class="num">{min(td_stab):.1f}&ndash;{max(td_stab):.1f}</td></tr>
<tr><td>Average through the middle of the rise</td><td class="num">{mean(td_rob):.1f}</td><td class="num">SD {sd(td_rob):.1f}</td><td class="num">CI {ci[0]:.1f}&ndash;{ci[1]:.1f}</td></tr>
<tr><td>Literature anchor (supplemented M9, single cell)</td><td class="num">42</td><td class="num">&plusmn; 12 (approximate)</td><td class="num">30&ndash;54 band</td></tr>
</table>"""

    return {"table1": table1, "table2": table2, "table3": table3, "table4": table4}


def build_toc():
    lines = []
    for level, display, _search, anchor in TOC_SPEC:
        css = "entry sub" if level == 3 else "entry"
        lines.append(f'<div class="{css}"><span>{display}</span><span class="dots"></span><span id="pg-{anchor}">0</span></div>')
    return "\n".join(lines)


def count_words(html: str) -> int:
    body = html.split('<div class="refs"')[0]
    body = re.sub(r"<style>.*?</style>", " ", body, flags=re.S)
    words = 0
    for match in re.finditer(r"<p([^>]*)>(.*?)</p>", body, flags=re.S):
        attributes, text = match.groups()
        if 'class="note"' in attributes:
            continue
        text = html_module.unescape(re.sub(r"<[^>]+>", " ", text))
        words += len([w for w in re.split(r"\s+", text) if w.strip(" .,;:()")])
    rq = re.search(r'<div class="rq">(.*?)</div>', html, flags=re.S)
    if rq:
        text = html_module.unescape(re.sub(r"<[^>]+>", " ", rq.group(1)))
        words += len([w for w in re.split(r"\s+", text) if w.strip(" .,;:()")])
    return words


def normalized_page_text(document, index):
    text = document[index].get_text().replace("\xa0", " ")
    return re.sub(r"\s+", " ", text)


def find_heading_pages(pdf_path: Path):
    document = fitz.open(pdf_path)
    page_texts = [normalized_page_text(document, index) for index in range(document.page_count)]
    contents_pages = [index for index, text in enumerate(page_texts) if "Contents" in text]
    body_start = max(contents_pages) + 1 if contents_pages else 1
    pages = {}
    for _level, _display, search, anchor in TOC_SPEC:
        for index in range(body_start, document.page_count):
            if search in page_texts[index]:
                pages[anchor] = index
                break
        else:
            raise SystemExit(f"heading not found in PDF: {search}")
    total = document.page_count
    document.close()
    return body_start, total, pages


def stage_fill():
    results, reference, background = load()
    html = TEMPLATE.read_text(encoding="utf-8")
    replacements = build_tables(results, reference, background)
    replacements["toc"] = build_toc()
    replacements["wordcount"] = str(count_words(html))
    for key, value in FIGURE_CAPTIONS.items():
        label, src, caption = value
        replacements[key] = f'<figure><img src="{src}" alt="{label}"><figcaption><b>{label}:</b> {caption}</figcaption></figure>'
    for key, value in replacements.items():
        html = html.replace("{{" + key + "}}", value)
    if "{{" in html:
        raise SystemExit("unfilled placeholder remains in report source")
    FILLED.write_text(html, encoding="utf-8")
    print(f"filled {FILLED.name}: word count {replacements['wordcount']}")


def stage_toc():
    body_start, total, pages = find_heading_pages(DRAFT)
    print(f"draft pages: {total}, body starts at page index {body_start} (1 based {body_start + 1})")
    html = FILLED.read_text(encoding="utf-8")
    for anchor, page_index in pages.items():
        html = html.replace(f'id="pg-{anchor}">0<', f'id="pg-{anchor}">{page_index - body_start + 1}<')
    FILLED.write_text(html, encoding="utf-8")
    print(f"patched {len(pages)} contents entries in {FILLED.name}")


def stage_stamp():
    body_start, total, draft_pages = find_heading_pages(DRAFT)
    body_start_final, final_total, final_pages = find_heading_pages(FINAL)
    if final_pages != draft_pages or final_total != total:
        raise SystemExit("page numbers moved between draft and final render")
    document = fitz.open(FINAL)
    for index in range(document.page_count):
        if index == 0:
            continue
        if index < body_start:
            label = ROMAN[index]
        else:
            label = str(index - body_start + 1)
        page = document[index]
        width = fitz.get_text_length(label, fontname="tiro", fontsize=9)
        page.insert_text(((page.rect.width - width) / 2, page.rect.height - 34),
                         label, fontname="tiro", fontsize=9, color=(0.25, 0.25, 0.25))
    stamped = FINAL.with_suffix(".stamped.pdf")
    document.save(stamped)
    document.close()
    stamped.replace(FINAL)
    print(f"stamped {FINAL.name}: {total} pages, contents roman, body arabic")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("--fill", "--toc", "--stamp"):
        raise SystemExit("usage: build-report.py --fill | --toc | --stamp")
    if sys.argv[1] == "--fill":
        stage_fill()
    elif sys.argv[1] == "--toc":
        stage_toc()
    else:
        stage_stamp()


if __name__ == "__main__":
    main()
