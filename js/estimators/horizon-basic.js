// Estimator 2: Horizon basic.
//
// Minimal pinhole-camera / horizon-line model. Uses base-Y as the depth
// anchor (not midpoint-Y) and vertical pixel height (not diagonal).
//
// Derivation: camera at height H_cam above flat ground, looking level.
// A ground point at world distance D projects to image-Y such that
// (y − h_horizon) = f · H_cam / D, so D = f·H_cam / (y − h).
// An object of real height H at that point has pixel height
//   h_px = f · H / D = H · (y − h) / H_cam
// and therefore
//   ppf(y) = h_px / H = (y − h) / H_cam  ≡  K · (y − h)
// with K = 1/H_cam constant across the scene.
//
// Per-reference:
//   ppf_i = |base.y − top.y| / knownFeet_i
//   K_i   = ppf_i / (base.y_i − h)           ← constant across refs for a good h
//
// Fit:
//   grid-search h to minimize MAD(K_i); take K = median(K_i at best h).
//
// This is deliberately spare: no outlier rejection, no confidence score,
// no hybrid fallback — just the model switch. It isolates the effect of
// using (base-Y, vertical span, linear model) from the other refinements.

import { deriveRef, median, mad } from "./util.js";

function searchHorizon(refs, imageHeight) {
  const minH = -0.5 * imageHeight;
  const maxH = Math.min(...refs.map((r) => r.baseY)) - 2;
  if (maxH <= minH) return null;

  const score = (h) => {
    const Ks = [];
    for (const r of refs) {
      const d = r.baseY - h;
      if (d <= 1) return Number.POSITIVE_INFINITY;
      Ks.push(r.ppfVertical / d);
    }
    // Scale-invariant spread: MAD relative to the median (K varies in
    // magnitude across typical photos, so raw MAD would prefer whichever
    // h makes K small).
    const m = median(Ks);
    return m > 0 ? mad(Ks) / m : Number.POSITIVE_INFINITY;
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
  return { h: bestH, relSpread: bestS };
}

export default {
  id: "horizon-basic",
  name: "Horizon basic",
  short: "ppf(y) = K · (y − h), base-Y anchored, vertical ppf, median K",
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
          sceneConstant: null,
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

    const Ks = derived.map((r) => r.ppfVertical / (r.baseY - fit.h));
    const K = median(Ks);

    const pixelsPerFootAt = (y) => {
      const d = y - fit.h;
      // Above or at the horizon: clamp to a small positive so rendering
      // doesn't invert. Scenes don't place sculptures above the horizon.
      if (d <= 1) return Math.max(0.1, K);
      return K * d;
    };

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "horizon-basic",
        horizonY: fit.h,
        sceneConstant: K,
        fitSpread: fit.relSpread,
        acceptedIds: derived.map((r) => r.id),
        rejectedIds: [],
        notes: [
          `Fitted horizon y=${fit.h.toFixed(1)}, K=${K.toFixed(4)} (= 1/H_cam)`,
          `Relative spread of K (MAD/median): ${fit.relSpread.toFixed(3)}`,
        ],
      },
    };
  },
};
