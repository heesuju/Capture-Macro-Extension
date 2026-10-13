# CheeseIt — Zoom Grid Capture Feature Specification & Implementation Plan

## 1. Overview

This introduces a second advanced capture mode alongside the scroll capture engine described in SCROLL_CAPTURE_SPEC.md. Where scroll capture tiles the page vertically at native resolution, Zoom Grid Capture tiles the page (or a selected area) in both dimensions at increased pixel density, using Chrome's page-zoom API to push more raster pixels per CSS pixel into each captureVisibleTab call, then stitches the grid into one very high-resolution image.

This is not scrolling. The page (or selection) stays where it is; the zoom level increases so each tile captures a smaller slice of CSS content at higher density, and enough tiles are taken to cover the full target area with zero overlap.

---

## 2. Why This Works

chrome.tabs.captureVisibleTab rasterizes at window.innerWidth/Height * devicePixelRatio physical pixels — it can never exceed the current physical viewport, regardless of format or quality settings. devicePixelRatio is normally fixed by the monitor. chrome.tabs.setZoom(tabId, factor) is the only extension-accessible way to raise it: setting zoom to factor reports devicePixelRatio = nativeDPR * factor, so each tile is rendered factor times sharper per CSS pixel. Capturing a full grid of these tiles and stitching them yields an image with far more total pixels — and far crisper text/lines — than any single capture, or than upscaling a normal capture after the fact.

The catch, and the fix: chrome.tabs.setZoom is page zoom, the same mechanism as Ctrl+/Ctrl-. It works by shrinking how many CSS pixels fit in the layout viewport (window.innerWidth genuinely gets smaller), which means CSS media queries re-evaluate against a smaller viewport and a responsive page can silently flip into a different layout mid-capture. The fix is to resize the actual browser window's physical dimensions by the same factor before zooming, which cancels the CSS-side shrinkage out exactly. See Section 6.1.

---

## 3. Capture Mode Defined

### Mode C: Zoom Grid (zoom_grid)
- Behavior: Resizes the browser window and sets tab zoom to the configured quality multiplier, then steps across the target area (full page or captureRect) in a 2D grid — first along X, then Y — capturing one tile per cell with zero overlap. Tiles are cropped to remove any remainder overlap on the last row/column, then composited into a single OffscreenCanvas and downloaded as one image (falling back to sliced tile files if canvas size limits are exceeded, same as scroll_stitch).
- No Overlap Handling: Same remainder-cropping logic as SCROLL_CAPTURE_SPEC.md section 3 Mode A, applied independently on both the X and Y axes.
- Advantages: Produces the highest-fidelity possible capture of a page or region — useful for print, large-format export, or archival quality where the standard single/scroll capture's resolution (capped at native devicePixelRatio) is insufficient.
- Cost: Slower (more tiles, captureVisibleTab rate-limited to ~2/sec) and only safe up to a bounded quality multiplier before window-resize limits are hit (Section 6.1).

---

## 4. State Model Updates

Extend state in background.js:

```javascript
let state = {
  // ...existing fields, including captureMode: 'single' | 'scroll_slice' | 'scroll_stitch' | 'zoom_grid'

  // New Zoom Grid Capture State
  zoomQualityMultiplier: 2,     // 2 | 3 | 4 -- user-facing "quality" knob, maps to chrome.tabs.setZoom factor
  zoomSettleDelay: 300,         // ms to wait after each zoom/scroll step before capture
  zoomLayoutGuard: true         // if true, auto-abort/fallback when a reflow is detected (Section 6.1)
};
```

zoomQualityMultiplier is presented to the user as a multiplier ("2x / 3x / 4x sharper"), not a raw zoom percentage — see Section 7.

---

## 5. Implementation Breakdown

### 5.1 Popup UI Layer (popup.html & popup.js)
1. Add zoom_grid as a third option in the capture mode selector (alongside single, scroll_slice, scroll_stitch once those land).
2. Settings section: Quality Multiplier (segmented control: 2x / 3x / 4x, default 2x) shown only when zoom_grid is selected.
3. i18n keys: modeZoomGrid, qualityMultiplierLabel, zoomLayoutWarning (shown when the layout guard trips).

### 5.2 Content Script (content.js) Helpers

```javascript
// Snapshot a layout fingerprint to detect reflow after zoom/resize
function getLayoutFingerprint() {
  const doc = document.documentElement;
  return {
    scrollWidth: doc.scrollWidth,
    scrollHeight: doc.scrollHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight
  };
}

// Scroll both axes to an exact coordinate (grid capture needs X too, not just Y)
function scrollToGridPosition(x, y) {
  window.scrollTo({ top: y, left: x, behavior: 'instant' });
}
```

Reuses suppressStickyHeaders from the scroll capture spec unchanged — fixed/sticky elements are suppressed the same way, just checked against left/top proximity instead of only top.

### 5.3 Background Service Worker (background.js) Logic

#### A. Window/Zoom Setup (the reflow fix — see Section 6.1)

```javascript
async function enterZoomGridMode(windowId, tabId, multiplier) {
  const win = await chrome.windows.get(windowId);
  const original = { width: win.width, height: win.height, left: win.left, top: win.top };

  // Grow the physical window by the same factor we're about to zoom by,
  // so CSS innerWidth/innerHeight stay mathematically unchanged.
  await chrome.windows.update(windowId, {
    width: Math.round(original.width * multiplier),
    height: Math.round(original.height * multiplier)
  });

  await chrome.tabs.setZoom(tabId, multiplier);

  return original; // caller restores this in finally
}

async function exitZoomGridMode(windowId, tabId, original) {
  await chrome.tabs.setZoom(tabId, 0); // 0 resets to the page's default zoom
  await chrome.windows.update(windowId, original);
}
```

#### B. 2D Grid Capture Loop

```javascript
async function captureZoomGrid(tabs, tabId, prefix) {
  const windowId = tabs[0].windowId;
  const multiplier = state.zoomQualityMultiplier;

  const before = await chrome.tabs.sendMessage(tabId, { command: 'getLayoutFingerprint' });
  const original = await enterZoomGridMode(windowId, tabId, multiplier);

  try {
    await sleep(state.zoomSettleDelay || 300);

    if (state.zoomLayoutGuard) {
      const after = await chrome.tabs.sendMessage(tabId, { command: 'getLayoutFingerprint' });
      if (after.innerWidth !== before.innerWidth || after.innerHeight !== before.innerHeight) {
        // Window resize didn't fully offset the zoom (e.g. hit screen bounds) -- abort rather
        // than silently capture a reflowed layout.
        throw new Error('zoom_grid_layout_mismatch');
      }
    }

    const metrics = await chrome.tabs.sendMessage(tabId, { command: 'getScrollMetrics' });
    const tileW = metrics.windowWidth;   // CSS px per tile, unchanged from pre-zoom
    const tileH = metrics.windowHeight;
    const totalW = metrics.totalWidth;   // full page width (or captureRect width)
    const totalH = metrics.totalHeight;

    const bitmapRows = [];

    for (let y = 0; y < totalH; y += tileH) {
      const rowBitmaps = [];
      const remH = totalH - y;
      const cropTop = remH < tileH ? tileH - remH : 0;

      for (let x = 0; x < totalW; x += tileW) {
        const remW = totalW - x;
        const cropLeft = remW < tileW ? tileW - remW : 0;

        await chrome.tabs.sendMessage(tabId, { command: 'scrollToGridPosition', x, y });
        if (state.hideStickyElements && (x > 0 || y > 0)) {
          await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyHeaders', enable: true });
        }
        await sleep(state.zoomSettleDelay || 300);

        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        const tile = await cropTile(dataUrl, cropLeft, cropTop, metrics.devicePixelRatio * multiplier);
        rowBitmaps.push(tile);
      }
      bitmapRows.push(await stitchRowHorizontal(rowBitmaps));
    }

    const stitched = await stitchRowsVertical(bitmapRows); // falls back to per-row files if over canvas limits
    captureCount++;
    const filename = `${prefix}_zoomgrid_${captureCount.toString().padStart(3, '0')}.png`;
    await chrome.downloads.download({ url: stitched, filename, saveAs: false });

  } finally {
    if (state.hideStickyElements) {
      await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyHeaders', enable: false }).catch(() => {});
    }
    await chrome.tabs.sendMessage(tabId, { command: 'scrollToGridPosition', x: 0, y: 0 }).catch(() => {});
    await exitZoomGridMode(windowId, tabId, original).catch(() => {});
  }
}
```

---

## 6. Edge Cases & Solutions

| Edge Case | Impact | Solution |
| :--- | :--- | :--- |
| 6.1 Zoom is not pure magnification | chrome.tabs.setZoom shrinks the CSS layout viewport, which can cross responsive breakpoints and capture a different layout than intended. | Resize the physical browser window by the same multiplier before zooming, canceling the CSS-viewport shrinkage exactly (Section 5.3A). Verify with a before/after layout fingerprint (getLayoutFingerprint); abort or fall back to a lower multiplier if it doesn't match — e.g. because the window couldn't grow that large on a small display. |
| Window resize hits screen/OS bounds | On a small display, resizing to original * multiplier may exceed available screen space, so the compensating resize is incomplete and some CSS shrinkage leaks through. | Clamp zoomQualityMultiplier to what the current display allows (chrome.system.display.getInfo()); disable multipliers that don't fit and surface zoomLayoutWarning in the UI. |
| 2D sticky elements | Fixed/sticky headers and sidebars repeat across every tile in both directions, not just the top row. | Extend suppressStickyHeaders to suppress on any tile where x > 0 or y > 0, not just non-first rows. |
| captureVisibleTab rate limit | Chrome allows ~2 calls/sec; a 2x-4x grid can have dozens of tiles, easily triggering throttling errors. | Enforce zoomSettleDelay (>=300ms) as a hard floor between captures; queue and retry on rate-limit errors instead of failing the whole run. |
| Canvas size limits | Total stitched pixel count grows roughly with the square of the multiplier, making the 16k/32k canvas ceiling much easier to hit than in scroll capture. | Reuse the scroll_stitch fallback: if projected canvas dimensions exceed the limit, save per-row or per-tile files instead of one stitched image. |
| Macro coordinate drift | Any macro clicks are recorded against the un-zoomed page. | zoom_grid should only run as a standalone capture (not inside macro replay loops) — restore zoom, window size, and scroll position in finally regardless. |

---

## 7. UI Framing: Multiplier, Not Raw Zoom %

Expose zoomQualityMultiplier as a capped set of choices (2x / 3x / 4x) rather than a free-form zoom percentage input. Two reasons: (1) users think in "how much sharper," not zoom level; (2) each option can be independently validated against chrome.system.display.getInfo() and disabled if the current window/display can't support the compensating resize from Section 6.1, which a free-text percentage field can't do.

---

## 8. Delivery Checklist

- [ ] UI: Add zoom_grid mode option and Quality Multiplier control in popup.html/popup.js, disabling multipliers the current display can't support.
- [ ] i18n: Add modeZoomGrid, qualityMultiplierLabel, zoomLayoutWarning.
- [ ] Content Script: Add getLayoutFingerprint, scrollToGridPosition, extend suppressStickyHeaders for 2D tiles.
- [ ] Background: Implement enterZoomGridMode/exitZoomGridMode (window-resize + zoom pairing), captureZoomGrid 2D tiling loop, row/column overlap cropping, and canvas-limit fallback.
- [ ] Testing: Test against a responsive site with a real breakpoint near the default window width, to confirm the layout guard correctly detects/blocks a reflow when the compensating resize can't fully apply (e.g. small display).
