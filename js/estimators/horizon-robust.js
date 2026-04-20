// Estimator 3: Horizon robust.
//
// Extends horizon-basic with the parts of the Criminisi-style single-view
// metrology pipeline that are useful in a manual-click UI:
//   - Same physical model: ppf(y) = C / (y − h).
//   - Horizon search via MAD minimization (coarse + refine pass).
//   - Automatic outlier rejection: refs whose C is > 2.5·MAD from the
//     median are dropped from the final C estimate.
//   - Weighted median of accepted Cs (weights: annotation confidence;
//     defaults to 1 since the UI doesn't collect per-click confidence).
//   - Confidence score and plausible range surfaced in diagnostics.
//
// Deliberately omits the object-classifier / class-weight / support-plane /
// occlusion-flag scaffolding from the source proposal, because our UI
// captures none of those signals — the user clicks two points and types a
// height. Keeping only the knobs that have inputs.

import { deriveRef, median, mad, weightedMedian, clamp } from "./util.js";

const OUTLIER_MAD_MULT = 2.5;

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
    return mad(Cs) / Math.max(1e-6, Math.abs(median(Cs)));
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
  // Wider base-Y spread across refs = stronger horizon constraint.
  const spreadScore = clamp(baseSpread / 200, 0, 1);
  const penaltyForRejects = accepted >= usable ? 0 : 0.05 * (usable - accepted);
  return clamp(0.35 * countScore + 0.45 * agreementScore + 0.2 * spreadScore - penaltyForRejects, 0, 1);
}

export default {
  id: "horizon-robust",
  name: "Horizon robust",
  short: "ppf(y) = C / (y − h) with MAD outlier rejection + confidence",
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
          sceneConstant: r ? r.ppfVertical * 100 : null,
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
      C: r.ppfVertical * (r.baseY - fit.h),
      weight: clamp(r.annotationConfidence ?? 1, 0.01, 1),
    }));

    const medianC = median(items.map((i) => i.C));
    const madC = Math.max(1e-6, mad(items.map((i) => i.C)));
    const accepted = items.filter((i) => Math.abs(i.C - medianC) <= OUTLIER_MAD_MULT * madC);
    const rejected = items.filter((i) => Math.abs(i.C - medianC) > OUTLIER_MAD_MULT * madC);

    const finalC = accepted.length
      ? weightedMedian(accepted.map((i) => ({ value: i.C, weight: i.weight })))
      : medianC;

    const baseYs = derived.map((r) => r.baseY);
    const baseSpread = Math.max(...baseYs) - Math.min(...baseYs);

    const pixelsPerFootAt = (y) => {
      const d = y - fit.h;
      if (d <= 1) return finalC / 1;
      return finalC / d;
    };

    const conf = confidence({
      accepted: accepted.length,
      usable: items.length,
      relSpread: fit.relSpread,
      baseSpread,
    });

    const acceptedCs = accepted.map((i) => i.C).sort((a, b) => a - b);
    const p15 = acceptedCs[Math.floor(0.15 * (acceptedCs.length - 1))] ?? finalC;
    const p85 = acceptedCs[Math.ceil(0.85 * (acceptedCs.length - 1))] ?? finalC;

    return {
      pixelsPerFootAt,
      diagnostics: {
        model: "horizon-robust",
        horizonY: fit.h,
        sceneConstant: finalC,
        plausibleC: { low: p15, high: p85 },
        fitSpread: fit.relSpread,
        confidence: conf,
        acceptedIds: accepted.map((i) => i.ref.id),
        rejectedIds: rejected.map((i) => i.ref.id),
        notes: [
          `Fitted horizon y=${fit.h.toFixed(1)}, C=${finalC.toFixed(1)} (conf ${(conf * 100).toFixed(0)}%)`,
          rejected.length ? `Rejected ${rejected.length}/${items.length} refs as outliers (>${OUTLIER_MAD_MULT}·MAD)` : "All refs accepted.",
          `Base-Y spread across refs: ${baseSpread.toFixed(0)} px`,
        ],
      },
    };
  },
};
