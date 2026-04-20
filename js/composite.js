// Compositing and rendering.
//
// Owns the render loop. Draws three layers each frame:
//   1) landscape photo (scaled to fit canvas, letterboxed)
//   2) optional ground shadow under the sculpture
//   3) the sculpture (from a <video> or <img>), optionally chroma-keyed
//
// Also handles interaction: calibration overlays (two-point line + preset
// vertical line) and dragging the sculpture.

export function createStage(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  const state = {
    photo: null,              // HTMLImageElement
    photoFit: null,           // { dx, dy, dw, dh, scale } — how the photo is laid out on the canvas
    sculpture: null,          // { meta, source: {kind, el}, position: {xFeet, yFeet}, flip, shadow }
    calibOverlay: null,       // { kind: "two-point" | "preset", ... }
    pixelsPerFoot: null,
    chroma: null,             // offscreen canvas for chroma-key pass, lazy-init
  };

  // --- layout -------------------------------------------------------------

  function fitPhoto() {
    if (!state.photo) return;
    // Match backing store to displayed pixels for crisp output.
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

  // --- sculpture ----------------------------------------------------------

  // Default-place a newly selected sculpture roughly centered, sitting on the
  // ground approximately 3/4 down the image.
  function defaultPosition() {
    if (!state.photo || !state.pixelsPerFoot) return { xFeet: 0, yFeet: 0 };
    const imgW = state.photo.naturalWidth;
    const imgH = state.photo.naturalHeight;
    return {
      xFeet: (imgW / 2) / state.pixelsPerFoot,
      yFeet: (imgH * 0.75) / state.pixelsPerFoot,
    };
  }

  function setSculpture(meta, source) {
    state.sculpture = {
      meta,
      source,                       // { kind: "mp4"|"gif", el: HTMLVideoElement|HTMLImageElement }
      position: defaultPosition(),
      flip: false,
      shadow: true,
    };
  }

  function clearSculpture() { state.sculpture = null; }

  function setFlip(v) { if (state.sculpture) state.sculpture.flip = v; }
  function setShadow(v) { if (state.sculpture) state.sculpture.shadow = v; }

  function setPixelsPerFoot(ppf) {
    state.pixelsPerFoot = ppf;
    if (state.sculpture) state.sculpture.position = defaultPosition();
  }

  function setPhoto(img) {
    state.photo = img;
    fitPhoto();
  }

  // --- drawing ------------------------------------------------------------

  function drawPhoto() {
    const f = state.photoFit;
    if (!state.photo || !f) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.photo, f.dx, f.dy, f.dw, f.dh);
  }

  function sourceSize(src) {
    if (src.kind === "mp4") {
      return { w: src.el.videoWidth || 1, h: src.el.videoHeight || 1 };
    }
    return { w: src.el.naturalWidth || 1, h: src.el.naturalHeight || 1 };
  }

  function drawSculpture() {
    const s = state.sculpture;
    if (!s || !state.pixelsPerFoot || !state.photoFit) return;

    const { w: srcW, h: srcH } = sourceSize(s.source);
    if (!srcW || !srcH) return;

    const hFeet = s.meta.heightFeet;
    const imgHeightPx = hFeet * state.pixelsPerFoot;
    const imgWidthPx = imgHeightPx * (srcW / srcH);

    // Convert image-pixel space to canvas space (via photoFit scale)
    const f = state.photoFit;
    const drawH = imgHeightPx * f.scale;
    const drawW = imgWidthPx * f.scale;

    // Position is in image-feet. Bottom-center of sculpture sits at that point.
    const pos = imageToCanvas(s.position.xFeet * state.pixelsPerFoot, s.position.yFeet * state.pixelsPerFoot);
    const drawX = pos.x - drawW / 2;
    const drawY = pos.y - drawH;

    // Shadow
    if (s.shadow) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(pos.x, pos.y, drawW * 0.45, drawH * 0.04, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // The source (video or img). If it's an MP4 without alpha and a chromaKey
    // is configured, do a chroma-key pass via an offscreen canvas.
    const hasChroma = s.source.kind === "mp4" && !s.meta.mp4HasAlpha && s.meta.chromaKey;
    const drawFn = (el) => {
      ctx.save();
      if (s.flip) {
        ctx.translate(drawX + drawW, drawY);
        ctx.scale(-1, 1);
        ctx.drawImage(el, 0, 0, drawW, drawH);
      } else {
        ctx.drawImage(el, drawX, drawY, drawW, drawH);
      }
      ctx.restore();
    };

    if (hasChroma) {
      drawFn(chromaKeyed(s.source.el, s.meta.chromaKey, srcW, srcH));
    } else {
      drawFn(s.source.el);
    }
  }

  // Chroma-key an image/video frame into an offscreen canvas and return it.
  // Removes pixels within Euclidean RGB distance `tolerance` of the key color.
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
    const o = state.calibOverlay;
    if (!o) return;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#4f8cff";
    ctx.fillStyle = "#4f8cff";
    if (o.kind === "two-point") {
      const pts = o.points.map((p) => imageToCanvas(p.x, p.y));
      pts.forEach((p) => {
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
      });
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
    drawSculpture();
    drawOverlay();
    rafId = requestAnimationFrame(loop);
  }
  function start() { if (!rafId) loop(); }
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // --- hit-test for dragging ---------------------------------------------

  function sculptureBounds() {
    const s = state.sculpture;
    if (!s || !state.pixelsPerFoot || !state.photoFit) return null;
    const { w: srcW, h: srcH } = sourceSize(s.source);
    if (!srcW || !srcH) return null;
    const f = state.photoFit;
    const drawH = s.meta.heightFeet * state.pixelsPerFoot * f.scale;
    const drawW = drawH * (srcW / srcH);
    const pos = imageToCanvas(s.position.xFeet * state.pixelsPerFoot, s.position.yFeet * state.pixelsPerFoot);
    return { x: pos.x - drawW / 2, y: pos.y - drawH, w: drawW, h: drawH, anchor: pos };
  }

  function isInsideSculpture(cx, cy) {
    const b = sculptureBounds();
    if (!b) return false;
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  }

  function moveSculptureBy(dxCanvas, dyCanvas) {
    const s = state.sculpture;
    if (!s || !state.pixelsPerFoot || !state.photoFit) return;
    const f = state.photoFit;
    s.position.xFeet += (dxCanvas / f.scale) / state.pixelsPerFoot;
    s.position.yFeet += (dyCanvas / f.scale) / state.pixelsPerFoot;
  }

  return {
    // lifecycle
    start, stop, fitPhoto,
    // state setters
    setPhoto, setPixelsPerFoot, setSculpture, clearSculpture, setFlip, setShadow,
    // coords / hit-test
    eventToCanvas, canvasToImage, imageToCanvas, isInsideSculpture, moveSculptureBy,
    // overlay
    setCalibOverlay(o) { state.calibOverlay = o; },
    clearCalibOverlay() { state.calibOverlay = null; },
    // accessors
    get canvas() { return canvas; },
    get state() { return state; },
  };
}
