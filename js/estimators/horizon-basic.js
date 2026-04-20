// Estimator 2: Horizon basic.
//
// The minimal version of the horizon-line idea. Uses base-Y as the depth
// anchor (not midpoint-Y) and vertical pixel height (not diagonal).
//
// Pinhole-camera model, level camera on a flat ground plane. For any object
// of real height H standing on the ground at image-Y y_b:
//     h_px = C · H / (y_b − h_horizon)
// so the px-per-foot at that base is:
//     ppf(y) = C / (y − h_horizon)
//
// C should be the same constant across all references (it's a property of
// the camera + scene, not of any one object). We:
//   1. Search horizonY to minimize MAD of the per-ref C values.
//   2. Take the median C at the best horizonY as the scene constant.
//   3. Expose `ppf(y) = C / (y − h)` as pixelsPerFootAt.
//
// Keeps things deliberately lean: no outlier rejection, no confidence score,
// no hybrid fallback. Fewer knobs than horizon-robust; meant to isolate the
// effect of the model change from everything else.

import { deriveRef, median, mad } from "./util.js";

function searchHorizon(refs, imageHeight) {
  const minH = -0.5 * imageHeight;
  const maxH = Math.min(...refs.map((r) => r.baseY)) - 2;
  if (maxH <= minH) return null;

  const score = (h) => {
    const Cs = [];
    for (const r of refs) {
      const d = r.baseY - h;
      if (d <= 1) return Number.POSITIVE_INFINITY;
      Cs.push(r.ppfVertical * d);
    }
    return mad(Cs);
  };

  let bestH = minH, bestS = Number.POSITIVE_INFINITY;
  for (let h = minH; h <= maxH; h += 4) {
    const s = score(h);
    if (s < bestS) { bestS = s; bestH = h; }
  }
  for (let h = bestH - 8; h <= bestH + 8; h += 0.5) {
    const s = score(h);
    if (s < bestS) { bestS = s; bestH = h; }
  }
  return { h: bestH, spread: bestS };
}

export default {
  id: "horizon-basic",
  name: "Horizon basic",
  short: "ppf(y) = C / (y − h), base-Y anchored, vertical ppf, median C",
  build(refs, ctx) {
    const derived = refs.map(deriveRef);
    const imageHeight = ctx?.imageHeight || 1080;

    if (derived.length < 2) {
      const r = derived[0];
      const fn = r ? () => r.ppfVertical : () => null;
      return {
        pixelsPerFootAt: fn,
        diagnostics: {
          model: "horizon-basic",
          horizonY: null,
          sceneConstant: r ? r.ppfVertical * 100 : null,
          acceptedIds: r ? [r.id] : [],
          rejectedIds: [],
          notes: ["Need 2+ refs for horizon fit; returning a constant ppf."],
        },
      };
    }

    const fit = searchHorizon(derived, imageHeight);
    if (!fit) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "horizon-basic", notes: ["Horizon search failed."] },
      };
    }

    const Cs = derived.map((r) => r.ppfVertical * (r.baseY - fit.h));
    const C = median(Cs);

    const pixelsPerFootAt = (y) => {
      const d = y - fit.h;
      if (d <= 1) return C / 1;
      return C / d;
    };

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "horizon-basic",
        horizonY: fit.h,
        sceneConstant: C,
        fitSpread: fit.spread,
        acceptedIds: derived.map((r) => r.id),
        rejectedIds: [],
        notes: [
          `Fitted horizon y=${fit.h.toFixed(1)}, C=${C.toFixed(1)}`,
          `Per-ref C spread (MAD): ${fit.spread.toFixed(2)}`,
        ],
      },
    };
  },
};
