// Export helpers: still images and canvas video capture.
//
// Still frames use canvas.toBlob. Video uses MediaRecorder fed by
// canvas.captureStream(). We prefer MP4 (avc1) when the browser supports it
// (Safari / recent Chrome), and fall back to WebM otherwise.

export async function saveStill(canvas, mimeType, quality, filename) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, mimeType, quality),
  );
  if (!blob) throw new Error("Failed to render canvas to blob");
  downloadBlob(blob, filename);
}

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
      downloadBlob(blob, `wind-sculpture-${Date.now()}.${ext}`);
      resolve({ blob, mime });
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
