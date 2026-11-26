#!/usr/bin/env Rscript

# Independent base-R cross-check of Ecolab's direct-OD growth comparison.
# Source: Aida & Ying (2025), Scientific Data 12, 984,
# https://doi.org/10.1038/s41597-025-05356-3
# Dataset: Figshare 28342064 v1, CC BY 4.0. The admitted rows are untreated
# BW25113 OD600 values; they are not CFU measurements or antibiotic evidence.
#
# Run from the repository root:
#   Rscript scripts/benchmarks/validate-bw25113-growth-r.R
# An alternate normalized CSV path may be supplied as the first argument.
# The comparator uses base R only and independently refits LOO folds with
# bounded L-BFGS-B, then checks against a fixed-seed Ecolab JS benchmark.

options(digits = 12)

args <- commandArgs(trailingOnly = TRUE)
source_file <- if (length(args)) args[[1]] else {
  "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.csv"
}

sha256_file <- function(path) {
  candidates <- list(
    list(command = "shasum", args = c("-a", "256", path)),
    list(command = "sha256sum", args = path)
  )
  for (candidate in candidates) {
    if (!nzchar(Sys.which(candidate$command))) next
    output <- suppressWarnings(system2(candidate$command, candidate$args, stdout = TRUE, stderr = TRUE))
    status <- attr(output, "status")
    if (is.null(status) || identical(status, 0L)) return(substr(trimws(output[[1]]), 1, 64))
  }
  stop("Cannot verify the source CSV: install shasum or sha256sum.", call. = FALSE)
}

assert_near <- function(actual, expected, tolerance, label) {
  if (length(actual) != length(expected) || any(!is.finite(actual))
      || any(abs(actual - expected) > tolerance)) {
    stop(sprintf("%s mismatch; max absolute difference %.12g exceeds %.12g.",
      label, max(abs(actual - expected)), tolerance), call. = FALSE)
  }
}

data <- read.csv(source_file, stringsAsFactors = FALSE, check.names = FALSE)
expected_csv_sha256 <- "03e137484b717970cd4cc47be88c52224e08cbb0713b7d6b4456b91c63985188"
actual_csv_sha256 <- sha256_file(source_file)
stopifnot(identical(actual_csv_sha256, expected_csv_sha256))
stopifnot(nrow(data) == 528L, all(data$measurementType == "od600"), all(data$censoring == "none"))

training_ids <- sort(unique(data$independentUnitId[data$role == "training"]))
validation_ids <- sort(unique(data$independentUnitId[data$role == "validation"]))
expected_training_ids <- sprintf("Curve%05d|Round01_%04d", 25:32, 25:32)
expected_validation_ids <- sprintf("Curve%05d|Round01_%04d", 33:36, 33:36)
stopifnot(identical(training_ids, expected_training_ids))
stopifnot(identical(validation_ids, expected_validation_ids))
unit_sizes <- table(data$independentUnitId)
stopifnot(length(unit_sizes) == 12L, all(unit_sizes == 44L))
expected_times <- seq(0.5, 22, by = 0.5)
for (id in c(training_ids, validation_ids)) {
  times <- data$timeHours[data$independentUnitId == id]
  stopifnot(identical(times, expected_times))
}

lower <- c(baselineOd = 0, amplitudeOd = 0.001, ratePerHour = 0.001, timingHours = 0)
upper <- c(baselineOd = 0.3, amplitudeOd = 1, ratePerHour = 4, timingHours = 30)
models <- c("training_mean", "logistic", "gompertz")

predict_sigmoid <- function(model, time, parameters) {
  z <- parameters[["ratePerHour"]] * (time - parameters[["timingHours"]])
  fraction <- if (model == "logistic") stats::plogis(z) else exp(-exp(-z))
  parameters[["baselineOd"]] + parameters[["amplitudeOd"]] * fraction
}

fit_mean <- function(frame) {
  means <- aggregate(value ~ timeHours, frame, mean)
  means[order(means$timeHours), ]
}

predict_mean <- function(means, times) {
  indices <- match(times, means$timeHours)
  stopifnot(!anyNA(indices))
  means$value[indices]
}

starts <- expand.grid(
  baseline = c(0.04, 0.09),
  amplitude = c(0.2, 0.45),
  rate = c(0.2, 0.8, 1.8),
  timing = c(3, 8, 14)
)

fit_sigmoid <- function(frame, model) {
  unit_rows <- split(seq_len(nrow(frame)), frame$independentUnitId)
  objective <- function(values) {
    parameters <- setNames(values, names(lower))
    predicted <- predict_sigmoid(model, frame$timeHours, parameters)
    mean(vapply(unit_rows, function(index) mean((frame$value[index] - predicted[index])^2), numeric(1)))
  }
  best <- NULL
  for (index in seq_len(nrow(starts))) {
    initial <- c(starts$baseline[index], starts$amplitude[index], starts$rate[index], starts$timing[index])
    fit <- stats::optim(initial, objective, method = "L-BFGS-B", lower = lower, upper = upper,
      control = list(maxit = 5000, factr = 1e4, pgtol = 1e-12))
    if (is.null(best) || fit$value < best$value) best <- fit
  }
  best
}

fit_model <- function(model, frame) {
  if (identical(model, "training_mean")) fit_mean(frame) else fit_sigmoid(frame, model)
}

predict_model <- function(model, fit, frame) {
  if (identical(model, "training_mean")) {
    predict_mean(fit, frame$timeHours)
  } else {
    predict_sigmoid(model, frame$timeHours, setNames(fit$par, names(lower)))
  }
}

rmse <- function(observed, predicted) sqrt(mean((observed - predicted)^2))
cv_scores_by_unit <- setNames(vector("list", length(models)), models)
for (model in models) {
  fold_scores <- setNames(numeric(length(training_ids)), training_ids)
  for (held_id in training_ids) {
    fold_training <- data[data$role == "training" & data$independentUnitId != held_id, ]
    held <- data[data$role == "training" & data$independentUnitId == held_id, ]
    fitted <- fit_model(model, fold_training)
    fold_scores[[held_id]] <- rmse(held$value, predict_model(model, fitted, held))
  }
  cv_scores_by_unit[[model]] <- fold_scores
}
cv_scores <- vapply(cv_scores_by_unit, mean, numeric(1))
minimum_score <- min(cv_scores)
tied_models <- models[cv_scores <= minimum_score + 1e-10]
selected_model <- tied_models[[1]]

full_training <- data[data$role == "training", ]
full_fit <- fit_model(selected_model, full_training)
validation <- data[data$role == "validation", ]
validation_prediction <- predict_model(selected_model, full_fit, validation)
validation_by_unit <- split(seq_len(nrow(validation)), validation$independentUnitId)
validation_rmse <- vapply(validation_by_unit, function(index) {
  rmse(validation$value[index], validation_prediction[index])
}, numeric(1))
validation_macro_rmse <- mean(validation_rmse)
validation_pooled_rmse <- rmse(validation$value, validation_prediction)

# Fixed-seed JavaScript reference: seed 3817; bounds [0,.3], [.001,1],
# [.001,4], [0,30]; one restart, population 64, DE/NM budgets 1200/1200;
# bootstrap disabled. R's independent optimizer should reproduce the model
# ranking and scores within numerical tolerance.
js_cv_scores <- c(
  training_mean = 0.0038482670745189043,
  logistic = 0.008315412120417871,
  gompertz = 0.010714264512815158
)
js_validation_by_unit <- c(
  "Curve00033|Round01_0033" = 0.0015855123562489746,
  "Curve00034|Round01_0034" = 0.0029861779121022427,
  "Curve00035|Round01_0035" = 0.003731345647472112,
  "Curve00036|Round01_0036" = 0.0038872149851672893
)
assert_near(unname(cv_scores[models]), unname(js_cv_scores[models]), 1e-7, "LOO CV score")
stopifnot(identical(selected_model, "training_mean"))
assert_near(unname(validation_rmse[names(js_validation_by_unit)]),
  unname(js_validation_by_unit), 1e-12, "per-trajectory held-out RMSE")
assert_near(validation_macro_rmse, 0.003047562725247655, 1e-12, "held-out macro RMSE")
assert_near(validation_pooled_rmse, 0.0031805851912959228, 1e-12, "held-out pooled RMSE")

cat("Independent R cross-check passed.\n")
cat("R version: ", as.character(getRversion()), "\n", sep = "")
cat("CSV SHA-256: ", actual_csv_sha256, "\n", sep = "")
cat("Rows: ", nrow(data), "; training trajectories: ", length(training_ids),
  "; held-out trajectories: ", length(validation_ids), "\n", sep = "")
cat("LOO CV macro RMSE:\n")
print(cv_scores)
cat("Selected model: ", selected_model, "\n", sep = "")
cat("Held-out macro RMSE: ", validation_macro_rmse,
  "; pooled RMSE: ", validation_pooled_rmse, "\n", sep = "")
cat("Held-out RMSE by trajectory:\n")
print(validation_rmse)
