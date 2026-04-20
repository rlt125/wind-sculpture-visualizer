// Compositing and rendering.
//
// Owns the render loop. Each frame draws:
//   1) landscape photo (scaled to fit canvas, letterboxed)
//   2) any number of placed sculptures, each with optional ground shadow,
//      optionally chroma-keyed if the source is MP4-without-alpha
//   3) calibration overlays
//   4) a subtle selection outline on the currently-selected sculpture
//
// Sculpture position is stored in IMAGE-pixel coords (not feet) so that we
// stay neutral to calibration mode — perspective (depth-varying px/ft)
// would otherwise require mapping feet back and forth constantly.

export function createStage(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  const state = {
    photo: null,             // HTMLImageElement
    photoFit: null,          // { dx, dy, dw, dh, scale }
    sculptures: [],          // [{ id, meta, source, position, flip, shadow }, ...]
    selectedId: null,
    calibration: {
      // "uniform" = one pixelsPerFoot applied everywhere.
      // "perspective" = interpolated from 2+ references at different image Ys.
      mode: "uniform",
      pixelsPerFoot: null,
      refs: [],              // perspective: [{ imageY, pixelsPerFoot }, ...]
    },
    calibOverlay: null,      // active calibration UI
    chroma: null,            // lazy offscreen canvas for chroma-key pass
  };

  let nextId = 1;

  // --- layout -------------------------------------------------------------

  function fitPhoto() {
    if (!state.photo) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    const cw = canvas.width, ch = canvas.height;
    const iw = state.photo.naturalWidth, ih = state.photo.naturalHeight;
    const scale = Math.min(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    state.photoFit = { dx, dy, dw, dh, scale };
  }

  function canvasToImage(cx, cy) {
    const f = state.photoFit;
    if (!f) return { x: cx, y: cy };
    return { x: (cx - f.dx) / f.scale, y: (cy - f.dy) / f.scale };
  }

  function imageToCanvas(ix, iy) {
    const f = state.photoFit;
    if (!f) return { x: ix, y: iy };
    return { x: ix * f.scale + f.dx, y: iy * f.scale + f.dy };
  }

  function eventToCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    const dpr = canvas.width / rect.width;
    return { x: (ev.clientX - rect.left) * dpr, y: (ev.clientY - rect.top) * dpr };
  }

  // --- calibration --------------------------------------------------------

  // Depth-aware px-per-foot for a given image-Y. In uniform mode this is
  // constant; in perspective mode we linearly interpolate between the two
  // nearest references by Y, extrapolating outside the bracket.
  function pixelsPerFootAt(imageY) {
    const c = state.calibration;
    if (c.mode === "uniform") return c.pixelsPerFoot;
    const refs = c.refs;
    if (refs.length === 0) return null;
    if (refs.length === 1) return refs[0].pixelsPerFoot;
    // Find the bracketing pair (or nearest pair for extrapolation).
    const sorted = [...refs].sort((a, b) => a.imageY - b.imageY);
    let lo = sorted[0], hi = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length - 1; i++) {
      if (imageY >= sorted[i].imageY && imageY <= sorted[i + 1].imageY) {
        lo = sorted[i]; hi = sorted[i + 1]; break;
      }
    }
    const t = (imageY - lo.imageY) / (hi.imageY - lo.imageY || 1);
    const ppf = lo.pixelsPerFoot + t * (hi.pixelsPerFoot - lo.pixelsPerFoot);
    return Math.max(0.1, ppf); // clamp so we never get 0/negative at horizon
  }

  function hasCalibration() {
    const c = state.calibration;
    if (c.mode === "uniform") return !!c.pixelsPerFoot;
    return c.refs.length > 0;
  }

  function setUniformCalibration(ppf) {
    state.calibration = { mode: "uniform", pixelsPerFoot: ppf, refs: [] };
  }

  function addPerspectiveRef(imageY, ppf) {
    if (state.calibration.mode !== "perspective") {
      // Auto-upgrade from uniform: seed with the existing uniform ref at the
      // previous default placement Y if we had one, then add the new one.
      const existing = state.calibration.pixelsPerFoot;
      const existingY = state.photo ? state.photo.naturalHeight * 0.75 : 0;
      state.calibration = { mode: "perspective", pixelsPerFoot: null, refs: [] };
      if (existing) state.calibration.refs.push({ imageY: existingY, pixelsPerFoot: existing });
    }
    state.calibration.refs.push({ imageY, pixelsPerFoot: ppf });
  }

  function clearCalibration() {
    state.calibration = { mode: "uniform", pixelsPerFoot: null, refs: [] };
  }

  // --- sculptures ---------------------------------------------------------

  function defaultPosition() {
    if (!state.photo) return { imageX: 0, imageY: 0 };
    return {
      imageX: state.photo.naturalWidth / 2,
      imageY: state.photo.naturalHeight * 0.75,
    };
  }

  // Add a new sculpture. Returns the new entry so callers can push it into
  // an undo stack.
  function addSculpture(meta, source) {
    const s = {
      id: nextId++,
      meta,
      source,
      position: defaultPosition(),
      flip: false,
      shadow: true,
    };
    state.sculptures.push(s);
    state.selectedId = s.id;
    return s;
  }

  // Re-insert a previously-removed sculpture. Used by undo.
  function restoreSculpture(s, atIndex) {
    const idx = atIndex == null ? state.sculptures.length : atIndex;
    state.sculptures.splice(idx, 0, s);
    state.selectedId = s.id;
  }

  function removeSculpture(id) {
    const idx = state.sculptures.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    const [removed] = state.sculptures.splice(idx, 1);
    if (state.selectedId === id) {
      state.selectedId = state.sculptures.length
        ? state.sculptures[Math.max(0, idx - 1)].id
        : null;
    }
    return { sculpture: removed, index: idx };
  }

  function selectSculpture(id) { state.selectedId = id; }

  function getSelected() {
    return state.sculptures.find((s) => s.id === state.selectedId) || null;
  }

  function setFlip(v) { const s = getSelected(); if (s) s.flip = v; }
  function setShadow(v) { const s = getSelected(); if (s) s.shadow = v; }

  function setPhoto(img) {
    state.photo = img;
    fitPhoto();
  }

  // --- drawing ------------------------------------------------------------

  function drawPhoto() {
    const f = state.photoFit;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (state.photo && f) ctx.drawImage(state.photo, f.dx, f.dy, f.dw, f.dh);
  }

  function sourceSize(src) {
    if (src.kind === "mp4") return { w: src.el.videoWidth || 1, h: src.el.videoHeight || 1 };
    return { w: src.el.naturalWidth || 1, h: src.el.naturalHeight || 1 };
  }

  function sculptureDrawBox(s) {
    const ppf = pixelsPerFootAt(s.position.imageY);
    const f = state.photoFit;
    if (!ppf || !f) return null;
    const { w: srcW, h: srcH } = sourceSize(s.source);
    if (!srcW || !srcH) return null;
    const imgHeightPx = s.meta.heightFeet * ppf;
    const imgWidthPx = imgHeightPx * (srcW / srcH);
    const drawH = imgHeightPx * f.scale;
    const drawW = imgWidthPx * f.scale;
    const pos = imageToCanvas(s.position.imageX, s.position.imageY);
    return { x: pos.x - drawW / 2, y: pos.y - drawH, w: drawW, h: drawH, anchor: pos, srcW, srcH };
  }

  function drawSculptures() {
    if (!state.photoFit) return;
    for (const s of state.sculptures) {
      const b = sculptureDrawBox(s);
      if (!b) continue;

      if (s.shadow) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.ellipse(b.anchor.x, b.anchor.y, b.w * 0.45, b.h * 0.04, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const hasChroma = s.source.kind === "mp4" && !s.meta.mp4HasAlpha && s.meta.chromaKey;
      const el = hasChroma ? chromaKeyed(s.source.el, s.meta.chromaKey, b.srcW, b.srcH) : s.source.el;
      ctx.save();
      if (s.flip) {
        ctx.translate(b.x + b.w, b.y);
        ctx.scale(-1, 1);
        ctx.drawImage(el, 0, 0, b.w, b.h);
      } else {
        ctx.drawImage(el, b.x, b.y, b.w, b.h);
      }
      ctx.restore();

      if (s.id === state.selectedId) {
        ctx.save();
        ctx.strokeStyle = "#4f8cff";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
    }
  }

  function chromaKeyed(el, hex, w, h) {
    if (!state.chroma) {
      state.chroma = document.createElement("canvas");
      state.chroma._ctx = state.chroma.getContext("2d", { willReadFrequently: true });
    }
    const off = state.chroma;
    if (off.width !== w) off.width = w;
    if (off.height !== h) off.height = h;
    const octx = off._ctx;
    octx.clearRect(0, 0, w, h);
    octx.drawImage(el, 0, 0, w, h);
    const { r: kr, g: kg, b: kb } = hexToRgb(hex);
    const tolerance = 80;
    const tSq = tolerance * tolerance;
    const frame = octx.getImageData(0, 0, w, h);
    const d = frame.data;
    for (let i = 0; i < d.length; i += 4) {
      const dr = d[i] - kr, dg = d[i + 1] - kg, db = d[i + 2] - kb;
      if (dr * dr + dg * dg + db * db < tSq) d[i + 3] = 0;
    }
    octx.putImageData(frame, 0, 0);
    return off;
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { r: 0, g: 255, b: 0 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  // --- overlays (calibration) --------------------------------------------

  function drawOverlay() {
    // Always draw existing perspective references as faded labelled lines.
    if (state.calibration.mode === "perspective") {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(79,140,255,0.6)";
      ctx.fillStyle = "rgba(79,140,255,0.8)";
      ctx.font = "12px system-ui";
      state.calibration.refs.forEach((ref, i) => {
        const p = imageToCanvas(0, ref.imageY);
        ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(canvas.width, p.y); ctx.stroke();
        ctx.fillText(`ref ${i + 1}: ${ref.pixelsPerFoot.toFixed(1)} px/ft`, 8, p.y - 4);
      });
      ctx.restore();
    }

    const o = state.calibOverlay;
    if (!o) return;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#4f8cff";
    ctx.fillStyle = "#4f8cff";
    if (o.kind === "two-point") {
      const pts = o.points.map((p) => imageToCanvas(p.x, p.y));
      pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); });
      if (pts.length === 2) {
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
      }
    } else if (o.kind === "preset" && o.top && o.bottom) {
      const a = imageToCanvas(o.top.x, o.top.y);
      const b = imageToCanvas(o.bottom.x, o.bottom.y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      [a, b].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); });
      ctx.font = "12px system-ui";
      ctx.fillText(`${o.feet} ft`, (a.x + b.x) / 2 + 8, (a.y + b.y) / 2);
    }
    ctx.restore();
  }

  // --- render loop --------------------------------------------------------

  let rafId = null;
  function loop() {
    drawPhoto();
    drawSculptures();
    drawOverlay();
    rafId = requestAnimationFrame(loop);
  }
  function start() { if (!rafId) loop(); }
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // --- hit-test for dragging / selection ---------------------------------

  // Returns the topmost sculpture id at a canvas-space point, or null.
  // Iterates in reverse so the last-drawn (topmost) wins.
  function sculptureAtPoint(cx, cy) {
    for (let i = state.sculptures.length - 1; i >= 0; i--) {
      const b = sculptureDrawBox(state.sculptures[i]);
      if (!b) continue;
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
        return state.sculptures[i].id;
      }
    }
    return null;
  }

  function moveSelectedBy(dxCanvas, dyCanvas) {
    const s = getSelected();
    if (!s || !state.photoFit) return;
    const f = state.photoFit;
    s.position.imageX += dxCanvas / f.scale;
    s.position.imageY += dyCanvas / f.scale;
  }

  return {
    // lifecycle
    start, stop, fitPhoto,
    // photo
    setPhoto,
    // calibration
    setUniformCalibration, addPerspectiveRef, clearCalibration,
    hasCalibration, pixelsPerFootAt,
    // sculptures
    addSculpture, removeSculpture, restoreSculpture, selectSculpture,
    getSelected, setFlip, setShadow,
    // coords / hit-test
    eventToCanvas, canvasToImage, imageToCanvas,
    sculptureAtPoint, moveSelectedBy,
    // overlay
    setCalibOverlay(o) { state.calibOverlay = o; },
    clearCalibOverlay() { state.calibOverlay = null; },
    // accessors
    get canvas() { return canvas; },
    get state() { return state; },
  };
}
