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

  // Depth-aware px-per-foot for a given image-Y.
  //
  //  - Uniform mode: constant everywhere.
  //  - Inside the calibrated Y-range: Shepard's method (p=2) weighted
  //    average across all refs. Exact at each ref, smooth between, every
  //    ref contributes proportional to 1/d².
  //  - Past the near ref (toward the viewer): extrapolate along the slope
  //    of the two closest refs so sculptures keep growing naturally. Cap
  //    at CLOSE_CAP× the near-ref value to prevent a bad ref from blowing
  //    up placements far past the range.
  //  - Past the far ref (toward the horizon): same idea, shrink along the
  //    slope down to FAR_MIN× of the far-ref value.
  const CLOSE_CAP = 2.5;
  const FAR_MIN = 0.05;

  function pixelsPerFootAt(imageY) {
    const c = state.calibration;
    if (c.mode === "uniform") return c.pixelsPerFoot;
    const refs = c.refs;
    if (refs.length === 0) return null;
    if (refs.length === 1) return refs[0].pixelsPerFoot;
    const sorted = [...refs].sort((a, b) => a.imageY - b.imageY);

    if (imageY < sorted[0].imageY) {
      const a = sorted[0], b = sorted[1];
      const slope = (b.pixelsPerFoot - a.pixelsPerFoot) / (b.imageY - a.imageY || 1);
      const extrap = a.pixelsPerFoot + (imageY - a.imageY) * slope;
      return Math.max(a.pixelsPerFoot * FAR_MIN, Math.min(a.pixelsPerFoot, extrap));
    }
    const last = sorted[sorted.length - 1];
    if (imageY > last.imageY) {
      const a = last, b = sorted[sorted.length - 2];
      const slope = (a.pixelsPerFoot - b.pixelsPerFoot) / (a.imageY - b.imageY || 1);
      const extrap = a.pixelsPerFoot + (imageY - a.imageY) * slope;
      return Math.max(a.pixelsPerFoot, Math.min(a.pixelsPerFoot * CLOSE_CAP, extrap));
    }

    let wSum = 0, vSum = 0;
    for (const r of refs) {
      const d = Math.abs(imageY - r.imageY);
      if (d < 0.5) return r.pixelsPerFoot;
      const w = 1 / (d * d);
      wSum += w;
      vSum += w * r.pixelsPerFoot;
    }
    return vSum / wSum;
  }

  function hasCalibration() {
    const c = state.calibration;
    if (c.mode === "uniform") return !!c.pixelsPerFoot;
    return c.refs.length > 0;
  }

  function setUniformCalibration(ppf, p1, p2) {
    state.calibration = { mode: "uniform", pixelsPerFoot: ppf, refs: [], marker: p1 && p2 ? { p1, p2 } : null };
  }

  function addPerspectiveRef(imageY, ppf, p1, p2) {
    if (state.calibration.mode !== "perspective") {
      // Auto-upgrade from uniform: carry over the existing uniform ref (with
      // its clicked points, if any) as the first perspective ref.
      const prev = state.calibration;
      state.calibration = { mode: "perspective", pixelsPerFoot: null, refs: [] };
      if (prev.pixelsPerFoot) {
        const prevY = prev.marker
          ? (prev.marker.p1.y + prev.marker.p2.y) / 2
          : (state.photo ? state.photo.naturalHeight * 0.75 : 0);
        state.calibration.refs.push({
          imageY: prevY,
          pixelsPerFoot: prev.pixelsPerFoot,
          p1: prev.marker?.p1, p2: prev.marker?.p2,
        });
      }
    }
    state.calibration.refs.push({ imageY, pixelsPerFoot: ppf, p1, p2 });
  }

  function clearCalibration() {
    state.calibration = { mode: "uniform", pixelsPerFoot: null, refs: [] };
  }

  function removePerspectiveRef(idx) {
    if (state.calibration.mode !== "perspective") return;
    state.calibration.refs.splice(idx, 1);
    if (state.calibration.refs.length === 0) clearCalibration();
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
      scale: 1.0, // 1.0 = auto-scaled by calibration; user-resize overrides
    };
    state.sculptures.push(s);
    state.selectedId = s.id;
    return s;
  }

  function setSelectedScale(scale) {
    const s = getSelected();
    if (s) s.scale = Math.max(0.1, scale);
  }

  function resetSelectedScale() {
    const s = getSelected();
    if (!s) return null;
    const prev = s.scale;
    s.scale = 1.0;
    return prev;
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

  const RESIZE_HANDLE_R = 8;

  // Hit-test: is a canvas point on the corner resize handle of the selected
  // sculpture? Handle is a square at the top-right corner of the draw box.
  function isOnResizeHandle(cx, cy) {
    const s = getSelected();
    if (!s) return false;
    const b = sculptureDrawBox(s);
    if (!b) return false;
    const hx = b.x + b.w, hy = b.y;
    return (
      cx >= hx - RESIZE_HANDLE_R - 2 && cx <= hx + RESIZE_HANDLE_R + 2 &&
      cy >= hy - RESIZE_HANDLE_R - 2 && cy <= hy + RESIZE_HANDLE_R + 2
    );
  }

  function sculptureDrawBox(s) {
    const ppf = pixelsPerFootAt(s.position.imageY);
    const f = state.photoFit;
    if (!ppf || !f) return null;
    const { w: srcW, h: srcH } = sourceSize(s.source);
    if (!srcW || !srcH) return null;
    const scale = s.scale || 1;
    const imgHeightPx = s.meta.heightFeet * ppf * scale;
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

        // Corner resize handle at the top-right.
        const hx = b.x + b.w, hy = b.y;
        ctx.save();
        ctx.fillStyle = "#4f8cff";
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.fillRect(hx - RESIZE_HANDLE_R, hy - RESIZE_HANDLE_R, RESIZE_HANDLE_R * 2, RESIZE_HANDLE_R * 2);
        ctx.strokeRect(hx - RESIZE_HANDLE_R, hy - RESIZE_HANDLE_R, RESIZE_HANDLE_R * 2, RESIZE_HANDLE_R * 2);
        ctx.restore();

        // Scale tooltip near the handle. Shown whenever scale differs from
        // 1.0 — covers both "during drag" and "stuck at a manual override".
        const scale = s.scale || 1;
        if (Math.abs(scale - 1) > 0.005) {
          const pct = Math.round(scale * 100);
          const delta = Math.round((scale - 1) * 100);
          const label = delta >= 0 ? `${pct}%  (+${delta}%)` : `${pct}%  (${delta}%)`;
          ctx.save();
          ctx.font = "bold 12px system-ui";
          const m = ctx.measureText(label);
          const padX = 6, padY = 4;
          const tx = hx + 10;
          const ty = hy - 4;
          ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.fillRect(tx - padX, ty - 12 - padY, m.width + padX * 2, 16 + padY);
          ctx.fillStyle = scale > 1 ? "#ffd96a" : "#6aa1ff";
          ctx.fillText(label, tx, ty);
          ctx.restore();
        }
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

  // Draw a persistent marker (two dots connected by a line) for a saved
  // calibration reference, with a label next to it. The label is clamped
  // to the visible canvas so a ref whose clicked points extend beyond the
  // photo still has a visible, legible annotation.
  function drawRefMarker(p1, p2, label, color) {
    if (!p1 || !p2) return;
    const a = imageToCanvas(p1.x, p1.y);
    const b = imageToCanvas(p2.x, p2.y);
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    [a, b].forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); });
    if (label) {
      ctx.font = "bold 12px system-ui";
      const pad = 8;
      // Start at the midpoint of the segment, then clamp into the canvas.
      let tx = (a.x + b.x) / 2 + pad;
      let ty = (a.y + b.y) / 2;
      const m = ctx.measureText(label);
      tx = Math.max(pad, Math.min(canvas.width - m.width - pad, tx));
      ty = Math.max(16, Math.min(canvas.height - pad, ty));
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 3;
      ctx.strokeText(label, tx, ty);
      ctx.fillStyle = color;
      ctx.fillText(label, tx, ty);
    }
    ctx.restore();
  }

  function drawOverlay() {
    // Persist calibration references so the user can see what was captured.
    const c = state.calibration;
    if (c.mode === "uniform" && c.marker) {
      drawRefMarker(c.marker.p1, c.marker.p2, `${c.pixelsPerFoot.toFixed(1)} px/ft`, "#4f8cff");
    } else if (c.mode === "perspective") {
      // Faint horizontal band at each reference's Y, plus the clicked segment.
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(79,140,255,0.4)";
      ctx.fillStyle = "rgba(79,140,255,0.9)";
      ctx.font = "11px system-ui";
      c.refs.forEach((ref) => {
        const p = imageToCanvas(0, ref.imageY);
        ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(canvas.width, p.y); ctx.stroke();
      });
      ctx.restore();
      c.refs.forEach((ref, i) => {
        drawRefMarker(ref.p1, ref.p2,
          `ref ${i + 1}: ${ref.pixelsPerFoot.toFixed(1)} px/ft`, "#4f8cff");
      });
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
    setUniformCalibration, addPerspectiveRef, clearCalibration, removePerspectiveRef,
    hasCalibration, pixelsPerFootAt,
    // sculptures
    addSculpture, removeSculpture, restoreSculpture, selectSculpture,
    getSelected, setFlip, setShadow, setSelectedScale, resetSelectedScale,
    sculptureDrawBox,
    // coords / hit-test
    eventToCanvas, canvasToImage, imageToCanvas,
    sculptureAtPoint, isOnResizeHandle, moveSelectedBy,
    // overlay
    setCalibOverlay(o) { state.calibOverlay = o; },
    clearCalibOverlay() { state.calibOverlay = null; },
    // accessors
    get canvas() { return canvas; },
    get state() { return state; },
  };
}
