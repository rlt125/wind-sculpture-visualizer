// Main controller.
//
// Wires the UI (index.html) to the rendering stage (composite.js), the scale
// model (scale.js), the catalog loader (catalog.js), and the export helpers
// (recorder.js). No framework — just DOM events + small local state.

import { createStage } from "./composite.js";
import { createScaleState, computeFromTwoPoints, toFeet, readout } from "./scale.js";
import { loadCatalog, renderCatalogGrid, loadSource } from "./catalog.js";
import { saveStill, recordVideo } from "./recorder.js";

const canvas = document.getElementById("stage");
const stage = createStage(canvas);
const scaleState = createScaleState();

let catalogItems = [];
let selectedCatalogItem = null;
let calibMode = "two-point"; // "two-point" | "preset"
let interactionMode = "idle"; // "idle" | "calibrate-two-point" | "calibrate-preset" | "drag"
let dragAnchor = null;

// --- setup --------------------------------------------------------------

window.addEventListener("resize", () => {
  stage.fitPhoto();
});

stage.start();

loadCatalog()
  .then((items) => {
    catalogItems = items;
    renderCatalogGrid(document.getElementById("catalog-grid"), items, onSculpturePick);
  })
  .catch((err) => {
    console.warn("Catalog failed to load:", err);
    document.getElementById("catalog-grid").textContent =
      "Catalog missing. Add files to /catalog/ and edit manifest.json.";
  });

// --- upload -------------------------------------------------------------

const dropHint = document.getElementById("drop-hint");
const fileInput = document.getElementById("file-input");
document.getElementById("btn-choose-file").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleImageFile(file);
});

["dragenter", "dragover"].forEach((t) =>
  canvas.parentElement.addEventListener(t, (e) => {
    e.preventDefault();
    dropHint.classList.add("dragover");
  }),
);
["dragleave", "drop"].forEach((t) =>
  canvas.parentElement.addEventListener(t, (e) => {
    e.preventDefault();
    dropHint.classList.remove("dragover");
  }),
);
canvas.parentElement.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleImageFile(file);
});

function handleImageFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    stage.setPhoto(img);
    dropHint.classList.add("hidden");
    enableCard("scale");
    setStep(2);
  };
  img.src = url;
}

// --- card state helpers --------------------------------------------------

function enableCard(name) {
  document.querySelector(`.card[data-card="${name}"]`).classList.remove("disabled");
}

function setStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === n);
  });
}

// --- calibration: mode switch -------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    calibMode = tab.dataset.mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".tab-body").forEach((b) => {
      b.classList.toggle("hidden", b.dataset.body !== calibMode);
    });
  });
});

// --- calibration: two-point ---------------------------------------------

const twoPointDistInput = document.getElementById("two-point-distance");
const twoPointUnit = document.getElementById("two-point-unit");

document.getElementById("btn-two-point-start").addEventListener("click", () => {
  if (!stage.state.photo) return;
  interactionMode = "calibrate-two-point";
  stage.setCalibOverlay({ kind: "two-point", points: [] });
  canvas.classList.add("cursor-crosshair");
});

document.getElementById("btn-two-point-clear").addEventListener("click", () => {
  scaleState.points = [];
  scaleState.pixelsPerFoot = null;
  stage.clearCalibOverlay();
  stage.setPixelsPerFoot(null);
  updateReadout();
});

// --- calibration: preset ------------------------------------------------

const presetSelect = document.getElementById("preset-ref");
const presetCustom = document.getElementById("preset-custom");

presetSelect.addEventListener("change", () => {
  presetCustom.classList.toggle("hidden", presetSelect.value !== "custom");
});

document.getElementById("btn-preset-start").addEventListener("click", () => {
  if (!stage.state.photo) return;
  interactionMode = "calibrate-preset";
  stage.setCalibOverlay({ kind: "preset", top: null, bottom: null, feet: presetFeet() });
  canvas.classList.add("cursor-crosshair");
});

document.getElementById("btn-preset-clear").addEventListener("click", () => {
  scaleState.pixelsPerFoot = null;
  stage.clearCalibOverlay();
  stage.setPixelsPerFoot(null);
  updateReadout();
});

function presetFeet() {
  const v = presetSelect.value;
  if (v === "custom") return Number(presetCustom.value) || 6;
  if (v === "6-fence") return 6;
  return Number(v);
}

// --- canvas interaction --------------------------------------------------

canvas.addEventListener("pointerdown", (e) => {
  const { x, y } = stage.eventToCanvas(e);
  const img = stage.canvasToImage(x, y);

  if (interactionMode === "calibrate-two-point") {
    const o = stage.state.calibOverlay || { kind: "two-point", points: [] };
    const points = [...o.points, img];
    stage.setCalibOverlay({ kind: "two-point", points });
    if (points.length === 2) {
      const realFeet = toFeet(Number(twoPointDistInput.value), twoPointUnit.value);
      const ppf = computeFromTwoPoints(points[0], points[1], realFeet);
      if (ppf) {
        scaleState.pixelsPerFoot = ppf;
        scaleState.mode = "two-point";
        stage.setPixelsPerFoot(ppf);
        updateReadout();
        enableCard("sculpture");
        setStep(3);
      }
      interactionMode = "idle";
      canvas.classList.remove("cursor-crosshair");
    }
    return;
  }

  if (interactionMode === "calibrate-preset") {
    const o = stage.state.calibOverlay;
    if (!o.top) {
      stage.setCalibOverlay({ ...o, top: img });
    } else {
      const bottom = img;
      const top = o.top;
      stage.setCalibOverlay({ ...o, bottom });
      const feet = o.feet;
      const ppf = computeFromTwoPoints(top, bottom, feet);
      if (ppf) {
        scaleState.pixelsPerFoot = ppf;
        scaleState.mode = "preset";
        stage.setPixelsPerFoot(ppf);
        updateReadout();
        enableCard("sculpture");
        setStep(3);
      }
      interactionMode = "idle";
      canvas.classList.remove("cursor-crosshair");
    }
    return;
  }

  // Drag the sculpture if the click is inside it.
  if (stage.state.sculpture && stage.isInsideSculpture(x, y)) {
    interactionMode = "drag";
    dragAnchor = { x, y };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("cursor-grabbing");
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (interactionMode !== "drag" || !dragAnchor) return;
  const { x, y } = stage.eventToCanvas(e);
  stage.moveSculptureBy(x - dragAnchor.x, y - dragAnchor.y);
  dragAnchor = { x, y };
});

canvas.addEventListener("pointerup", (e) => {
  if (interactionMode === "drag") {
    canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove("cursor-grabbing");
    interactionMode = "idle";
    dragAnchor = null;
  }
});

function updateReadout() {
  const el = document.getElementById("scale-readout");
  el.textContent = readout(scaleState);
  el.classList.toggle("calibrated", !!scaleState.pixelsPerFoot);
}

// --- sculpture selection -------------------------------------------------

const sourceKindSelect = document.getElementById("source-kind");
const flipToggle = document.getElementById("toggle-flip");
const shadowToggle = document.getElementById("toggle-shadow");

sourceKindSelect.addEventListener("change", () => {
  if (selectedCatalogItem) onSculpturePick(selectedCatalogItem);
});
flipToggle.addEventListener("change", () => stage.setFlip(flipToggle.checked));
shadowToggle.addEventListener("change", () => stage.setShadow(shadowToggle.checked));

async function onSculpturePick(item) {
  selectedCatalogItem = item;
  try {
    const source = await loadSource(item, sourceKindSelect.value);
    stage.setSculpture(item, source);
    stage.setFlip(flipToggle.checked);
    stage.setShadow(shadowToggle.checked);
    enableCard("export");
    setStep(4);
  } catch (err) {
    console.error(err);
    alert(`Could not load sculpture: ${err.message}`);
  }
}

// --- export --------------------------------------------------------------

document.getElementById("btn-save-png").addEventListener("click", () => {
  saveStill(canvas, "image/png", 1.0, `wind-sculpture-${Date.now()}.png`).catch(reportErr);
});
document.getElementById("btn-save-jpg").addEventListener("click", () => {
  saveStill(canvas, "image/jpeg", 0.92, `wind-sculpture-${Date.now()}.jpg`).catch(reportErr);
});

const videoStatus = document.getElementById("video-status");
const videoSecondsInput = document.getElementById("video-seconds");
document.getElementById("btn-save-video").addEventListener("click", async () => {
  const seconds = Math.max(1, Math.min(30, Number(videoSecondsInput.value) || 5));
  try {
    await recordVideo(canvas, seconds, (msg) => (videoStatus.textContent = msg));
    videoStatus.textContent = "Saved.";
  } catch (err) {
    reportErr(err);
  }
});

function reportErr(err) {
  console.error(err);
  videoStatus.textContent = "";
  alert(err.message || String(err));
}
