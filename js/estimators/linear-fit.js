// Estimator 4: Linear fit.
//
// (Named "reciprocal-fit" in an earlier revision, after the pasted
//  pseudocode. The pseudocode used `ppf = A / (y − h)`, which inverts the
//  pinhole-camera relationship and shrinks sculptures as they approach the
//  viewer. The correct linear form is used here.)
//
// Model:
//   ppf(y) = K · (y − h)        # K = 1/H_camera, constant across scene
// Per-reference:
//   ppf_i = |base.y − top.y| / knownFeet_i
//   K_i   = ppf_i / (base.y_i − h)
//
// Fit:
//   grid-search h to minimize relative MAD of K_i; coarse 2-px step then
//   refine at 0.25 px. Final K = median of accepted K_i after MAD outlier
//   rejection.
//
// Differs from horizon-robust in style, not substance:
//   - Flat median of accepted K_i (no weighting).
//   - No confidence score / plausible range (just fitError).
//   - Falls back to the idw-midpoint estimator for y at or above the
//     fitted horizon, where the linear formula drops to zero or negative.

import { deriveRef, median, mad } from "./util.js";
import idwMidpoint from "./idw-midpoint.js";

const OUTLIER_MAD_MULT = 2.5;

function fitLinearModel(derived, imageHeight) {
  if (derived.length < 2) return null;

  const data = derived.map((r) => ({ ref: r, ppf: r.ppfVertical, baseY: r.baseY }));
  const minH = -0.5 * imageHeight;
  const maxH = Math.min(...data.map((d) => d.baseY)) - 2;
  if (maxH <= minH) return null;

  const scoreAt = (h) => {
    const set = [];
    for (const d of data) {
      const denom = d.baseY - h;
      if (denom <= 1) return null;
      set.push({ ref: d.ref, value: d.ppf / denom });
    }
    if (set.length < 2) return null;
    const m = median(set.map((v) => v.value));
    return {
      rel: m > 0 ? mad(set.map((v) => v.value)) / m : Number.POSITIVE_INFINITY,
      set,
    };
  };

  let bestH = null, bestScore = Number.POSITIVE_INFINITY, bestSet = null;
  for (let h = minH; h <= maxH; h += 2) {
    const s = scoreAt(h);
    if (!s) continue;
    if (s.rel < bestScore) { bestScore = s.rel; bestH = h; bestSet = s.set; }
  }
  if (bestH == null) return null;
  for (let h = bestH - 4; h <= bestH + 4; h += 0.25) {
    const s = scoreAt(h);
    if (!s) continue;
    if (s.rel < bestScore) { bestScore = s.rel; bestH = h; bestSet = s.set; }
  }

  const medianK = median(bestSet.map((v) => v.value));
  const madK = Math.max(1e-9, median(bestSet.map((v) => Math.abs(v.value - medianK))));
  const accepted = bestSet.filter((v) => Math.abs(v.value - medianK) <= OUTLIER_MAD_MULT * madK);
  const rejected = bestSet.filter((v) => Math.abs(v.value - medianK) > OUTLIER_MAD_MULT * madK);
  const K = accepted.length ? median(accepted.map((v) => v.value)) : medianK;

  return {
    h: bestH,
    K,
    acceptedIds: accepted.map((v) => v.ref.id),
    rejectedIds: rejected.map((v) => v.ref.id),
    fitError: madK,
  };
}

export default {
  id: "linear-fit",
  name: "Linear fit (recommended)",
  short: "ppf(y) = K · (y − h), base-Y + vertical ppf, MAD-rejected, IDW fallback at horizon",
  build(refs, ctx) {
    const derived = refs.map(deriveRef);
    const imageHeight = ctx?.imageHeight || 1080;

    if (derived.length === 0) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "linear-fit", notes: ["No refs."] },
      };
    }

    const fallback = idwMidpoint.build(refs);

    if (derived.length < 2) {
      return {
        pixelsPerFootAt: (y) => fallback.pixelsPerFootAt(y),
        diagnostics: {
          model: "linear-fit",
          horizonY: null,
          sceneConstant: null,
          acceptedIds: [derived[0].id],
          rejectedIds: [],
          notes: ["Need 2+ refs for linear fit; using IDW fallback."],
        },
      };
    }

    const fit = fitLinearModel(derived, imageHeight);
    if (!fit) {
      return {
        pixelsPerFootAt: (y) => fallback.pixelsPerFootAt(y),
        diagnostics: { model: "linear-fit", notes: ["Fit failed; using IDW fallback."] },
      };
    }

    const pixelsPerFootAt = (y) => {
      if (y > fit.h + 1) return fit.K * (y - fit.h);
      // At or above the horizon the linear formula goes to zero or negative;
      // defer to IDW so sculptures placed near/above the fitted horizon
      // still render something reasonable.
      return fallback.pixelsPerFootAt(y);
    };

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "linear-fit",
        horizonY: fit.h,
        sceneConstant: fit.K,
        fitError: fit.fitError,
        acceptedIds: fit.acceptedIds,
        rejectedIds: fit.rejectedIds,
        notes: [
          `Fitted h=${fit.h.toFixed(1)}, K=${fit.K.toFixed(4)} (= 1/H_cam)`,
          `MAD fit error (relative): ${fit.fitError.toFixed(4)}`,
          fit.rejectedIds.length
            ? `Rejected ${fit.rejectedIds.length} outlier ref(s).`
            : "All refs accepted.",
        ],
      },
    };
  },
};
