// Height estimator: Horizon (linear).
//
// The app's single depth-aware px-per-foot model. Derived from pinhole
// camera geometry on a flat ground plane:
//
//     ppf(y) = K · (y − h)     where K = 1/H_camera
//
// Per-reference:
//     ppf_i = |base.y − top.y| / knownFeet       # vertical span only
//     K_i   = ppf_i / (base.y_i − h)             # scene-constant at best h
//
// Fit: grid-search h to minimize the relative MAD of K_i (coarse 4 px
// then refine at 0.5 px). Take K = median of K_i at the best h; with
// MAD rejection on, drop refs whose K_i is > 2.5·MAD from the median
// before taking the median.
//
// Above the horizon (y ≤ h + 1), the linear formula goes to zero. We
// clamp to 5% of the nearest-ref ppf so sculptures placed up near the
// horizon stay visible instead of vanishing — they'll look tiny, which
// is physically correct.
//
// Diagnostics include fitted h, K, confidence (0–1), plausible range
// on K, fit spread, and which refs were accepted / rejected.

import { deriveRef, median, mad, clamp } from "./util.js";

const OUTLIER_MAD_MULT = 2.5;
const MIN_PPF_FRACTION = 0.05;  // clamp floor near/above horizon

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

function confidenceScore({ accepted, usable, relSpread, baseSpread }) {
  const countScore =
    accepted === 0 ? 0 :
    accepted === 1 ? 0.3 :
    accepted === 2 ? 0.55 :
    accepted >= 4 ? 0.9 : 0.75;
  const agreementScore = clamp(1 - relSpread * 3, 0, 1);
  const spreadScore = clamp(baseSpread / 200, 0, 1);
  const rejectPenalty = accepted >= usable ? 0 : 0.05 * (usable - accepted);
  return clamp(
    0.35 * countScore + 0.45 * agreementScore + 0.2 * spreadScore - rejectPenalty,
    0, 1
  );
}

export default {
  id: "horizon-linear",
  name: "Horizon (linear)",
  short: "ppf(y) = K · (y − h), base-Y anchored, with MAD outlier rejection",
  build(refs, ctx) {
    const rejectOutliers = ctx?.rejectOutliers ?? true;
    const imageHeight = ctx?.imageHeight || 1080;
    const derived = refs.map(deriveRef);

    if (derived.length === 0) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "horizon-linear", notes: ["No references."] },
      };
    }

    if (derived.length < 2) {
      const r = derived[0];
      return {
        pixelsPerFootAt: () => r.ppfVertical,
        diagnostics: {
          model: "horizon-linear",
          horizonY: null,
          sceneConstant: null,
          confidence: 0.3,
          acceptedIds: [r.id],
          rejectedIds: [],
          notes: ["Single reference: using constant ppf everywhere (no depth cue)."],
        },
      };
    }

    const fit = searchHorizon(derived, imageHeight);
    if (!fit) {
      return {
        pixelsPerFootAt: () => null,
        diagnostics: { model: "horizon-linear", confidence: 0, notes: ["Horizon search failed."] },
      };
    }

    const items = derived.map((r) => ({
      ref: r,
      K: r.ppfVertical / (r.baseY - fit.h),
    }));

    const medianK = median(items.map((i) => i.K));
    const madK = Math.max(1e-9, mad(items.map((i) => i.K)));

    let accepted = items, rejected = [];
    if (rejectOutliers && items.length >= 3) {
      accepted = items.filter((i) => Math.abs(i.K - medianK) <= OUTLIER_MAD_MULT * madK);
      rejected = items.filter((i) => Math.abs(i.K - medianK) > OUTLIER_MAD_MULT * madK);
      if (accepted.length < 2) {  // don't reject so aggressively we have <2 refs
        accepted = items;
        rejected = [];
      }
    }

    const finalK = median(accepted.map((i) => i.K));

    // Floor below the horizon: use 5% of the ppf we'd get at the nearest
    // calibrated ref's base. Sculptures placed up against the horizon
    // still render, just very small.
    const nearestBaseY = Math.max(...derived.map((r) => r.baseY));
    const floorPpf = finalK * (nearestBaseY - fit.h) * MIN_PPF_FRACTION;

    const pixelsPerFootAt = (y) => {
      const d = y - fit.h;
      if (d <= 1) return floorPpf;
      return Math.max(floorPpf, finalK * d);
    };

    const baseYs = derived.map((r) => r.baseY);
    const baseSpread = Math.max(...baseYs) - Math.min(...baseYs);
    const conf = confidenceScore({
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
        model: "horizon-linear",
        horizonY: fit.h,
        sceneConstant: finalK,
        plausibleC: { low: p15, high: p85 },
        fitSpread: fit.relSpread,
        confidence: conf,
        acceptedIds: accepted.map((i) => i.ref.id),
        rejectedIds: rejected.map((i) => i.ref.id),
        notes: [
          `Fitted h=${fit.h.toFixed(1)}, K=${finalK.toFixed(4)} (confidence ${(conf * 100).toFixed(0)}%)`,
          rejected.length
            ? `Rejected ${rejected.length}/${items.length} ref(s) as outliers (>${OUTLIER_MAD_MULT}·MAD).`
            : (rejectOutliers ? "All refs within MAD tolerance." : "Outlier rejection disabled."),
          `Base-Y spread: ${baseSpread.toFixed(0)} px`,
        ],
      },
    };
  },
};
