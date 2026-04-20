// Unit conversion for the reference-height input.

const UNIT_TO_FEET = { ft: 1, in: 1 / 12, m: 3.28084, cm: 0.0328084 };

export function toFeet(value, unit) {
  const f = UNIT_TO_FEET[unit];
  if (!f) throw new Error(`Unknown unit: ${unit}`);
  return value * f;
}
