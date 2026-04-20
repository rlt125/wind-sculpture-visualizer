# Height-estimator library

The Wind Sculpture Visualizer renders each sculpture at its true real-world
size by converting `heightFeet` → pixels using a depth-aware `pixelsPerFootAt(y)`
function. That function is pluggable: four models live in
`js/estimators/`, the user picks one from the **Perspective → Model**
dropdown, and the UI shows live diagnostics (fitted horizon, scene
constant, outliers, confidence, etc.) so different approaches can be
compared side-by-side on the same photo.

All four estimators consume the same ref list. Each ref stores the raw
click data and the user-entered real-world height:

```
{ id, p1, p2, knownFeet }
```

Each estimator is responsible for deriving whatever it needs (base-Y,
top-Y, vertical pixel height, diagonal pixel height, midpoint, …) from
those primitives. That derivation is centralized in
`js/estimators/util.js::deriveRef`.

The registry in `js/estimators/index.js` exposes `ESTIMATORS`,
`getEstimator(id)`, and `DEFAULT_ESTIMATOR_ID`.

---

## 1. `idw-midpoint` — IDW midpoint (original)

The app's original perspective model. Preserved unchanged so every
regression test is framed against it.

**Per-reference scalar**
```
ppf_i = hypot(p2 − p1) / knownFeet          # diagonal distance
y_i   = (p1.y + p2.y) / 2                   # midpoint Y
```

**Lookup across Y**
- **Inside the calibrated Y-range** (between the smallest and largest
  `y_i`): Shepard's inverse-distance weighting with p = 2:
  ```
  ppf(y) = Σ (ppf_i / d_i²) / Σ (1 / d_i²)   where d_i = |y − y_i|
  ```
  Exact at each ref, smooth between. Every ref contributes.
- **Below the near ref** (toward viewer): linear extrapolation along the
  slope of the two nearest refs, clamped between `ppf_near` and
  `2.5 · ppf_near`.
- **Above the far ref** (toward horizon): same extrapolation, clamped
  between `0.05 · ppf_far` and `ppf_far`.

**Known weaknesses**
- Filing a ref's depth at its midpoint Y is geometrically wrong: the
  object stands at its **base**, not its middle. A tall near-field ref
  gets filed farther from the camera than it actually is, which distorts
  the whole interpolation.
- Diagonal pixel distance mixes vertical (depth-varying) with horizontal
  (depth-invariant) click jitter.
- No physical model: nothing guarantees that a well-calibrated scene
  should produce any particular invariant across refs.

**Diagnostics**
```
{ model: "idw-midpoint", sampleCount, acceptedIds, rejectedIds: [], notes }
```

---

## 2. `horizon-basic` — Horizon basic

Minimal version of the horizon-line model. Same physical formulation as
the next two estimators, but with none of the robustness extras — so if
the horizon-line model produces different behavior from IDW on a given
photo, it's this change-in-model that did it, not MAD rejection or
weighting.

**Model**

Pinhole camera, level, on a flat ground plane. For any object of real
height `H` standing on the ground at image-Y `y_b`:
```
h_px = C · H / (y_b − h_horizon)
```
so:
```
ppf(y) = C / (y − h_horizon)
```

**Per-reference**
```
ppf_i = |base.y − top.y| / knownFeet        # vertical span only
C_i   = ppf_i · (base.y_i − h)              # per candidate horizon h
```

**Fit**

Grid-search `h ∈ [−0.5·imageHeight, min(base.y_i) − 2]`, coarse step 4 px
then refine at 0.5 px. Pick the `h` that minimizes `MAD(C_i)`. Set the
scene constant `C = median(C_i at that h)`.

**Fallback**

Single-ref: returns that ref's `ppfVertical` as a constant (no depth
variation, which is the right behavior with one data point).

**Diagnostics**
```
{ model: "horizon-basic", horizonY, sceneConstant, fitSpread,
  acceptedIds, rejectedIds: [], notes }
```

---

## 3. `horizon-robust` — Horizon robust

Extends `horizon-basic` with the parts of the Criminisi-style pipeline
that have a usable input in this app (manual clicks, no object
classifier).

**Adds**
- **Automatic outlier rejection**: after the horizon fit, compute
  `C_i = ppf_i · (base.y_i − h)`, take `medianC` and `MAD`. Drop refs
  with `|C_i − medianC| > 2.5 · MAD`. Take `C` as the weighted median of
  the survivors (weights = per-ref `annotationConfidence`, defaults to 1
  since the UI doesn't capture it yet).
- **Confidence score** (0–1), combining:
  - accepted-ref count (few refs → lower score)
  - `1 − 3·relSpread` (tighter fit = higher)
  - base-Y spread across refs (more depth diversity = better horizon)
  - a small penalty for outliers rejected
- **Plausible range** on `C`: 15th–85th percentile of accepted values.

**Deliberately omitted** from the proposal that inspired this model:
- Class weights per object type (`person`, `door`, `stop_sign`, …) — no
  classifier to assign them.
- Support-plane IDs — one implicit ground plane.
- Occlusion / cropped / non-vertical flags — user clicks what they can
  see; if the clicks went through, the ref is usable.
- Hybrid local-ratio fallback — redundant once the horizon model works.

**Diagnostics**
```
{ model: "horizon-robust", horizonY, sceneConstant, plausibleC, fitSpread,
  confidence, acceptedIds, rejectedIds, notes }
```

---

## 4. `reciprocal-fit` — Reciprocal fit *(default)*

Direct implementation of the "base-point anchored reciprocal perspective
fit with robust outlier rejection" pseudocode. Mathematically identical
to `horizon-robust` for the core formula; differs in style and
conservatism.

**Core**

Same model as above: `ppf(y) = A / (y − h)`, where `A` is scene-constant.

**Fit**

```
for each candidate h:
  A_i = ppf_i · (base.y_i − h)
  score = MAD(A_i)
pick h minimizing score  →  medianA, madA
accept refs with |A_i − medianA| ≤ 2.5·MAD
A = median(accepted A_i)                  # flat median, not weighted
```

**Fallback**

For any `y ≤ h + 1` (at or above the fitted horizon), defer to the
`idw-midpoint` estimator — the reciprocal formula blows up at the
horizon, so sculptures placed there fall back to local interpolation
rather than returning a garbage value.

**Differences from `horizon-robust`**
- No confidence score, no plausible-range field; just `fitError` (the
  MAD of accepted A values).
- Flat median instead of weighted median — appropriate when every ref
  has the same trust level.
- Built-in IDW fallback above the horizon (robust doesn't do this;
  clamps to `C / 1` instead).

**Diagnostics**
```
{ model: "reciprocal-fit", horizonY, sceneConstant, fitError,
  acceptedIds, rejectedIds, notes }
```

---

## Comparison cheat-sheet

| Estimator         | Depth anchor | Ref pixel extent | Cross-depth model     | Outlier rejection  | Confidence |
| ----------------- | ------------ | ---------------- | --------------------- | ------------------ | ---------- |
| `idw-midpoint`    | midpoint Y   | diagonal         | Shepard IDW + clamps  | none (UI flag only) | no         |
| `horizon-basic`   | base Y       | vertical         | `C / (y − h)`         | none               | no         |
| `horizon-robust`  | base Y       | vertical         | `C / (y − h)`         | MAD (2.5×), weighted median | yes (0–1) + range |
| `reciprocal-fit`  | base Y       | vertical         | `A / (y − h)`, IDW above horizon | MAD (2.5×), flat median | no (just fitError) |

## Assumptions common to 2–4

- Camera roll ≈ 0 (or small). A strongly tilted camera breaks the
  vertical-span-equals-height assumption.
- Both the reference base and the sculpture base are on the same flat
  ground plane.
- Reference is (approximately) vertical in the world. Slanted refs (a
  leaning fence post) inflate the pixel height without changing the
  real height.

If any of those break badly, `idw-midpoint` will often degrade more
gracefully — it's making no physical claims, just smoothing samples.

## Testing approach

Open the same photo with a fixed set of references, then flip the
**Model** dropdown between all four. The `estimator-diag` panel shows
the fitted horizon and scene constant for each, plus which refs were
rejected. For a known-good placement, record the visible pixel height
of a sculpture under each model and compare to a tape-measure ground
truth.

## File map

```
js/estimators/
  util.js              shared math (deriveRef, median, MAD, weightedMedian)
  idw-midpoint.js      estimator 1
  horizon-basic.js     estimator 2
  horizon-robust.js    estimator 3
  reciprocal-fit.js    estimator 4
  index.js             registry
js/composite.js        delegates perspective ppf to selected estimator
js/app.js              model dropdown, diagnostics render
index.html             dropdown markup inside the Perspective tab body
```
