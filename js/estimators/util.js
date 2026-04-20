// Shared helpers for estimators.
//
// Each ref stored on the stage is the raw click data plus the known real-world
// height in feet: { id, p1, p2, knownFeet }. `deriveRef` adds all the values
// an estimator might want (top/base, vertical & diagonal pixel spans, etc.)
// without each estimator having to recompute them.

export function deriveRef(ref) {
  const { p1, p2, knownFeet } = ref;
  // The point with the greater Y is the base (on the ground); smaller Y is top.
  const base = p1.y >= p2.y ? p1 : p2;
  const top = p1.y >= p2.y ? p2 : p1;
  const dxV = base.x - top.x;
  const dyV = base.y - top.y;
  const pixelHeightVertical = Math.max(1, Math.abs(dyV));
  const pixelHeightDiagonal = Math.max(1, Math.hypot(dxV, dyV));
  const midY = (p1.y + p2.y) / 2;
  return {
    ...ref,
    base,
    top,
    baseY: base.y,
    topY: top.y,
    midY,
    pixelHeightVertical,
    pixelHeightDiagonal,
    ppfVertical: pixelHeightVertical / knownFeet,
    ppfDiagonal: pixelHeightDiagonal / knownFeet,
  };
}

export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// Median absolute deviation. Robust spread measure, scale-equivalent to
// ~0.6745·σ for Gaussian data but unaffected by outliers.
export function mad(values) {
  if (values.length === 0) return 0;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

export function weightedMedian(items) {
  if (items.length === 0) return 0;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)].value;
  let acc = 0;
  for (const it of sorted) {
    acc += it.weight;
    if (acc >= total / 2) return it.value;
  }
  return sorted[sorted.length - 1].value;
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
