// Estimator 3: Horizon robust.
//
// Same physical model as horizon-basic:
//   ppf(y) = K · (y − h)   with K = 1/H_camera
// plus the robustness extras that have inputs in this UI:
//   - Automatic outlier rejection: after fitting h, compute per-ref K_i;
//     drop any with |K_i − medianK| > 2.5·MAD. Final K = weighted median
//     of survivors (weights = per-ref annotationConfidence; defaults to 1).
//   - Confidence score (0–1), combining accepted-ref count, tightness of
//     fit (relative MAD), and base-Y spread across refs (depth diversity
//     constrains the horizon more).
//   - Plausible range on K: 15th–85th percentile of accepted values.
//
// Deliberately omitted from the source proposal (no input in our UI):
//   - Class weights per object type (person, door, stop_sign, …).
//   - Support-plane IDs.
//   - Occlusion / cropped / non-vertical flags.
//   - Hybrid local-ratio fallback.

import { deriveRef, median, mad, weightedMedian, clamp } from "./util.js";

const OUTLIER_MAD_MULT = 2.5;

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

function confidence({ accepted, usable, relSpread, baseSpread }) {
  const countScore = accepted === 0 ? 0 : accepted === 1 ? 0.3 : accepted === 2 ? 0.55 : accepted >= 4 ? 0.9 : 0.75;
  const agreementScore = clamp(1 - relSpread * 3, 0, 1);
  const spreadScore = clamp(baseSpread / 200, 0, 1);
  const penaltyForRejects = accepted >= usable ? 0 : 0.05 * (usable - accepted);
  return clamp(0.35 * countScore + 0.45 * agreementScore + 0.2 * spreadScore - penaltyForRejects, 0, 1);
}

export default {
  id: "horizon-robust",
  name: "Horizon robust",
  short: "ppf(y) = K · (y − h) with MAD outlier rejection + confidence",
  build(refs, ctx) {
    const derived = refs.map(deriveRef);
    const imageHeight = ctx?.imageHeight || 1080;

    if (derived.length < 2) {
      const r = derived[0];
      const fn = r ? () => r.ppfVertical : () => null;
      return {
        pixelsPerFootAt: fn,
        diagnostics: {
          model: "horizon-robust",
          horizonY: null,
          sceneConstant: null,
          acceptedIds: r ? [r.id] : [],
          rejectedIds: [],
          confidence: r ? 0.3 : 0,
          notes: ["Need 2+ refs for horizon fit; single-ref mode has low confidence."],
        },
      };
    }

    const fit = searchHorizon(derived, imageHeight);
    if (!fit) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "horizon-robust", confidence: 0, notes: ["Horizon search failed."] },
      };
    }

    const items = derived.map((r) => ({
      ref: r,
      K: r.ppfVertical / (r.baseY - fit.h),
      weight: clamp(r.annotationConfidence ?? 1, 0.01, 1),
    }));

    const medianK = median(items.map((i) => i.K));
    const madK = Math.max(1e-9, mad(items.map((i) => i.K)));
    const accepted = items.filter((i) => Math.abs(i.K - medianK) <= OUTLIER_MAD_MULT * madK);
    const rejected = items.filter((i) => Math.abs(i.K - medianK) > OUTLIER_MAD_MULT * madK);

    const finalK = accepted.length
      ? weightedMedian(accepted.map((i) => ({ value: i.K, weight: i.weight })))
      : medianK;

    const baseYs = derived.map((r) => r.baseY);
    const baseSpread = Math.max(...baseYs) - Math.min(...baseYs);

    const pixelsPerFootAt = (y) => {
      const d = y - fit.h;
      if (d <= 1) return Math.max(0.1, finalK);
      return finalK * d;
    };

    const conf = confidence({
      accepted: accepted.length,
      usable: items.length,
      relSpread: fit.relSpread,
      baseSpread,
    });

    const acceptedKs = accepted.map((i) => i.K).sort((a, b) => a - b);
    const p15 = acceptedKs[Math.floor(0.15 * (acceptedKs.length - 1))] ?? finalK;
    const p85 = acceptedKs[Math.ceil(0.85 * (acceptedKs.length - 1))] ?? finalK;

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "horizon-robust",
        horizonY: fit.h,
        sceneConstant: finalK,
        plausibleC: { low: p15, high: p85 },
        fitSpread: fit.relSpread,
        confidence: conf,
        acceptedIds: accepted.map((i) => i.ref.id),
        rejectedIds: rejected.map((i) => i.ref.id),
        notes: [
          `Fitted horizon y=${fit.h.toFixed(1)}, K=${finalK.toFixed(4)} (conf ${(conf * 100).toFixed(0)}%)`,
          rejected.length
            ? `Rejected ${rejected.length}/${items.length} ref(s) as outliers (>${OUTLIER_MAD_MULT}·MAD)`
            : "All refs accepted.",
          `Base-Y spread: ${baseSpread.toFixed(0)} px`,
        ],
      },
    };
  },
};
