// Animated GIF player.
//
// Browsers only advance <img>-based GIF frames when the image is actually
// laid out and composited, which is unreliable (headless Chromium, some
// mobile tabs, off-screen CSS positioning, etc.). Instead we fetch the GIF
// bytes, decode every frame with gifuct-js, and repaint the current frame
// onto an internal canvas on each requestAnimationFrame. That canvas is
// returned to the caller and works anywhere ctx.drawImage(...) does.

import { parseGIF, decompressFrames } from "./vendor/gifuct.esm.min.js";

export async function loadAnimatedGif(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GIF fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  const gif = parseGIF(buf);
  const frames = decompressFrames(gif, true);
  if (!frames.length) throw new Error("GIF has no frames");

  const W = gif.lsd.width, H = gif.lsd.height;

  // Main output canvas: always holds the currently-displayed frame.
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Small helper canvas for putting the per-frame patch (only the rectangle
  // the frame actually paints) before compositing it onto the main canvas.
  const patchCanvas = document.createElement("canvas");
  const patchCtx = patchCanvas.getContext("2d");

  // For disposal-type 3 (restore-to-previous), we snapshot the canvas state
  // before the frame paints and restore it at the start of the next one.
  let restoreSnapshot = null;
  let curIdx = -1;

  function applyFrame(i) {
    const frame = frames[i];

    // Apply disposal of the previous frame before painting this one.
    if (i > 0) {
      const prev = frames[i - 1];
      const d = prev.disposalType;
      if (d === 2) {
        const { top, left, width, height } = prev.dims;
        ctx.clearRect(left, top, width, height);
      } else if (d === 3 && restoreSnapshot) {
        ctx.putImageData(restoreSnapshot, 0, 0);
      }
      // disposalType 0/1: no-op — leave previous frame in place.
    } else {
      ctx.clearRect(0, 0, W, H);
    }

    if (frame.disposalType === 3) {
      restoreSnapshot = ctx.getImageData(0, 0, W, H);
    }

    const { top, left, width, height } = frame.dims;
    if (patchCanvas.width !== width) patchCanvas.width = width;
    if (patchCanvas.height !== height) patchCanvas.height = height;
    const patchData = new ImageData(new Uint8ClampedArray(frame.patch), width, height);
    patchCtx.putImageData(patchData, 0, 0);
    ctx.drawImage(patchCanvas, left, top);
  }

  // Precompute frame cumulative-delay boundaries. GIF delays < 20ms tend to be
  // clamped by browsers; we use the raw values but guarantee some minimum
  // movement so a GIF with all-zero delays still animates.
  const delays = frames.map((f) => Math.max(20, f.delay || 0));
  const totalDelay = delays.reduce((s, d) => s + d, 0);

  const start = performance.now();

  function tick() {
    const elapsed = (performance.now() - start) % totalDelay;
    let accum = 0;
    let targetIdx = frames.length - 1;
    for (let j = 0; j < frames.length; j++) {
      accum += delays[j];
      if (elapsed < accum) { targetIdx = j; break; }
    }

    if (targetIdx !== curIdx) {
      // If looping back or jumping, restart from frame 0.
      if (targetIdx < curIdx) {
        curIdx = -1;
        ctx.clearRect(0, 0, W, H);
      }
      for (let j = curIdx + 1; j <= targetIdx; j++) applyFrame(j);
      curIdx = targetIdx;
    }
    requestAnimationFrame(tick);
  }

  applyFrame(0);
  curIdx = 0;
  requestAnimationFrame(tick);

  // Expose a couple of natural-size properties so the rest of the app can
  // treat this canvas interchangeably with an HTMLImageElement.
  canvas.naturalWidth = W;
  canvas.naturalHeight = H;
  // Compute the bounding box of non-transparent pixels in the first frame
  // so the renderer can size/anchor to the visible sculpture, not the
  // (possibly-padded) GIF canvas. Done once per load.
  canvas.visibleBounds = computeVisibleBounds(ctx, W, H);
  return canvas;
}

// Scan the canvas for the tight non-transparent bounding box. Returns null
// if the canvas is entirely transparent.
export function computeVisibleBounds(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 32) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}
