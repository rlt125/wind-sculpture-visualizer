// Catalog loader.
//
// Reads catalog/manifest.json, renders the thumbnail grid, and resolves an
// entry to a media source (<video> for MP4, decoded GIF canvas, or <img>
// for static PNG/JPG) on demand.

import { loadAnimatedGif } from "./gif-player.js";

function formatFeetInches(decimalFeet) {
  const ft = Math.floor(decimalFeet);
  const inches = Math.round((decimalFeet - ft) * 12);
  if (inches === 12) return `${ft + 1}′0″`;
  return inches === 0 ? `${ft}′` : `${ft}′${inches}″`;
}

export async function loadCatalog() {
  const res = await fetch("catalog/manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load catalog: ${res.status}`);
  return res.json();
}

export const DRAG_MIME = "application/x-wind-sculpture-id";

export function renderCatalogGrid(container, items, onSelect) {
  container.innerHTML = "";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "catalog-item";
    el.dataset.id = item.id;
    el.draggable = true;

    el.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(DRAG_MIME, item.id);
      e.dataTransfer.setData("text/plain", item.name);
      e.dataTransfer.effectAllowed = "copy";
    });

    let thumb;
    if (item.thumb) {
      thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.alt = item.name;
      thumb.src = `catalog/${item.thumb}`;
      thumb.draggable = false; // let the outer div own the drag
      thumb.onerror = () => {
        const fb = document.createElement("div");
        fb.className = "thumb-fallback";
        fb.textContent = "No preview";
        el.replaceChild(fb, thumb);
      };
    } else {
      thumb = document.createElement("div");
      thumb.className = "thumb-fallback";
      thumb.textContent = "No preview";
    }
    el.appendChild(thumb);

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.name;
    el.appendChild(name);

    const size = document.createElement("div");
    size.className = "size";
    const h = formatFeetInches(item.heightFeet);
    const w = item.widthFeet ? ` × ${formatFeetInches(item.widthFeet)} w` : "";
    size.textContent = `${h} h${w}`;
    el.appendChild(size);

    if (item.price != null) {
      const price = document.createElement("div");
      price.className = "price";
      price.textContent = `$${item.price.toLocaleString()}`;
      el.appendChild(price);
    }

    el.addEventListener("click", () => {
      container.querySelectorAll(".catalog-item").forEach((c) => c.classList.remove("selected"));
      el.classList.add("selected");
      onSelect(item);
    });
    container.appendChild(el);
  });
}

// Load a playable media element for the given catalog entry + source preference.
// Returns { kind: "mp4"|"gif", el }. `kind: "gif"` is used for both animated
// GIFs and static PNG/JPEG (composite.js only cares about naturalWidth/Height,
// which our GIF-player canvas and a plain <img> both expose).
export async function loadSource(item, preference) {
  const wantMp4 = preference === "mp4" || (preference === "auto" && !!item.mp4);
  if (wantMp4 && item.mp4) {
    try {
      const video = await loadVideo(`catalog/${item.mp4}`);
      return { kind: "mp4", el: video };
    } catch (err) {
      console.warn("MP4 failed, falling back to still/GIF:", err);
    }
  }
  const src = item.gif || item.image;
  if (src) {
    const url = `catalog/${src}`;
    if (/\.gif$/i.test(src)) {
      const canvas = await loadAnimatedGif(url);
      return { kind: "gif", el: canvas };
    }
    const img = await loadStaticImage(url);
    return { kind: "gif", el: img };
  }
  throw new Error(`Catalog entry ${item.id} has no playable source`);
}

function loadStaticImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${url}`));
    img.src = url;
  });
}

function loadVideo(src) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.src = src;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    v.addEventListener("loadeddata", () => {
      v.play().then(() => resolve(v)).catch(reject);
    }, { once: true });
    v.addEventListener("error", () => reject(new Error(`Video load failed: ${src}`)), { once: true });
  });
}

