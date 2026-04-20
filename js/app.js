// Main controller.
//
// Wires the UI (index.html) to the rendering stage (composite.js), the scale
// model (scale.js), the catalog loader (catalog.js), and the export helpers
// (recorder.js). No framework — just DOM events + small local state.
//
// Supports multiple sculptures on the photo, per-sculpture selection and
// dragging, an undo stack for add/move/delete, and perspective-aware
// calibration (multi-reference, depth-interpolated px-per-ft).

import { createStage } from "./composite.js";
import { computeFromTwoPoints, toFeet } from "./scale.js";
import { loadCatalog, renderCatalogGrid, loadSource } from "./catalog.js";
import { saveStill, recordVideo } from "./recorder.js";

const canvas = document.getElementById("stage");
const stage = createStage(canvas);

let catalogItems = [];
let selectedCatalogItem = null;
let calibMode = "two-point"; // "two-point" | "preset" | "perspective"
let interactionMode = "idle"; // "idle" | "calibrate-two-point" | "calibrate-preset" | "calibrate-persp" | "drag"
let dragAnchor = null;
let dragBeforeImageXY = null; // to build an undo entry when a drag ends

// Undo history: { kind: "add"|"move"|"delete", ... }
const undoStack = [];
function pushUndo(entry) { undoStack.push(entry); updateUndoButton(); }

// --- setup --------------------------------------------------------------

window.addEventListener("resize", () => stage.fitPhoto());
stage.start();

loadCatalog()
  .then((items) => {
    catalogItems = items;
    const grid = document.getElementById("catalog-grid");
    const filter = document.getElementById("catalog-filter");
    const render = (q) => {
      const n = (q || "").trim().toLowerCase();
      const filtered = n ? items.filter((it) => it.name.toLowerCase().includes(n)) : items;
      renderCatalogGrid(grid, filtered, onSculpturePick);
    };
    render("");
    filter.addEventListener("input", (e) => render(e.target.value));
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
    URL.revokeObjectURL(url);
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
  stage.clearCalibration();
  stage.clearCalibOverlay();
  updateReadouts();
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
  stage.clearCalibration();
  stage.clearCalibOverlay();
  updateReadouts();
});

function presetFeet() {
  const v = presetSelect.value;
  if (v === "custom") return Number(presetCustom.value) || 6;
  if (v === "6-fence") return 6;
  return Number(v);
}

// --- calibration: perspective (multi-reference) -------------------------

const perspDistInput = document.getElementById("persp-distance");
const perspUnit = document.getElementById("persp-unit");

document.getElementById("btn-persp-add").addEventListener("click", () => {
  if (!stage.state.photo) return;
  interactionMode = "calibrate-persp";
  stage.setCalibOverlay({ kind: "two-point", points: [], perspective: true });
  canvas.classList.add("cursor-crosshair");
});

document.getElementById("btn-persp-clear").addEventListener("click", () => {
  stage.clearCalibration();
  stage.clearCalibOverlay();
  updateReadouts();
});

// --- canvas interaction --------------------------------------------------

canvas.addEventListener("pointerdown", (e) => {
  const { x, y } = stage.eventToCanvas(e);
  const img = stage.canvasToImage(x, y);

  if (interactionMode === "calibrate-two-point" || interactionMode === "calibrate-persp") {
    const o = stage.state.calibOverlay || { kind: "two-point", points: [] };
    const points = [...o.points, img];
    stage.setCalibOverlay({ ...o, points });
    if (points.length === 2) {
      const isPersp = interactionMode === "calibrate-persp";
      const feet = toFeet(
        Number(isPersp ? perspDistInput.value : twoPointDistInput.value),
        isPersp ? perspUnit.value : twoPointUnit.value,
      );
      const ppf = computeFromTwoPoints(points[0], points[1], feet);
      if (ppf) {
        if (isPersp) {
          const midY = (points[0].y + points[1].y) / 2;
          stage.addPerspectiveRef(midY, ppf, points[0], points[1]);
        } else {
          stage.setUniformCalibration(ppf, points[0], points[1]);
        }
        updateReadouts();
        enableCard("sculpture");
        setStep(3);
      }
      interactionMode = "idle";
      stage.clearCalibOverlay();
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
      const ppf = computeFromTwoPoints(top, bottom, o.feet);
      if (ppf) {
        stage.setUniformCalibration(ppf, top, bottom);
        updateReadouts();
        enableCard("sculpture");
        setStep(3);
      }
      interactionMode = "idle";
      stage.clearCalibOverlay();
      canvas.classList.remove("cursor-crosshair");
    }
    return;
  }

  // Pick / drag logic: click on a sculpture selects + starts drag; click on
  // empty area deselects.
  const hitId = stage.sculptureAtPoint(x, y);
  if (hitId != null) {
    stage.selectSculpture(hitId);
    interactionMode = "drag";
    dragAnchor = { x, y };
    const sel = stage.getSelected();
    dragBeforeImageXY = sel ? { imageX: sel.position.imageX, imageY: sel.position.imageY } : null;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("cursor-grabbing");
    syncToggles();
  } else {
    stage.selectSculpture(null);
    syncToggles();
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (interactionMode !== "drag" || !dragAnchor) return;
  const { x, y } = stage.eventToCanvas(e);
  stage.moveSelectedBy(x - dragAnchor.x, y - dragAnchor.y);
  dragAnchor = { x, y };
});

// Right-click on a sculpture removes it (and pushes to undo so the delete
// can be reversed with Ctrl+Z or the Undo button).
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!stage.hasCalibration()) return;
  const { x, y } = stage.eventToCanvas(e);
  const hitId = stage.sculptureAtPoint(x, y);
  if (hitId == null) return;
  const removed = stage.removeSculpture(hitId);
  if (removed) pushUndo({ kind: "delete", sculpture: removed.sculpture, index: removed.index });
  syncToggles();
});

canvas.addEventListener("pointerup", (e) => {
  if (interactionMode === "drag") {
    canvas.releasePointerCapture(e.pointerId);
    canvas.classList.remove("cursor-grabbing");
    interactionMode = "idle";
    dragAnchor = null;
    const sel = stage.getSelected();
    if (sel && dragBeforeImageXY) {
      const moved = Math.hypot(
        sel.position.imageX - dragBeforeImageXY.imageX,
        sel.position.imageY - dragBeforeImageXY.imageY,
      );
      if (moved > 1) {
        pushUndo({
          kind: "move", id: sel.id,
          from: dragBeforeImageXY,
          to: { imageX: sel.position.imageX, imageY: sel.position.imageY },
        });
      }
    }
    dragBeforeImageXY = null;
  }
});

// --- readouts ------------------------------------------------------------

function updateReadouts() {
  const c = stage.state.calibration;
  const el = document.getElementById("scale-readout");
  const perspEl = document.getElementById("persp-refs-readout");
  if (c.mode === "uniform" && c.pixelsPerFoot) {
    el.textContent = `Calibrated: ${c.pixelsPerFoot.toFixed(1)} px / ft`;
    el.classList.add("calibrated");
  } else if (c.mode === "perspective" && c.refs.length) {
    el.textContent = `Perspective: ${c.refs.length} reference${c.refs.length > 1 ? "s" : ""}`;
    el.classList.add("calibrated");
  } else {
    el.textContent = "Not calibrated yet.";
    el.classList.remove("calibrated");
  }
  if (perspEl) {
    perspEl.textContent = c.mode === "perspective" && c.refs.length
      ? c.refs.map((r, i) =>
          `ref ${i + 1}: ${r.pixelsPerFoot.toFixed(1)} px/ft @ y=${Math.round(r.imageY)}`).join("  •  ")
      : "No references yet.";
  }
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

// Mirror the selected sculpture's flip/shadow state onto the toggles.
function syncToggles() {
  const sel = stage.getSelected();
  if (!sel) return;
  flipToggle.checked = !!sel.flip;
  shadowToggle.checked = !!sel.shadow;
}

async function onSculpturePick(item) {
  selectedCatalogItem = item;
  if (!stage.hasCalibration()) return;
  try {
    const source = await loadSource(item, sourceKindSelect.value);
    const entry = stage.addSculpture(item, source);
    entry.flip = flipToggle.checked;
    entry.shadow = shadowToggle.checked;
    pushUndo({ kind: "add", id: entry.id });
    enableCard("export");
    setStep(4);
  } catch (err) {
    console.error(err);
    alert(`Could not load sculpture: ${err.message}`);
  }
}

// --- delete + undo -------------------------------------------------------

const btnDelete = document.getElementById("btn-delete-selected");
const btnUndo = document.getElementById("btn-undo");

btnDelete.addEventListener("click", () => {
  const sel = stage.getSelected();
  if (!sel) return;
  const removed = stage.removeSculpture(sel.id);
  if (removed) pushUndo({ kind: "delete", sculpture: removed.sculpture, index: removed.index });
  syncToggles();
});

function undoLast() {
  const last = undoStack.pop();
  updateUndoButton();
  if (!last) return;
  if (last.kind === "add") {
    stage.removeSculpture(last.id);
  } else if (last.kind === "delete") {
    stage.restoreSculpture(last.sculpture, last.index);
  } else if (last.kind === "move") {
    const s = stage.state.sculptures.find((x) => x.id === last.id);
    if (s) { s.position.imageX = last.from.imageX; s.position.imageY = last.from.imageY; }
  }
  syncToggles();
}

btnUndo.addEventListener("click", undoLast);

// Ctrl+Z / Cmd+Z — ignore if the user is typing in an input/textarea/select.
window.addEventListener("keydown", (e) => {
  if (!(e.key === "z" || e.key === "Z") || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  undoLast();
});

function updateUndoButton() {
  btnUndo.disabled = undoStack.length === 0;
  document.getElementById("undo-count").textContent = undoStack.length ? String(undoStack.length) : "";
}
updateUndoButton();

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
