// Catalog loader.
//
// Reads catalog/manifest.json, renders the thumbnail grid, and resolves an
// entry to a media source (<video> for MP4, <img> for GIF) on demand.

export async function loadCatalog() {
  const res = await fetch("catalog/manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load catalog: ${res.status}`);
  return res.json();
}

export function renderCatalogGrid(container, items, onSelect) {
  container.innerHTML = "";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "catalog-item";
    el.dataset.id = item.id;

    let thumb;
    if (item.thumb) {
      thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.alt = item.name;
      thumb.src = `catalog/${item.thumb}`;
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
    size.textContent = `${item.heightFeet} ft`;
    el.appendChild(size);

    el.addEventListener("click", () => {
      container.querySelectorAll(".catalog-item").forEach((c) => c.classList.remove("selected"));
      el.classList.add("selected");
      onSelect(item);
    });
    container.appendChild(el);
  });
}

// Load a playable media element for the given catalog entry + source preference.
// Returns { kind: "mp4"|"gif", el }. Falls back to GIF if MP4 can't be loaded.
export async function loadSource(item, preference) {
  const wantMp4 = preference === "mp4" || (preference === "auto" && !!item.mp4);
  if (wantMp4 && item.mp4) {
    try {
      const video = await loadVideo(`catalog/${item.mp4}`);
      return { kind: "mp4", el: video };
    } catch (err) {
      console.warn("MP4 failed, falling back to GIF:", err);
    }
  }
  if (item.gif) {
    const img = await loadImage(`catalog/${item.gif}`);
    return { kind: "gif", el: img };
  }
  throw new Error(`Catalog entry ${item.id} has no playable source`);
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Image load failed: ${src}`));
    img.src = src;
  });
}
