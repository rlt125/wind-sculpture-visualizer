// Estimator registry.
//
// Currently exports a single depth-aware px-per-foot model. Structure is
// kept so another model can be slotted in without touching composite.js.
//
// An estimator exposes `build(refs, ctx)` returning:
//   { pixelsPerFootAt(y: number) -> number|null, diagnostics: object }
//
// `refs` are raw stored refs: { id, p1, p2, knownFeet }.
// `ctx` carries scene metadata: { imageHeight, rejectOutliers }.

import horizonLinear from "./horizon-linear.js";

export const ESTIMATORS = [horizonLinear];

const byId = new Map(ESTIMATORS.map((e) => [e.id, e]));

export function getEstimator(id) {
  return byId.get(id) || ESTIMATORS[0];
}

export const DEFAULT_ESTIMATOR_ID = horizonLinear.id;
