# Height estimation

Depth-aware px-per-foot lookup for the Wind Sculpture Visualizer. One
model, derived from pinhole-camera geometry on a flat ground plane.

## Model

```
ppf(y) = K · (y − h)     where K = 1 / H_camera, h = horizon-line Y
```

Derivation (level camera at height `H_cam` above the ground):

```
y_b − h  =  f · H_cam / D           (ground depth → image Y)
h_px     =  f · H / D               (object pixel height)
ppf      =  h_px / H  =  (y − h) / H_cam  ≡  K · (y − h)
```

`K` is a scene-wide constant. px/ft is linear in depth-from-horizon —
sculptures get bigger as they move toward the viewer (larger y), smaller
as they approach the horizon.

## Inputs

Each reference is a two-click annotation on the photo plus a known
real-world height in feet. Stored as:

```
{ id, p1, p2, knownFeet }
```

The estimator derives what it needs per ref (base point, top point,
vertical pixel span) from those primitives — see
`js/estimators/util.js::deriveRef`.

## Fit

1. Compute per-ref vertical `ppf_i = |base.y − top.y| / knownFeet`.
2. Grid-search `h ∈ [−0.5·imageHeight, min(base.y_i) − 2]` at 4 px,
   refine at 0.5 px. Pick the `h` minimizing the relative MAD of
   `K_i = ppf_i / (base.y_i − h)` (MAD divided by median, so the search
   doesn't collapse to whichever `h` makes K tiny).
3. With **Auto-reject outliers** on and 3+ refs: drop refs whose `K_i`
   is more than 2.5·MAD from the median, then take `K = median(K_i)` of
   survivors. If rejection would leave fewer than 2 refs, keep all.
4. Without rejection: `K = median(K_i)` across all refs.

## Lookup

```
ppf(y)  =  max(floor, K · (y − h))
floor   =  K · (nearestBaseY − h) · 0.05   # 5% of the nearest-ref ppf
```

The floor prevents sculptures placed at or above the fitted horizon
from vanishing — they'll render very small, which is physically
correct.

## Diagnostics (shown in the UI below the ref list)

```
horizonY       fitted h (image pixels)
sceneConstant  K = 1 / H_camera (px per foot per pixel of depth)
plausibleC     15th–85th percentile of accepted K_i values
fitSpread      relative MAD of K_i at the best h
confidence     0–1, combining ref count, fit tightness, base-Y spread
acceptedIds    refs that contributed to the final K
rejectedIds    refs dropped as outliers (only when the toggle is on)
notes          human-readable summary lines
```

## UI controls

- **Add reference** — click two points on the photo bracketing something
  you know the height of; enter its real height (feet / inches / m / cm).
- **Auto-reject outlier refs** (checkbox, default on) — gates the MAD
  rejection step. With 2 refs there's nothing to reject. With 3+, a ref
  more than 2.5·MAD off the median is dropped and flagged in the list.
- **Per-ref remove button** — manual override, always available.

## Assumptions

- Camera roll ≈ 0. A strongly tilted camera breaks the
  vertical-span-equals-height identity.
- Reference base and sculpture base on the same flat ground plane.
- References are approximately vertical in the world. A leaning fence
  post inflates pixel height without changing real height.

If a photo violates these (hilly yard, steeply pitched camera, tilted
refs), the fit error and confidence go up and the diagnostics panel
will show it.

## Sanity test

Synthetic data generated from the correct physics
(`ppf(y) = 0.25 · (y − 300)`, three refs at baseY = 500, 700, 900):

| y     | expected | computed |
| ----- | -------- | -------- |
| 400   |    25    |    25.0  |
| 600   |    75    |    75.0  |
| 800   |   125    |   125.0  |
| 1000  |   175    |   175.0  |

Outlier injection (one ref way off): with the toggle on the bad ref is
rejected and K stays at 0.25; with the toggle off it drags K down.

## File map

```
js/estimators/
  util.js              shared math (deriveRef, median, MAD, clamp)
  horizon-linear.js    the model
  index.js             registry (just the one model today)
js/composite.js        wires estimator into the render loop
js/app.js              checkbox + diagnostics render
index.html             checkbox markup inside the Perspective tab body
```

## History

Earlier revisions shipped four estimators: `idw-midpoint` (the original
Shepard interpolation over midpoint-Y + diagonal pixel distance),
`horizon-basic`, `horizon-robust`, and `reciprocal-fit` / `linear-fit`.

- `idw-midpoint` was removed: it files a ref's depth at its midpoint Y
  instead of its base, which mis-files foreground refs and produces
  sculptures that look too tall.
- The three horizon-based models collapsed to one: they all used the
  same physical formula and the same MAD-minimizing horizon search, so
  on typical input (2–4 consistent refs) they produced identical
  numbers. The MAD rejection became a checkbox.
- An earlier version of the formula had `A / (y − h)` (reciprocal) from
  a pseudocode proposal. That inverts the camera geometry — sculptures
  shrink as they approach the viewer — and was replaced with the
  correct linear form.
