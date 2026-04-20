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

## Physical model (estimators 2–4)

Pinhole camera at height `H_cam` above a flat ground plane, looking
level. A point on the ground at world distance `D` from the camera
projects to image-Y `y_b` with:

```
y_b − h_horizon  =  f · H_cam / D           (f = focal length)
```

A vertical object of real height `H` at that point has pixel height:

```
h_px  =  f · H / D  =  H · (y_b − h_horizon) / H_cam
```

so the local px-per-foot is:

```
ppf(y)  =  h_px / H  =  (y − h) / H_cam  ≡  K · (y − h)
```

with `K = 1 / H_cam` constant across the whole scene. **px/ft is linear
in (y − h): sculptures get bigger as they move toward the viewer
(larger y), smaller as they approach the horizon.**

> Note: an earlier revision implemented `ppf(y) = A / (y − h)` based on
> a pseudocode snippet. That formula is inverted — it shrinks sculptures
> as they approach the viewer — and was fixed. The file previously named
> `reciprocal-fit.js` is now `linear-fit.js`.

---

## 1. `idw-midpoint` — IDW midpoint (original)

The app's original perspective model. Preserved unchanged so regressions
can be framed against it.

**Per-reference scalar**
```
ppf_i = hypot(p2 − p1) / knownFeet          # diagonal distance
y_i   = (p1.y + p2.y) / 2                   # midpoint Y
```

**Lookup across Y**
- **Inside the calibrated Y-range**: Shepard's inverse-distance weighting
  with p = 2:
  ```
  ppf(y) = Σ (ppf_i / d_i²) / Σ (1 / d_i²)   where d_i = |y − y_i|
  ```
- **Below the near ref** (toward viewer): linear slope extrapolation,
  clamped to `[ppf_near, 2.5·ppf_near]`.
- **Above the far ref** (toward horizon): clamped to
  `[0.05·ppf_far, ppf_far]`.

**Known weaknesses**
- Filing a ref's depth at its midpoint Y is geometrically wrong — the
  object stands at its base, not its middle. A tall near-field ref is
  filed farther from the camera than it actually is.
- Diagonal pixel distance mixes vertical (depth-varying) with horizontal
  (depth-invariant) click jitter.
- No physical model: nothing guarantees ref-to-ref consistency.

**Diagnostics**
```
{ model: "idw-midpoint", sampleCount, acceptedIds, rejectedIds: [], notes }
```

---

## 2. `horizon-basic` — Horizon basic

Minimal version of the horizon-line model. Same physical formulation as
estimators 3 and 4, but with none of the robustness extras — so if the
horizon-line model produces different results from IDW on a given photo,
it's the change-in-model that did it, not MAD rejection or weighting.

**Per-reference**
```
ppf_i = |base.y − top.y| / knownFeet        # vertical span only
K_i   = ppf_i / (base.y_i − h)              # per candidate horizon h
```

**Fit**

Grid-search `h ∈ [−0.5·imageHeight, min(base.y_i) − 2]`, coarse step 4 px
then refine at 0.5 px. Pick the `h` that minimizes the relative MAD of
`K_i` (MAD divided by median, so the search doesn't collapse to
whichever `h` makes K tiny). Set `K = median(K_i)` at the best `h`.

**Lookup**
```
ppf(y) = K · (y − h)            for y > h + 1
ppf(y) = max(0.1, K)            at or above the horizon (sculptures
                                 shouldn't be placed there, but we
                                 still return something positive)
```

**Fallback**

Single-ref: returns that ref's `ppfVertical` as a constant (no depth
variation, which is the right behavior with one data point).

**Diagnostics**
```
{ model: "horizon-basic", horizonY, sceneConstant (K), fitSpread,
  acceptedIds, rejectedIds: [], notes }
```

---

## 3. `horizon-robust` — Horizon robust

Extends `horizon-basic` with the parts of the Criminisi-style pipeline
that have usable input in a manual-click UI.

**Adds**
- **Automatic outlier rejection**: after the horizon fit, compute
  `K_i = ppf_i / (base.y_i − h)`; drop refs with
  `|K_i − medianK| > 2.5·MAD`. Final `K` = weighted median of survivors
  (weights = per-ref `annotationConfidence`, defaults to 1).
- **Confidence score** (0–1), combining accepted-ref count, tightness of
  fit (relative MAD), and base-Y spread across refs (depth diversity
  constrains the horizon more).
- **Plausible range** on K: 15th–85th percentile of accepted values.

**Deliberately omitted** from the source proposal (no input in our UI):
- Class weights per object type.
- Support-plane IDs.
- Occlusion / cropped / non-vertical flags.
- Hybrid local-ratio fallback.

**Diagnostics**
```
{ model: "horizon-robust", horizonY, sceneConstant (K), plausibleC,
  fitSpread, confidence, acceptedIds, rejectedIds, notes }
```

---

## 4. `linear-fit` — Linear fit *(default)*

Follows the same physical model with a lean style inspired by the
"base-point anchored perspective fit with robust outlier rejection"
pseudocode — but with the formula corrected from reciprocal to linear.

**Core**

```
ppf(y) = K · (y − h)            y > h + 1
         idw-midpoint fallback   y ≤ h + 1
```

**Fit**

```
for each candidate h:
  K_i   = ppf_i / (base.y_i − h)
  score = MAD(K_i) / median(K_i)        # relative MAD
pick h minimizing score      →   medianK, madK
accept refs with |K_i − medianK| ≤ 2.5·MAD
K = median(accepted K_i)                 # flat median, not weighted
```

**Fallback**

For any `y ≤ h + 1` (at or above the fitted horizon), defer to the
`idw-midpoint` estimator. The linear formula goes to zero or negative
there; IDW still returns something plausible for sculptures placed
unusually high in the frame.

**Differences from `horizon-robust`**
- No confidence score, no plausible-range field; just `fitError`.
- Flat median instead of weighted median.
- Built-in IDW fallback above the horizon; `horizon-robust` clamps to
  `max(0.1, K)` instead.

**Diagnostics**
```
{ model: "linear-fit", horizonY, sceneConstant (K), fitError,
  acceptedIds, rejectedIds, notes }
```

---

## Comparison cheat-sheet

| Estimator         | Depth anchor | Ref pixel extent | Cross-depth model       | Outlier rejection              | Confidence |
| ----------------- | ------------ | ---------------- | ----------------------- | ------------------------------ | ---------- |
| `idw-midpoint`    | midpoint Y   | diagonal         | Shepard IDW + clamps    | none (UI flag only)            | no         |
| `horizon-basic`   | base Y       | vertical         | `K · (y − h)`           | none                           | no         |
| `horizon-robust`  | base Y       | vertical         | `K · (y − h)`           | MAD (2.5×), weighted median    | yes + range |
| `linear-fit`      | base Y       | vertical         | `K · (y − h)`, IDW at horizon | MAD (2.5×), flat median  | no (fitError) |

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

## Sanity test

Synthetic data generated with the correct pinhole physics
(`ppf(y) = 0.25 · (y − 300)`, two refs at baseY=600 and 800, each 6 ft):

| model            | y=400 | y=500 | y=600 | y=700 | y=800 | y=900 |
| ---------------- | ----- | ----- | ----- | ----- | ----- | ----- |
| **expected**     | 25    | 50    | 75    | 100   | 125   | 150   |
| `idw-midpoint`   | 100   | 200   | 300   | 312   | 312   | 312   |
| `horizon-basic`  | 25    | 50    | 75    | 100   | 125   | 150   |
| `horizon-robust` | 25    | 50    | 75    | 100   | 125   | 150   |
| `linear-fit`     | 25    | 50    | 75    | 100   | 125   | 150   |

All three horizon models recover exact physics; `idw-midpoint` diverges
because of midpoint-Y filing + diagonal span, and flattens outside the
ref range because of the near-clamp.

## File map

```
js/estimators/
  util.js              shared math (deriveRef, median, MAD, weightedMedian)
  idw-midpoint.js      estimator 1
  horizon-basic.js     estimator 2
  horizon-robust.js    estimator 3
  linear-fit.js        estimator 4 (was reciprocal-fit.js)
  index.js             registry
js/composite.js        delegates perspective ppf to selected estimator
js/app.js              model dropdown, diagnostics render
index.html             dropdown markup inside the Perspective tab body
```
