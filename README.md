# Wind Sculpture Visualizer

A browser-only tool that composites your wind sculpture MP4/GIF onto a customer's landscape photo at correct physical scale.

All rendering happens in the customer's browser. No backend. No photo ever leaves their machine.

## Quick start

```bash
cd wind-sculpture-visualizer
npm install
npm run dev
# open http://localhost:3000
```

## How it works

1. **Upload** a landscape photo (JPG/PNG).
2. **Calibrate scale** — two ways:
   - **Click 2 points**: click any two points you know the real distance between (e.g. top & bottom of a 6ft fence), then type the real distance.
   - **Preset reference**: pick a common object from the list (6ft person, 7ft door, 8ft fence, custom) and drag its height on the image.
   Both produce `pixels/ft`, which the app uses to size every sculpture correctly.
3. **Pick a sculpture** from the catalog. It's drawn at `heightFeet × pixelsPerFoot`. Drag it to reposition.
4. **Export**:
   - **PNG** / **JPG** still image of the current frame.
   - **MP4 / WebM** video — records the animated canvas for the chosen duration using `MediaRecorder`. Browsers that support MP4 in MediaRecorder (Safari, recent Chrome) will save MP4; others save WebM.

## Adding a new sculpture to the catalog

1. Drop your files into `catalog/`:
   - `my-sculpture.mp4` — animated video
   - `my-sculpture.gif` — transparent GIF fallback
   - `thumbs/my-sculpture.png` — optional thumbnail
2. Add an entry to `catalog/manifest.json`:
   ```json
   {
     "id": "my-sculpture",
     "name": "My Sculpture",
     "heightFeet": 8.0,
     "widthFeet": 2.5,
     "mp4": "my-sculpture.mp4",
     "gif": "my-sculpture.gif",
     "mp4HasAlpha": false,
     "chromaKey": null,
     "thumb": "thumbs/my-sculpture.png"
   }
   ```
3. Refresh the page. Done — no code changes.

### About transparency

- **GIF**: transparency is native. If your GIF is already transparent, nothing to do.
- **MP4**: standard MP4 (H.264) has no alpha channel. You have three options:
  - If your MP4 was rendered with alpha (HEVC-with-alpha or VP9-in-WebM), set `"mp4HasAlpha": true`.
  - If the MP4 has a solid background color, set `"chromaKey": "#00b140"` (or whatever color) — the app will remove pixels near that color. Tune the tolerance in `js/composite.js` if needed.
  - Or just use the GIF (`"Source: Transparent GIF"` in the UI).

## Hosting later

It's a pure static site (`index.html`, `css/`, `js/`, `catalog/`). You can host it anywhere:

- **Netlify / Vercel / Cloudflare Pages / GitHub Pages** — drag the folder in or point at the repo.
- **Any web server** — serve the folder.
- **Shopify** — upload `catalog/` files and JS bundle; embed as an iframe or custom page.
- **Wrapped in Node** — drop the folder into any Express app under `express.static()`.

No code changes required.

## File layout

```
wind-sculpture-visualizer/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js           # Controller — UI events + state
│   ├── scale.js         # pixels/ft math + unit conversion
│   ├── composite.js     # Canvas render loop, layout, chroma-key
│   ├── recorder.js      # PNG/JPG/MP4/WebM export
│   └── catalog.js       # Loads manifest + builds picker
├── catalog/
│   ├── manifest.json
│   ├── *.mp4
│   ├── *.gif
│   └── thumbs/*.png
├── package.json
└── README.md
```

## Browser support

- Chrome, Edge, Firefox, Safari (latest).
- Video export uses `MediaRecorder`; older Safari versions may refuse and the button will error.
- The MP4 codec in `MediaRecorder` is browser-dependent — WebM is the reliable fallback.

## Known limitations (deliberate, not bugs)

- One sculpture per scene.
- No perspective / ground-plane tilt.
- No persistent storage (everything is in-browser session state).
- No user accounts.

These are all easy to add later if you want them.
