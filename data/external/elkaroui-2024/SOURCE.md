# External source: El Karoui lab checkerboard assay (2024)

- **Dataset:** "Cell growth dataset for 'Suppression of bacterial cell death underlies the antagonistic interaction between ciprofloxacin and tetracycline in Escherichia coli'"
- **Authors:** James Broughton, Louise Goossens, Achille Fraisse, Meriem El Karoui (University of Edinburgh)
- **DOI:** https://doi.org/10.5281/zenodo.15311905 (preprint: https://doi.org/10.1101/2024.04.18.590101)
- **License:** CC0 1.0 (public domain dedication)
- **File used:** `Fig-S1-Growth_rates-Checkerboard_assay.zip` → `growth-OD600-Blank_correct.xlsx`
- **Extraction:** the five wells labelled `Positive control P` (E12, F12, G12, H11, H12) are the untreated growth controls of the checkerboard plate. Their blank-corrected OD600 values were copied unchanged, one row per well and time point, into `positive-controls.csv` (1130 rows; 226 time points from 0 to 27.82 h at 7-min intervals).
- **What was not changed:** no smoothing, no outlier replacement, no blank correction beyond the source's own blank subtraction, no OD→CFU conversion. Negative early values are retained as supplied.
- **Scope:** these are five wells from a single 96-well plate, not five independent biological replicates. They measure well-to-well variability of one plate and one inoculum, so they are an external *technical* check, not an independent biological validation.
- **Conditions:** E. coli SJR206 (K-12 MG1655 background), M9-based fast-growth medium (glucose + amino acids), 37 °C, 96-well plate, readings every 7 min for 27.8 h, untreated.
