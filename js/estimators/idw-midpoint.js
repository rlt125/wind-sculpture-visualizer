// Estimator 1: IDW midpoint (the app's original perspective model).
//
// For each ref: px/ft = diagonal pixel distance between the two clicks
// divided by knownFeet; the sample is filed at the vertical midpoint of
// the two clicks.
//
// Lookup across Y:
//   - inside the calibrated Y-range: Shepard's inverse-distance weighting,
//     p=2 (every ref contributes, weighted by 1/d²).
//   - outside: slope-based extrapolation from the two nearest refs, clamped
//     (2.5× near / 5% far) so a single ref can't blow up placements.
//
// Weaknesses (what motivated the other estimators):
//   - midpoint-Y mis-files depth: the object stands at its base, not its
//     middle.
//   - diagonal pixel distance conflates horizontal click jitter with
//     vertical extent.
//   - no physical model across depth; just smoothing.

import { deriveRef } from "./util.js";

const CLOSE_CAP = 2.5;
const FAR_MIN = 0.05;

function pixelsPerFootAtImpl(y, samples) {
  if (samples.length === 0) return null;
  if (samples.length === 1) return samples[0].ppf;
  const sorted = [...samples].sort((a, b) => a.y - b.y);

  if (y < sorted[0].y) {
    const a = sorted[0], b = sorted[1];
    const slope = (b.ppf - a.ppf) / (b.y - a.y || 1);
    const extrap = a.ppf + (y - a.y) * slope;
    return Math.max(a.ppf * FAR_MIN, Math.min(a.ppf, extrap));
  }
  const last = sorted[sorted.length - 1];
  if (y > last.y) {
    const a = last, b = sorted[sorted.length - 2];
    const slope = (a.ppf - b.ppf) / (a.y - b.y || 1);
    const extrap = a.ppf + (y - a.y) * slope;
    return Math.max(a.ppf, Math.min(a.ppf * CLOSE_CAP, extrap));
  }

  let wSum = 0, vSum = 0;
  for (const s of samples) {
    const d = Math.abs(y - s.y);
    if (d < 0.5) return s.ppf;
    const w = 1 / (d * d);
    wSum += w;
    vSum += w * s.ppf;
  }
  return vSum / wSum;
}

export default {
  id: "idw-midpoint",
  name: "IDW midpoint (original)",
  short: "Shepard's p=2 over midpoint-Y + diagonal ppf",
  build(refs) {
    const derived = refs.map(deriveRef);
    const samples = derived.map((r) => ({ y: r.midY, ppf: r.ppfDiagonal, id: r.id }));
    const fn = (y) => pixelsPerFootAtImpl(y, samples);
    return {
      pixelsPerFootAt: fn,
      diagnostics: {
        model: "idw-midpoint",
        sampleCount: samples.length,
        acceptedIds: samples.map((s) => s.id),
        rejectedIds: [],
        notes: samples.length < 2
          ? ["Need 2+ refs for perspective; using single sample everywhere."]
          : [`${samples.length} refs; IDW p=2 in range, slope-extrapolation outside.`],
      },
    };
  },
};
