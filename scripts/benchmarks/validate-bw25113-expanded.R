#!/usr/bin/env Rscript

# Independent base-R refit of Ecolab's expanded real-data OD600 comparison.
# Input values are untreated raw OD600 from Aida & Ying (2025), Figshare v1.
# They remain OD600, not CFU/mL, and do not test antibiotic response.

options(digits = 12)
args <- commandArgs(trailingOnly = TRUE)
output_dir <- if (length(args)) args[[1]] else "/tmp/ecolab-bw25113-expanded-run"
observations_path <- file.path(output_dir, "observations.csv")
js_scores_path <- file.path(output_dir, "model-scores.csv")

if (!file.exists(observations_path) || !file.exists(js_scores_path)) {
  stop("The JS benchmark must run first and produce observations.csv and model-scores.csv.", call. = FALSE)
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
  stop("Cannot fingerprint the JS benchmark CSVs: install shasum or sha256sum.", call. = FALSE)
}

near <- function(actual, expected, tolerance, label) {
  if (length(actual) != length(expected) || any(!is.finite(actual))
      || any(abs(actual - expected) > tolerance)) {
    stop(sprintf("%s differs by %.12g; tolerance %.12g.",
      label, max(abs(actual - expected)), tolerance), call. = FALSE)
  }
}

data <- read.csv(observations_path, stringsAsFactors = FALSE, check.names = FALSE)
js <- read.csv(js_scores_path, stringsAsFactors = FALSE, check.names = FALSE)
observation_hash <- sha256_file(observations_path)
score_hash <- sha256_file(js_scores_path)
expected_observation_hash <- "6acd89a649223e4db9e7f741761d359f4c1473289b4c1cde322805a1b34f3d10"
expected_score_hash <- "4e4060212f2dd574d5eec07a739f055621206a35020d9309d4d9fb3cf330c947"
if (!identical(observation_hash, expected_observation_hash) || !identical(score_hash, expected_score_hash)) {
  stop("The shared JS benchmark inputs do not match the pinned SHA-256 fingerprints.", call. = FALSE)
}
stopifnot(nrow(data) == 9072L, all(data$measurementType == "od600"),
  all(data$role %in% c("training", "development")),
  all(is.finite(data$value)), all(data$timeHours >= 0), length(unique(data$conditionId)) == 13L,
  all(data$cohortKind %in% c("condition", "large_condition")))
if (nrow(js) != 39L || anyDuplicated(js[c("conditionId", "model")])) {
  stop("The JS score table must contain 39 unique condition/model rows.", call. = FALSE)
}
if (anyDuplicated(data[c("conditionId", "curveLabel", "timeHours")])) {
  stop("Duplicate condition/curve/time observations found.", call. = FALSE)
}

for (condition in unique(data$conditionId)) {
  group <- data[data$conditionId == condition, ]
  is_large <- identical(unique(group$cohortKind), "large_condition")
  expected_curve_count <- if (is_large) 60L else 12L
  expected_training_count <- if (is_large) 48L else 8L
  expected_development_count <- if (is_large) 12L else 4L
  expected_times <- if (is_large) seq(0.5, 18, by = 0.5) else seq(0.5, 24, by = 0.5)
  curve_counts <- table(group$curveLabel)
  role_by_curve <- split(group$role, group$curveLabel)
  if (length(curve_counts) != expected_curve_count || any(curve_counts != length(expected_times))
      || !all(vapply(role_by_curve, function(role) length(unique(role)) == 1L, logical(1)))) {
    stop(sprintf("%s has an incomplete curve or a split role overlap.", condition), call. = FALSE)
  }
  per_curve_times <- split(group$timeHours, group$curveLabel)
  if (!all(vapply(per_curve_times, function(times) identical(sort(times), expected_times), logical(1)))) {
    stop(sprintf("%s does not have the documented exact common time grid.", condition), call. = FALSE)
  }
  if (sum(group$role == "training") != expected_training_count * length(expected_times)
      || sum(group$role == "development") != expected_development_count * length(expected_times)) {
    stop(sprintf("%s has the wrong whole-trajectory split size.", condition), call. = FALSE)
  }
  training_folds <- unique(group$foldId[group$role == "training"])
  expected_fold_count <- if (is_large) 6L else 8L
  if (length(training_folds) != expected_fold_count || anyNA(training_folds)) {
    stop(sprintf("%s has the wrong number of CV folds.", condition), call. = FALSE)
  }
  fold_curve_counts <- vapply(training_folds, function(fold) {
    length(unique(group$curveLabel[group$role == "training" & group$foldId == fold]))
  }, integer(1))
  expected_fold_size <- if (is_large) 8L else 1L
  if (any(fold_curve_counts != expected_fold_size)) {
    stop(sprintf("%s CV folds do not hold out complete balanced curves.", condition), call. = FALSE)
  }
}

predict_curve <- function(model, time, parameter) {
  z <- parameter[["ratePerHour"]] * (time - parameter[["timingHours"]])
  fraction <- if (model == "logistic") stats::plogis(z) else exp(-exp(-z))
  parameter[["baselineOd"]] + parameter[["amplitudeOd"]] * fraction
}

training_mean_predictions <- function(training, held) {
  means <- aggregate(value ~ timeHours, training, mean)
  index <- match(held$timeHours, means$timeHours)
  if (anyNA(index)) stop("Held-out times do not match training-mean support.", call. = FALSE)
  means$value[index]
}

lower <- c(baselineOd = 0, amplitudeOd = 0.001, ratePerHour = 0.001, timingHours = 0)
upper <- c(baselineOd = 0.3, amplitudeOd = 1, ratePerHour = 4, timingHours = 30)
starts <- expand.grid(
  baseline = c(0.04, 0.09),
  amplitude = c(0.2, 0.45),
  rate = c(0.2, 0.8, 1.8),
  timing = c(3, 8, 14)
)

fit_sigmoid <- function(training, model) {
  unit_rows <- split(seq_len(nrow(training)), training$curveLabel)
  objective <- function(values) {
    parameter <- setNames(values, names(lower))
    predicted <- predict_curve(model, training$timeHours, parameter)
    mean(vapply(unit_rows, function(index) mean((training$value[index] - predicted[index])^2), numeric(1)))
  }
  best <- NULL
  for (index in seq_len(nrow(starts))) {
    initial <- c(starts$baseline[index], starts$amplitude[index], starts$rate[index], starts$timing[index])
    fit <- stats::optim(initial, objective, method = "L-BFGS-B", lower = lower, upper = upper,
      control = list(maxit = 5000, factr = 1e4, pgtol = 1e-12))
    if (is.null(best) || fit$value < best$value) best <- fit
  }
  list(parameters = setNames(best$par, names(lower)), objective = best$value)
}

predict_model <- function(model, training, held) {
  if (model == "training_mean") training_mean_predictions(training, held) else {
    fit <- fit_sigmoid(training, model)
    predict_curve(model, held$timeHours, fit$parameters)
  }
}

rmse <- function(observed, predicted) sqrt(mean((observed - predicted)^2))
macro_rmse <- function(observed, predicted) {
  units <- split(seq_len(nrow(observed)), observed$curveLabel)
  mean(vapply(units, function(index) rmse(observed$value[index], predicted[index]), numeric(1)))
}

run_group <- function(group, js_group) {
  training <- group[group$role == "training", ]
  development <- group[group$role == "development", ]
  if (length(unique(training$curveLabel)) < 2L || !nrow(development)) stop("A cohort has an invalid train/development split.", call. = FALSE)
  fold_ids <- sort(unique(training$foldId))
  if (length(fold_ids) < 2L || anyNA(fold_ids)) stop("A cohort is missing complete-trajectory folds.", call. = FALSE)
  models <- c("training_mean", "logistic", "gompertz")
  cv <- setNames(numeric(length(models)), models)
  for (model in models) {
    curve_scores <- setNames(numeric(length(unique(training$curveLabel))), sort(unique(training$curveLabel)))
    for (fold in fold_ids) {
      held_labels <- unique(training$curveLabel[training$foldId == fold])
      fold_training <- training[!training$curveLabel %in% held_labels, ]
      fold_held <- training[training$curveLabel %in% held_labels, ]
      prediction <- predict_model(model, fold_training, fold_held)
      for (label in held_labels) {
        selected <- fold_held$curveLabel == label
        curve_scores[[label]] <- rmse(fold_held$value[selected], prediction[selected])
      }
    }
    cv[[model]] <- mean(curve_scores)
  }
  minimum <- min(cv)
  tied <- models[cv <= minimum + 1e-10]
  selected <- tied[[1]]
  js_rows <- js_group[match(models, js_group$model), ]
  if (anyNA(js_rows$model)) stop("JS score rows do not contain all three candidates.", call. = FALSE)
  maximum_cv_difference <- max(abs(unname(cv) - js_rows$cvMacroRmse))
  near(unname(cv), js_rows$cvMacroRmse, 1e-6, paste(unique(group$conditionId), "CV scores"))
  if (!identical(selected, js_rows$selectedModel[[1]])) stop("R and JS selected different candidates.", call. = FALSE)

  development_prediction <- if (selected == "training_mean") training_mean_predictions(training, development) else {
    fit <- fit_sigmoid(training, selected)
    predict_curve(selected, development$timeHours, fit$parameters)
  }
  development_macro <- macro_rmse(development, development_prediction)
  development_pooled <- rmse(development$value, development_prediction)
  near(development_macro, js_rows$selectedHeldoutMacroRmse[[1]], 1e-10, "held-out macro RMSE")
  near(development_pooled, js_rows$selectedHeldoutPooledRmse[[1]], 1e-10, "held-out pooled RMSE")

  data.frame(
    conditionId = unique(group$conditionId),
    model = models,
    cvMacroRmse = unname(cv),
    selectedModel = selected,
    maximumCvAbsoluteDifference = maximum_cv_difference,
    heldoutMacroRmse = development_macro,
    heldoutPooledRmse = development_pooled,
    rVersion = as.character(getRversion()),
    stringsAsFactors = FALSE
  )
}

groups <- split(data, data$conditionId)
r_scores <- do.call(rbind, lapply(groups, function(group) {
  run_group(group, js[js$conditionId == unique(group$conditionId), ])
}))
write.csv(r_scores, file.path(output_dir, "r-model-scores.csv"), row.names = FALSE, na = "")
cat("Independent R cross-check passed.\n")
cat("R version: ", as.character(getRversion()), "\n", sep = "")
cat("Source dataset DOI: 10.6084/m9.figshare.28342064.v1\n")
cat("Observation CSV SHA-256: ", observation_hash, "\n", sep = "")
cat("JS score CSV SHA-256: ", score_hash, "\n", sep = "")
cat("Cohorts: ", length(groups), "; observations: ", nrow(data), "; fitted candidates: ", nrow(r_scores), "\n", sep = "")
cat("All selected models training_mean: ", all(tapply(r_scores$selectedModel, r_scores$conditionId, function(x) all(x == "training_mean"))), "\n", sep = "")
cat("Maximum absolute JS/R CV score difference: ", max(r_scores$maximumCvAbsoluteDifference), " OD600\n", sep = "")
cat("Mean selected held-out macro RMSE: ", mean(tapply(r_scores$heldoutMacroRmse, r_scores$conditionId, function(x) x[[1]])), " OD600\n", sep = "")
cat("R results: ", file.path(output_dir, "r-model-scores.csv"), "\n", sep = "")
