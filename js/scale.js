// Scale calibration.
//
// Holds pixelsPerFoot for the current photo and provides two ways to measure:
// 1) Two-point: user clicks point A and point B, types the real distance.
// 2) Preset:    user drags a vertical line representing a known-height reference
//               (6ft person, 7ft door, etc.).
//
// Both modes write back to a single state object so the rest of the app doesn't
// care which one produced the number.

const UNIT_TO_FEET = { ft: 1, in: 1 / 12, m: 3.28084, cm: 0.0328084 };

export function toFeet(value, unit) {
  const f = UNIT_TO_FEET[unit];
  if (!f) throw new Error(`Unknown unit: ${unit}`);
  return value * f;
}

export function createScaleState() {
  return {
    pixelsPerFoot: null,
    // Points are stored in IMAGE coordinates (not canvas-display coordinates)
    // so they remain valid regardless of canvas resize.
    points: [],
    mode: null, // "two-point" | "preset" | null
    referenceFeet: null,
  };
}

export function computeFromTwoPoints(p1, p2, realDistanceFeet) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const pixelDist = Math.hypot(dx, dy);
  if (pixelDist <= 0 || realDistanceFeet <= 0) return null;
  return pixelDist / realDistanceFeet;
}

// Format a readout string for the UI.
export function readout(state) {
  if (!state.pixelsPerFoot) return "Not calibrated yet.";
  const ppf = state.pixelsPerFoot;
  const ppm = ppf * 3.28084;
  return `Calibrated: ${ppf.toFixed(1)} px / ft  (${ppm.toFixed(1)} px / m)`;
}
