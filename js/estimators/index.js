// Estimator registry.
//
// Each estimator exposes a `build(refs, ctx)` function that returns:
//   { pixelsPerFootAt(y: number) -> number|null, diagnostics: object }
//
// `refs` are the raw stored refs on the stage: { id, p1, p2, knownFeet }.
// `ctx` carries scene metadata (`imageHeight`) that some models use.
//
// Uniform calibration (a single scalar px-per-foot for the whole photo)
// doesn't go through an estimator — it's the same for every Y.

import idwMidpoint from "./idw-midpoint.js";
import horizonBasic from "./horizon-basic.js";
import horizonRobust from "./horizon-robust.js";
import reciprocalFit from "./reciprocal-fit.js";

export const ESTIMATORS = [idwMidpoint, horizonBasic, horizonRobust, reciprocalFit];

const byId = new Map(ESTIMATORS.map((e) => [e.id, e]));

export function getEstimator(id) {
  return byId.get(id) || ESTIMATORS[0];
}

export const DEFAULT_ESTIMATOR_ID = reciprocalFit.id;
