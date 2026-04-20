// Estimator 4: Reciprocal fit.
//
// Implements the pseudocode from the "base-point anchored reciprocal
// perspective fitting" proposal:
//
//     ppf(y) = A / (y − h)
//
// with:
//   - per-ref ppf_i = |base.y − top.y| / knownFeet   (vertical pixel span)
//   - A_i = ppf_i · (baseY_i − h)
//   - grid-search h to minimize MAD of A_i values
//   - MAD-based outlier rejection (|A_i − medianA| > 2.5·MAD)
//   - A = median of accepted A_i
//
// Differs from horizon-robust in these ways:
//   - No confidence score / plausible range surfaced (just fitError).
//   - No weighting — flat median instead of weighted median.
//   - Near-or-above-horizon fallback uses the IDW-midpoint estimator so
//     sculptures placed above the fitted horizon still render something
//     (rather than blowing up or collapsing).

import { deriveRef, median, mad } from "./util.js";
import idwMidpoint from "./idw-midpoint.js";

const OUTLIER_MAD_MULT = 2.5;

function fitPerspectiveModel(derived, imageHeight) {
  if (derived.length < 2) return null;

  const data = derived.map((r) => ({ ref: r, ppf: r.ppfVertical, baseY: r.baseY }));
  const minH = -0.5 * imageHeight;
  const maxH = Math.min(...data.map((d) => d.baseY)) - 2;
  if (maxH <= minH) return null;

  const scoreAt = (h) => {
    const Aset = [];
    for (const d of data) {
      const denom = d.baseY - h;
      if (denom <= 1) return null;
      Aset.push({ ref: d.ref, value: d.ppf * denom });
    }
    if (Aset.length < 2) return null;
    const m = median(Aset.map((v) => v.value));
    return { mad: median(Aset.map((v) => Math.abs(v.value - m))), set: Aset };
  };

  let bestH = null, bestScore = Number.POSITIVE_INFINITY, bestSet = null;
  for (let h = minH; h <= maxH; h += 2) {
    const s = scoreAt(h);
    if (!s) continue;
    if (s.mad < bestScore) { bestScore = s.mad; bestH = h; bestSet = s.set; }
  }
  if (bestH == null) return null;
  for (let h = bestH - 4; h <= bestH + 4; h += 0.25) {
    const s = scoreAt(h);
    if (!s) continue;
    if (s.mad < bestScore) { bestScore = s.mad; bestH = h; bestSet = s.set; }
  }

  const medianA = median(bestSet.map((v) => v.value));
  const madA = Math.max(1e-6, median(bestSet.map((v) => Math.abs(v.value - medianA))));
  const accepted = bestSet.filter((v) => Math.abs(v.value - medianA) <= OUTLIER_MAD_MULT * madA);
  const rejected = bestSet.filter((v) => Math.abs(v.value - medianA) > OUTLIER_MAD_MULT * madA);
  const A = accepted.length ? median(accepted.map((v) => v.value)) : medianA;

  return {
    h: bestH,
    A,
    acceptedIds: accepted.map((v) => v.ref.id),
    rejectedIds: rejected.map((v) => v.ref.id),
    fitError: madA,
  };
}

export default {
  id: "reciprocal-fit",
  name: "Reciprocal fit (recommended)",
  short: "ppf(y) = A / (y − h), base-Y + vertical ppf, MAD-rejected, IDW fallback above horizon",
  build(refs, ctx) {
    const derived = refs.map(deriveRef);
    const imageHeight = ctx?.imageHeight || 1080;

    if (derived.length === 0) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "reciprocal-fit", notes: ["No refs."] },
      };
    }

    const fallback = idwMidpoint.build(refs);

    if (derived.length < 2) {
      return {
        pixelsPerFootAt: (y) => fallback.pixelsPerFootAt(y),
        diagnostics: {
          model: "reciprocal-fit",
          horizonY: null,
          sceneConstant: null,
          acceptedIds: [derived[0].id],
          rejectedIds: [],
          notes: ["Need 2+ refs for reciprocal fit; using IDW fallback."],
        },
      };
    }

    const fit = fitPerspectiveModel(derived, imageHeight);
    if (!fit) {
      return {
        pixelsPerFootAt: (y) => fallback.pixelsPerFootAt(y),
        diagnostics: { model: "reciprocal-fit", notes: ["Fit failed; using IDW fallback."] },
      };
    }

    const pixelsPerFootAt = (y) => {
      if (y > fit.h + 1) return fit.A / (y - fit.h);
      return fallback.pixelsPerFootAt(y);
    };

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "reciprocal-fit",
        horizonY: fit.h,
        sceneConstant: fit.A,
        fitError: fit.fitError,
        acceptedIds: fit.acceptedIds,
        rejectedIds: fit.rejectedIds,
        notes: [
          `Fitted h=${fit.h.toFixed(1)}, A=${fit.A.toFixed(1)}`,
          `MAD fit error: ${fit.fitError.toFixed(2)}`,
          fit.rejectedIds.length ? `Rejected ${fit.rejectedIds.length} outlier ref(s).` : "All refs accepted.",
        ],
      },
    };
  },
};
