// Export helpers: still images and canvas video capture.
//
// Still frames use canvas.toBlob. Video uses MediaRecorder fed by
// canvas.captureStream(). We prefer MP4 (avc1) when the browser supports it
// (Safari / recent Chrome), and fall back to WebM otherwise.
//
// recordVideo returns the blob + mime so callers can choose to save it,
// wrap it in an auto-looping HTML page, or open it in a preview window.

export async function saveStill(canvas, mimeType, quality, filename) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, mimeType, quality),
  );
  if (!blob) throw new Error("Failed to render canvas to blob");
  downloadBlob(blob, filename);
}

// Record for `seconds` seconds, returning { blob, mime, ext }. Caller
// decides what to do with the result.
export async function recordVideo(canvas, seconds, onStatus) {
  const mime = pickBestVideoMime();
  if (!mime) throw new Error("MediaRecorder not supported in this browser");

  const stream = canvas.captureStream(30);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });

  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = (e) => reject(e.error || e);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
      resolve({ blob, mime, ext });
    };

    recorder.start();
    const started = performance.now();
    const tick = () => {
      const elapsed = (performance.now() - started) / 1000;
      onStatus?.(`Recording… ${elapsed.toFixed(1)}s / ${seconds}s`);
      if (elapsed >= seconds) recorder.stop();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Minimal auto-looping HTML player around an embedded video. `src` can be
// a data: URI (for shareable, self-contained downloads) or a blob: URL
// (for in-session preview). Plays muted + inline so autoplay isn't blocked.
export function loopingHtml(src, title = "Wind Sculpture Preview") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0e12; }
  body { display: grid; place-items: center; font-family: system-ui, sans-serif; color: #888; }
  video { max-width: 100%; max-height: 100vh; display: block; background: #000; }
  .hint { position: fixed; bottom: 8px; right: 12px; font-size: 11px; opacity: 0.5; }
</style>
</head>
<body>
<video autoplay loop muted playsinline controls src="${src}"></video>
<div class="hint">Auto-looping preview</div>
</body>
</html>
`;
}

// Read a Blob as a base64 data URI (async, non-blocking).
export function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.readAsDataURL(blob);
  });
}

function pickBestVideoMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
