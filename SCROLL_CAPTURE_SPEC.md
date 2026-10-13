# CheeseIt — Scroll Capture Feature Specification & Implementation Plan

## 1. Overview

CheeseIt currently captures screenshots strictly from the visible viewport (`chrome.tabs.captureVisibleTab`) either once or after/before replaying macro events.

This specification introduces a **Scroll Capture Engine** that systematically scrolls through a page (or a designated scrollable container) and captures the entire length without overlapping content. It operates both as an independent capture tool (when macros are disabled) and as a modular capture step within macro replay loops.

---

## 2. Architecture: Macro Engine vs. Capture Engine

The core principle is strict separation between **When/Where to Act** (Macro) and **How to Capture** (Capture Engine).

```mermaid
flowchart TD
    Trigger([Trigger Run / Play]) --> MacroCheck{Macro Enabled?}
    
    MacroCheck -- No --> CaptureEngine
    MacroCheck -- Yes --> TimingCheck{Capture Timing?}
    
    TimingCheck -- "Capture First" --> CaptureEngine
    CaptureEngine --> MacroReplay[Execute Macro Actions: Clicks / Keys]
    MacroReplay --> RestoreTop1[Restore Scroll: scrollTo(0,0)]
    RestoreTop1 --> Finish([Done])
    
    TimingCheck -- "Capture After" --> MacroReplay2[Execute Macro Actions: Clicks / Keys]
    MacroReplay2 --> CaptureEngine2[Capture Engine]
    CaptureEngine2 --> RestoreTop2[Restore Scroll: scrollTo(0,0)]
    RestoreTop2 --> Finish2([Done])

    subgraph CaptureEngine [Unified Capture Engine: performCapture()]
        ModeSwitch{captureMode}
        ModeSwitch -- "single" --> SingleCap[Standard Viewport Capture]
        ModeSwitch -- "scroll_slice" --> ScrollSlice[Sequential Non-Overlapping Slices]
        ModeSwitch -- "scroll_stitch" --> ScrollStitch[Stitched Continuous Long Strip]
    end
```

---

## 3. Capture Modes Defined

### Mode A: Sequential Slices (`scroll_slice`) — *Primary Default*
- **Behavior:** Step-scrolls down the page by exact viewport height ($H$), snapping each segment as an independent image (`filename_001.png`, `filename_002.png`, etc.).
- **No Overlap Handling:** For the final slice where the remaining distance $R < H$:
  - The script scrolls down the remaining $R$ pixels.
  - The cropping logic trims the top $(H - R)$ pixels off the last frame, ensuring **0px duplicated content** across consecutive slice files.
- **Advantages:** No `<canvas>` memory limits, works for arbitrarily long pages (e.g., 50,000px+ feeds), optimal for OCR, documentation, and paginated assets.

### Mode B: Stitched Long Strip (`scroll_stitch`)
- **Behavior:** Executes the same non-overlapping scroll sequence, but composites the cropped chunks into a single tall `OffscreenCanvas` and downloads one combined `.png`.
- **Constraint Management:** Validates total height against browser canvas boundaries (typically 16,384px or 32,768px). If exceeded, falls back cleanly to sliced output.

---

## 4. State Model Updates

In [background.js](file:///c:/DEV/auto-capture-extension/background.js), extend `state`:

```javascript
let state = {
  // Existing state
  isRecording: false,
  isPlaying: false,
  isSelectingArea: false,
  captureRect: null,
  captureRatio: 'full',
  prefix: '',
  actions: [],
  captureFirst: false,
  macroEnabled: false,
  savedRecordings: {},

  // New Scroll Capture State
  captureMode: 'single',        // 'single' | 'scroll_slice' | 'scroll_stitch'
  scrollDelay: 250,             // ms to wait after each scroll step (render/lazy load settle)
  hideStickyElements: true,     // whether to temporarily suppress fixed/sticky headers
  scrollTarget: 'window'        // 'window' | 'container'
};
```

---

## 5. Implementation Breakdown

### 5.1 Popup UI Layer (`popup.html` & `popup.js`)

1. **Capture Mode Selector:**
   Add a segmented button group or dropdown under the capture settings:
   - **Single Viewport** (`single`)
   - **Scroll Slices** (`scroll_slice`)
   - **Stitched Long Strip** (`scroll_stitch`)

2. **Settings Section Additions:**
   - **Scroll Settle Delay (ms):** Number input (default: 250ms, min: 100ms, max: 2000ms) for pages with lazy-loaded images or animations.
   - **Hide Sticky / Fixed Elements:** Toggle checkbox (default: `true`) to avoid repeated headers across slices.

3. **Internationalization (`i18n.js`):**
   Add keys for `captureMode`, `modeSingle`, `modeScrollSlice`, `modeScrollStitch`, `scrollDelayLabel`, and `hideStickyLabel` for English and Korean.

---

### 5.2 Content Script (`content.js`) Helpers

The content script handles DOM-level viewport measurement, scrolling, and sticky header suppression:

```javascript
// Measure page or container dimensions
function getScrollMetrics() {
  const doc = document.documentElement;
  return {
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    totalHeight: Math.max(doc.scrollHeight, document.body.scrollHeight),
    currentScrollY: window.scrollY || window.pageYOffset,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

// Perform instant scroll to exact coordinate
function scrollToPosition(y) {
  window.scrollTo({ top: y, left: 0, behavior: 'instant' });
}

// Suppress sticky / fixed elements during middle slices
let suppressedElements = [];

function suppressStickyHeaders(enable) {
  if (enable) {
    suppressedElements = [];
    const elements = document.querySelectorAll('*');
    for (const el of elements) {
      const pos = window.getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'sticky') && el.getBoundingClientRect().top < 120) {
        suppressedElements.push({ el, origVisibility: el.style.visibility });
        el.style.visibility = 'hidden';
      }
    }
  } else {
    for (const item of suppressedElements) {
      item.el.style.visibility = item.origVisibility;
    }
    suppressedElements = [];
  }
}
```

---

### 5.3 Background Service Worker (`background.js`) Logic

#### A. Unified Capture Dispatcher
Replace direct calls to `captureScreenshot(...)` with `performCapture(...)`:

```javascript
async function performCapture(tabs, tabId, prefix) {
  if (state.captureMode === 'scroll_slice' || state.captureMode === 'scroll_stitch') {
    await captureScrollingContent(tabs, tabId, prefix, state.captureMode);
  } else {
    await captureScreenshot(tabs, tabId, prefix);
  }
}
```

#### B. Scroll Capture Loop Algorithm

```javascript
async function captureScrollingContent(tabs, tabId, prefix, mode) {
  // 1. Get initial scroll metrics from page
  const metrics = await chrome.tabs.sendMessage(tabId, { command: 'getScrollMetrics' });
  const viewportH = metrics.windowHeight;
  const totalH = metrics.totalHeight;
  const initialY = metrics.currentScrollY;

  let currentY = 0;
  let sliceIndex = 0;
  const capturedBitmaps = [];

  // Hide selection overlay if active
  await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});

  try {
    while (currentY < totalH && state.isPlaying) {
      sliceIndex++;
      const isFirst = (currentY === 0);
      const isLast = (currentY + viewportH >= totalH);

      // Scroll to current position
      await chrome.tabs.sendMessage(tabId, { command: 'scrollToPosition', y: currentY });

      // Suppress sticky headers on middle/last slices if option enabled
      if (state.hideStickyElements && !isFirst) {
        await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyHeaders', enable: true });
      }

      // Allow DOM layout and lazy images to settle
      await sleep(state.scrollDelay || 250);

      // Capture visible tab
      let dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' });

      // Handle overlap prevention on last slice
      const remainingHeight = totalH - currentY;
      let finalSliceDataUrl = dataUrl;

      if (remainingHeight < viewportH) {
        // Last partial chunk: crop out the duplicated top portion
        const cropY = viewportH - remainingHeight;
        finalSliceDataUrl = await cropSliceOverlap(dataUrl, cropY, remainingHeight, metrics.devicePixelRatio);
      }

      // If cropping to user selection rect
      if (state.captureRect) {
        finalSliceDataUrl = await cropImage(finalSliceDataUrl, state.captureRect);
      }

      if (mode === 'scroll_slice') {
        // Save as sequential slice file
        captureCount++;
        const filename = `${prefix}_${captureCount.toString().padStart(3, '0')}.png`;
        const filePath = currentSubfolder ? `${currentSubfolder}/${filename}` : filename;
        await chrome.downloads.download({ url: finalSliceDataUrl, filename: filePath, saveAs: false });
      } else {
        // Collect for stitching
        capturedBitmaps.push(await dataUrlToBitmap(finalSliceDataUrl));
      }

      if (isLast) break;
      currentY += viewportH;
    }

    // If stitched mode, combine bitmaps into one image
    if (mode === 'scroll_stitch' && capturedBitmaps.length > 0 && state.isPlaying) {
      const stitchedDataUrl = await stitchBitmaps(capturedBitmaps);
      captureCount++;
      const filename = `${prefix}_stitched_${captureCount.toString().padStart(3, '0')}.png`;
      const filePath = currentSubfolder ? `${currentSubfolder}/${filename}` : filename;
      await chrome.downloads.download({ url: stitchedDataUrl, filename: filePath, saveAs: false });
    }

  } finally {
    // Clean up: Restore sticky elements, selection box, and scroll position
    if (state.hideStickyElements) {
      await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyHeaders', enable: false }).catch(() => {});
    }
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    }
    // Crucial for macro continuity: return to top of page
    await chrome.tabs.sendMessage(tabId, { command: 'scrollToPosition', y: 0 });
  }
}
```

---

## 6. Edge Cases & Solutions

| Edge Case | Impact | Solution |
| :--- | :--- | :--- |
| **Sticky Navigation Bars** | Repeated at the top of every slice image. | Temporarily set `visibility: hidden` on elements with `position: fixed/sticky` positioned near the top during slices 2..N. |
| **Partial Final Slice** | Page height is not an exact multiple of viewport height; bottom section overlaps with previous slice. | Calculate $R = \text{TotalHeight} - \text{CurrentY}$. Crop out the top $(H - R)$ pixels so consecutive images meet seamlessly edge-to-edge. |
| **Macro Coordinate Drift** | Clicking relies on $(X, Y)$ relative to the original scroll position. | Always call `window.scrollTo(0, 0)` in `finally` block when scroll capture completes before continuing to next macro step. |
| **Lazy Loading Images** | Images appear blank/low-res if captured immediately after scrolling. | Configurable settle delay (`scrollDelay`, default 250ms) between scroll and snapshot. |
| **Canvas Dimensions** | Extreme page heights (>16k/32k px) fail silently in `<canvas>`. | Default to `scroll_slice`. In `scroll_stitch`, check total height against canvas capability; auto-split if exceeded. |

---

## 7. Delivery Checklist

- [ ] **UI:** Add capture mode toggles (`Single`, `Slice Strip`, `Stitched`) and scroll settle delay in `popup.html` and `popup.css`.
- [ ] **i18n:** Add localization strings to `i18n.js`.
- [ ] **Content Script:** Add scroll measurement, precise step scrolling, and sticky header suppression in `content.js`.
- [ ] **Background:** Refactor `captureScreenshot` callers to `performCapture`, implement `captureScrollingContent` with zero-overlap slicing and canvas stitching in `background.js`.
- [ ] **Testing:** Test on infinite feeds, standard documentation pages, and within macro replay sequences.
