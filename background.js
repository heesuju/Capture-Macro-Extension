importScripts('pdf-lib.min.js');

let state = {
  isRecording: false,
  isPlaying: false,
  isSelectingArea: false,
  captureRect: null,
  prefix: '',
  actions: [],
  captureFirst: true,
  macroEnabled: false,
  savedRecordings: {},
  activeRecordingName: '',
  createPdf: true,
  captureMode: 'single', // 'single' | 'scroll' | 'zoom'
  zoomMultiplier: 2       // 2 | 3 | 4 -- resolution multiplier for zoom mode
};

const ZOOM_ATTACH_SETTLE_DELAY = 300; // ms for the page to repaint after the debugger bar appears
const ZOOM_TILE_PX = 4096; // max output px per side of one zoom screenshot tile
const MAX_ZOOM_DIM = 32000; // max zoom output px per side (canvas dimension limit is 32767)
const MAX_ZOOM_AREA = 64000000; // max zoom output px, keeps canvas memory ~256MB
const SCROLL_SETTLE_DELAY = 250; // ms to let lazy content/repaints settle after each scroll step
const MAX_STRIP_HEIGHT = 32000; // px per stitched strip file (canvas dimension limit is 32767)
const MAX_STRIP_AREA = 64000000; // px per stitched strip file, keeps canvas memory ~256MB
const MAX_STRIP_TILES = 200; // safety stop for infinite feeds that keep growing
const CAPTURE_MIN_INTERVAL = 550; // captureVisibleTab is capped at 2 calls/sec
const PDF_MAX_PAGE_DIM = 14400; // PDF spec limit for a page side, in points

chrome.storage.local.get(['savedRecordings'], (result) => {
  if (result.savedRecordings) {
    state.savedRecordings = result.savedRecordings;
  }
});

let lastActionTime = 0;
let captureCount = 0;
let sessionPrefix = '';
let currentSubfolder = '';
let sessionCaptures = []; // { dataUrl, width, height } for PDF generation

function getTodayDateKey() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

async function getNextRunSubfolder() {
  const today = getTodayDateKey();
  const data = await chrome.storage.local.get(['runDate', 'runIndex']);
  let nextIndex = 1;
  if (data && data.runDate === today && typeof data.runIndex === 'number') {
    nextIndex = data.runIndex + 1;
  }
  await chrome.storage.local.set({ runDate: today, runIndex: nextIndex });
  return `${today}_${nextIndex}`;
}

function updateBadge() {
  if (state.isRecording) {
    chrome.action.setBadgeBackgroundColor({ color: '#e94560' });
    // No glyph while idle-recording — a bare space renders as a plain red dot,
    // avoiding off-center symbol glyphs. Digits center fine once actions exist.
    chrome.action.setBadgeText({ text: state.actions.length > 0 ? String(state.actions.length) : ' ' });
  } else if (state.isPlaying) {
    chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    chrome.action.setBadgeText({ text: ' ' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function broadcastState() {
  updateBadge();
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

function generateRecordingName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `Recording ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let name = base;
  let suffix = 1;
  while (state.savedRecordings[name]) {
    name = `${base} (${suffix++})`;
  }
  return name;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'getState') {
    sendResponse(state);
  } else if (message.command === 'toggleRecording') {
    state.isRecording = !state.isRecording;
    if (state.isRecording) {
      lastActionTime = Date.now();
    } else if (!state.activeRecordingName && state.actions.length > 0) {
      // Auto-save a freshly recorded macro and select it
      const name = generateRecordingName();
      state.savedRecordings[name] = state.actions;
      state.activeRecordingName = name;
      chrome.storage.local.set({ savedRecordings: state.savedRecordings });
    }

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        const target = { tabId: tabs[0].id };
        
        if (state.isRecording) {
          chrome.debugger.attach(target, '1.3').catch(() => {});
        }

        chrome.tabs.sendMessage(tabs[0].id, {
          command: 'setRecordingState',
          isRecording: state.isRecording
        }).catch(() => {});
        
        if (state.isRecording) {
            chrome.scripting.executeScript({
                target: target,
                files: ['content.js']
            }).catch(() => {});
        }
      }
    });
    
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'startSelectingArea') {
    state.isSelectingArea = true;
    state.captureRatio = message.ratio || 'free';
    broadcastState();

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        const target = { tabId: tabs[0].id };
        // Attach debugger so ratio is correct
        chrome.debugger.attach(target, '1.3').catch(() => {});

        chrome.scripting.executeScript({
            target: target,
            files: ['content.js']
        }).then(() => {
          chrome.tabs.sendMessage(tabs[0].id, { command: 'startSelectingArea', ratio: message.ratio }).catch(() => {});
        }).catch(() => {});
      }
    });
    sendResponse(state);
  } else if (message.command === 'areaSelected') {
    state.isSelectingArea = false;
    state.captureRect = message.rect;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'clearArea') {
    state.captureRect = null;
    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { command: 'clearArea' }).catch(() => {});
      }
    });
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'clearActions') {
    state.actions = [];
    state.activeRecordingName = '';

    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.debugger.detach({tabId: tabs[0].id}).catch(() => {});
      }
    });

    broadcastState();
    sendResponse(state);
  } else if (message.command === 'recordAction') {
    if (state.isRecording) {
      const now = Date.now();
      const delay = now - lastActionTime;
      lastActionTime = now;
      
      state.actions.push({
        ...message.action,
        delay: delay
      });
      broadcastState();
    }
    sendResponse({success: true});
  } else if (message.command === 'startPlayback') {
    if (!state.isPlaying) {
      if (!state.macroEnabled || state.actions.length === 0) {
        takeSingleCapture(message.prefix);
      } else {
        startPlayback(message.prefix);
      }
    }
    sendResponse(state);
  } else if (message.command === 'stopPlayback') {
    state.isPlaying = false;
    
    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { command: 'hideRect' }).catch(() => {});
      }
    });

    broadcastState();
    sendResponse(state);
  } else if (message.command === 'updatePrefix') {
    state.prefix = message.prefix;
    sendResponse(state);
  } else if (message.command === 'updateCaptureFirst') {
    state.captureFirst = message.captureFirst;
    sendResponse(state);
  } else if (message.command === 'updateCreatePdf') {
    state.createPdf = message.createPdf;
    sendResponse(state);
  } else if (message.command === 'updateCaptureMode') {
    state.captureMode = message.captureMode;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'updateZoomMultiplier') {
    state.zoomMultiplier = message.zoomMultiplier;
    broadcastState();
    sendResponse(state);
  } else if (message.command === 'updateMacroEnabled') {
    state.macroEnabled = message.macroEnabled;
    sendResponse(state);
  } else if (message.command === 'loadRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      state.actions = state.savedRecordings[message.name];
      state.activeRecordingName = message.name;
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'deleteRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      delete state.savedRecordings[message.name];
      if (state.activeRecordingName === message.name) {
        state.activeRecordingName = '';
      }
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'renameRecording') {
    const oldName = message.oldName;
    const newName = message.newName && message.newName.trim();
    const oldExists = oldName && state.savedRecordings[oldName];
    const newIsFree = newName && (newName === oldName || !state.savedRecordings[newName]);
    if (oldExists && newIsFree && newName !== oldName) {
      state.savedRecordings[newName] = state.savedRecordings[oldName];
      delete state.savedRecordings[oldName];
      if (state.activeRecordingName === oldName) {
        state.activeRecordingName = newName;
      }
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  }
  return true;
});

async function performCapture(tabs, tabId, prefix) {
  if (state.captureMode === 'zoom') {
    await captureZoom(tabs, tabId, prefix);
  } else if (state.captureMode === 'scroll') {
    await captureScrollStrip(tabs, tabId, prefix);
  } else {
    await captureScreenshot(tabs, tabId, prefix);
  }
}

async function captureScreenshot(tabs, tabId, prefix) {
  // Hide rectangle before capturing
  if (state.captureRect) {
    await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});
    await sleep(100); // small buffer for DOM update
  }

  let dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {format: 'png'});

  // Show rectangle again
  if (state.captureRect) {
    await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    dataUrl = await cropImage(dataUrl, state.captureRect);
  }

  await saveCapture(dataUrl, prefix);
}

// Rate-limited captureVisibleTab: multi-tile modes fire many captures in a
// row and Chrome rejects anything faster than 2/sec.
let lastCaptureAt = 0;
async function captureTab(windowId) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const rateLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(err && err.message));
      if (!rateLimited || attempt >= 3) throw err;
    }
  }
}

// ── Scroll Strip Capture ───────────────────────────────────────────────
// Scrolls the page (or the scrollable panel under the selected area) one
// region-height at a time and stitches every step into one continuous image.
// Each step crops from the position the scroller actually reached, so the
// last step (which can't scroll a full height) contributes only new rows.
async function captureScrollStrip(tabs, tabId, prefix) {
  const windowId = tabs[0].windowId;

  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});

  const plan = await chrome.tabs.sendMessage(tabId, { command: 'beginScrollStrip', rect: state.captureRect });
  const region = plan.region;
  // Steps overlap by 1 CSS px: at fractional zoom/DPR the scroll position
  // snaps to device pixels and can land slightly short of the target, and the
  // overlap guarantees no gap. Duplicate rows are cropped below.
  const step = Math.floor(region.height) - 1;
  if (step < 1 || region.width < 1) {
    throw new Error('Scroll capture aborted: the capture area is empty.');
  }

  let writer = null;

  try {
    let target = 0;
    let writtenPx = 0; // strip rows saved so far; strip row 0 = scroll position 0
    for (let i = 0; i < MAX_STRIP_TILES && state.isPlaying; i++) {
      const { actual, maxScroll } = await chrome.tabs.sendMessage(tabId, { command: 'scrollStripTo', y: target });
      if (i > 0) {
        // Fixed headers/footers/floating buttons would otherwise repeat on every step
        await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyElements', enable: true }).catch(() => {});
      }
      await sleep(SCROLL_SETTLE_DELAY);

      const bitmap = await dataUrlToBitmap(await captureTab(windowId));
      // devicePixelRatio is exact (includes page zoom); innerWidth is rounded
      // to whole CSS px, so only fall back to the measured ratio if the
      // capture doesn't match the reported DPR.
      const measured = bitmap.width / plan.innerWidth;
      const scale = Math.abs(measured - plan.devicePixelRatio) * plan.innerWidth <= 2
        ? plan.devicePixelRatio
        : measured;

      // Work in absolute device-pixel rows: this capture shows strip rows
      // [tileTop, tileTop + regionH). Keep only rows not yet written.
      const tileTop = Math.round(actual * scale);
      const regionH = Math.floor(region.height * scale);
      const from = Math.max(writtenPx, tileTop);
      const sx = Math.round(region.x * scale);
      const sy = Math.round(region.y * scale) + (from - tileTop);
      const sw = Math.round(region.width * scale);
      const sh = Math.min(tileTop + regionH - from, bitmap.height - sy);
      const isLast = actual >= maxScroll - 0.5;
      if (sh > 0) {
        if (!writer) writer = new StripWriter(prefix, sw);
        const remaining = Math.round(maxScroll * scale) + regionH - from;
        await writer.add(bitmap, sx, sy, sh, remaining);
        writtenPx = from + sh;
      }

      if (isLast || actual + 0.5 < target - step) break; // reached the end / scroller stuck
      target += step;
    }

    if (writer) await writer.finish();
  } finally {
    await chrome.tabs.sendMessage(tabId, { command: 'endScrollStrip' }).catch(() => {});
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    }
  }
}

// Draws strip tiles straight into a canvas as they arrive. When the strip
// outgrows canvas limits it is saved as consecutive _partN files that line up
// edge to edge with no overlap.
class StripWriter {
  constructor(prefix, width) {
    this.prefix = prefix;
    this.width = width;
    this.number = ++captureCount;
    this.parts = 0;
    this.canvas = null;
    this.ctx = null;
    this.y = 0;
    this.partLimit = Math.max(1, Math.min(MAX_STRIP_HEIGHT, Math.floor(MAX_STRIP_AREA / width)));
  }

  async add(bitmap, sx, sy, sh, remainingEstimate) {
    if (this.canvas && this.y + sh > this.canvas.height) {
      await this.flush(false);
    }
    if (!this.canvas) {
      // Size to the expected remaining height plus one tile of slack for
      // rounding; flush() trims any excess, and a new part starts only if the
      // page genuinely grows past it (lazy loading).
      const height = Math.min(this.partLimit, remainingEstimate + sh);
      this.canvas = new OffscreenCanvas(this.width, height);
      this.ctx = this.canvas.getContext('2d');
      this.y = 0;
    }
    this.ctx.drawImage(bitmap, sx, sy, this.width, sh, 0, this.y, this.width, sh);
    this.y += sh;
  }

  async flush(isFinal) {
    if (!this.canvas || this.y === 0) return;
    let out = this.canvas;
    if (this.y < out.height) {
      out = new OffscreenCanvas(this.width, this.y);
      out.getContext('2d').drawImage(this.canvas, 0, 0);
    }
    const dataUrl = await blobToDataUrl(await out.convertToBlob({ type: 'image/png' }));
    const suffix = isFinal && this.parts === 0 ? '' : `_part${++this.parts}`;
    await saveCapture(dataUrl, this.prefix, { number: this.number, suffix });
    this.canvas = null;
    this.ctx = null;
    this.y = 0;
  }

  async finish() {
    await this.flush(true);
  }
}

// ── Zoom Capture ───────────────────────────────────────────────────────
// Re-renders the same visible area (viewport or selection) at N× resolution
// through the DevTools protocol. Unlike page zoom this never changes the
// layout, window size or what the user sees -- the renderer simply rasterizes
// the clip at a higher scale. Large outputs are rendered tile by tile and
// stitched, since the renderer has its own per-screenshot size limits.
async function captureZoom(tabs, tabId, prefix) {
  const target = { tabId };
  const tabBefore = await chrome.tabs.get(tabId);
  let attachedHere = false;
  let overridden = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attachedHere = true;
  } catch (err) {
    // Already attached (macro playback / area selection) -- reuse that session
  }

  try {
    if (attachedHere) {
      // A fresh attach slides in Chrome's "is debugging this browser" bar,
      // which shrinks the page. Pin the layout to the pre-attach size so the
      // zoomed image covers exactly what a Standard capture would (incl. fixed
      // footers), then let it repaint -- earlier screenshots return stale tiles.
      // tab width/height are unzoomed px, which is what the override expects
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        width: tabBefore.width,
        height: tabBefore.height,
        deviceScaleFactor: 0,
        mobile: false
      });
      overridden = true;
      await sleep(ZOOM_ATTACH_SETTLE_DELAY);
    }

    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});
      await sleep(100);
    }

    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const vv = metrics.cssVisualViewport;
    // Screenshot clips are measured in zoomed px (CSS px x browser zoom), and
    // each clip unit becomes `deviceScale` output px at clip.scale = 1.
    const zoom = vv.zoom || 1;
    const deviceScale = (metrics.visualViewport && metrics.visualViewport.clientWidth / (vv.clientWidth * zoom)) || 1;

    // Viewport-relative CSS region; clientWidth/Height exclude scrollbars
    const viewportRegion = { x: 0, y: 0, width: vv.clientWidth, height: vv.clientHeight };
    const cssRegion = state.captureRect ? intersectRect(viewportRegion, state.captureRect) : viewportRegion;
    if (cssRegion.width < 1 || cssRegion.height < 1) {
      throw new Error('Zoom capture aborted: the capture area is empty.');
    }
    const region = {
      x: (vv.pageX + cssRegion.x) * zoom,
      y: (vv.pageY + cssRegion.y) * zoom,
      width: cssRegion.width * zoom,
      height: cssRegion.height * zoom
    };

    // Output px per clip unit. Capped so the stitched image stays within canvas limits.
    let multiplier = state.zoomMultiplier || 2;
    const maxScale = Math.min(
      MAX_ZOOM_DIM / region.width,
      MAX_ZOOM_DIM / region.height,
      Math.sqrt(MAX_ZOOM_AREA / (region.width * region.height))
    ) / deviceScale;
    if (multiplier > maxScale) {
      console.warn(`CheeseIt: zoom ${multiplier}x exceeds canvas limits for this area, using ${maxScale.toFixed(2)}x`);
      multiplier = Math.max(1, maxScale);
    }
    const scale = multiplier * deviceScale;
    const outW = Math.round(region.width * scale);
    const outH = Math.round(region.height * scale);

    // Tile in clip units, placed by rounding absolute positions so tiles meet exactly
    const tileSize = Math.max(1, Math.floor(ZOOM_TILE_PX / scale));
    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');

    for (let ty = 0; ty < region.height; ty += tileSize) {
      const th = Math.min(tileSize, region.height - ty);
      for (let tx = 0; tx < region.width; tx += tileSize) {
        const tw = Math.min(tileSize, region.width - tx);
        const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
          format: 'png',
          // clip is in document coordinates (region already includes the scroll offset)
          clip: { x: region.x + tx, y: region.y + ty, width: tw, height: th, scale: multiplier }
        });
        const bitmap = await dataUrlToBitmap('data:image/png;base64,' + shot.data);
        const dx = Math.round(tx * scale);
        const dy = Math.round(ty * scale);
        const dw = Math.round((tx + tw) * scale) - dx;
        const dh = Math.round((ty + th) * scale) - dy;
        ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, dx, dy, dw, dh);
      }
    }

    const dataUrl = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
    await saveCapture(dataUrl, prefix);
  } finally {
    if (state.captureRect) {
      await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});
    }
    if (overridden) {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
    if (attachedHere) {
      await chrome.debugger.detach(target).catch(() => {});
    }
  }
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

async function saveCapture(dataUrl, prefix, { number, suffix = '' } = {}) {
  if (number === undefined) number = ++captureCount;
  const numbered = number.toString().padStart(3, '0');
  const filename = `${prefix ? `${prefix}_` : ''}${numbered}${suffix}.png`;
  const filePath = currentSubfolder ? `${currentSubfolder}/${filename}` : filename;

  await chrome.downloads.download({
    url: dataUrl,
    filename: filePath,
    saveAs: false
  });

  if (state.createPdf) {
    const dims = await getImageDimensions(dataUrl);
    sessionCaptures.push({ dataUrl, width: dims.width, height: dims.height });
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dataUrlToBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

async function blobToDataUrl(blob) {
  const reader = new FileReader();
  reader.readAsDataURL(blob);
  return new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
  });
}

async function cropImage(dataUrl, rect) {
  const bitmap = await dataUrlToBitmap(dataUrl);

  const dpr = rect.devicePixelRatio || 1;
  const targetX = Math.round(rect.x * dpr);
  const targetY = Math.round(rect.y * dpr);
  const targetWidth = Math.round(rect.width * dpr);
  const targetHeight = Math.round(rect.height * dpr);

  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(bitmap,
    targetX, targetY, targetWidth, targetHeight,
    0, 0, targetWidth, targetHeight
  );

  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(croppedBlob);
}

async function takeSingleCapture(prefix) {
  state.isPlaying = true;
  broadcastState();

  currentSubfolder = await getNextRunSubfolder();
  sessionCaptures = [];

  // No prefix: files are just numbered, the dated run subfolder already says when
  sessionPrefix = prefix || '';
  state.prefix = sessionPrefix;

  const tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (tabs.length > 0) {
    captureCount = 0;
    try {
      await performCapture(tabs, tabs[0].id, sessionPrefix);
    } catch (err) {
      console.error('CheeseIt: capture failed:', err);
    }
  }

  await endPlayback();
}

async function startPlayback(prefix) {
  state.isPlaying = true;
  state.isRecording = false; // Ensure recording is off
  
  currentSubfolder = await getNextRunSubfolder();
  sessionCaptures = [];

  // No prefix: files are just numbered, the dated run subfolder already says when
  sessionPrefix = prefix || '';
  state.prefix = sessionPrefix;
  
  broadcastState();

  const tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (tabs.length === 0) {
    endPlayback();
    return;
  }
  
  const tabId = tabs[0].id;
  const target = { tabId: tabId };

  try {
    await chrome.debugger.attach(target, '1.3');
    // Let the "is debugging this browser" bar finish resizing the page so the
    // first capture matches the size of the ones that follow
    await sleep(ZOOM_ATTACH_SETTLE_DELAY);
  } catch (err) {
    console.log('Debugger attach skipped/failed (likely already attached):', err);
  }

  captureCount = 0;

  while (state.isPlaying) {
    // Capture BEFORE all actions
    if (state.captureFirst) {
      try {
        await performCapture(tabs, tabId, sessionPrefix);
      } catch (err) {
        console.error('CheeseIt: capture failed:', err);
      }
    }

    for (let i = 0; i < state.actions.length; i++) {
      if (!state.isPlaying) break;
      const action = state.actions[i];

      await sleep(action.delay);
      if (!state.isPlaying) break;

      if (action.type === 'click') {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: action.x,
          y: action.y,
          button: 'left',
          clickCount: 1
        }).catch(() => {});

        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: action.x,
          y: action.y,
          button: 'left',
          clickCount: 1
        }).catch(() => {});
      } else if (action.type === 'keydown') {
        await dispatchKeyAction(target, action);
      }
    }

    if (!state.isPlaying) break;

    // Capture AFTER all actions (wait 1s for page to settle)
    if (!state.captureFirst) {
      await sleep(1000);
      if (!state.isPlaying) break;
      try {
        await performCapture(tabs, tabId, sessionPrefix);
      } catch (err) {
        console.error('CheeseIt: capture failed:', err);
      }
    }

    if (state.isPlaying) await sleep(500);
  }

  await chrome.debugger.detach(target).catch(() => {});
  await endPlayback();
}

async function dispatchKeyAction(target, action) {
  const modifiers = action.modifiers || 0;
  const isCtrlOrCmd = (modifiers & 2) !== 0 || (modifiers & 4) !== 0;
  const isPrintable = action.key && action.key.length === 1 && !isCtrlOrCmd;

  if (isPrintable) {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: modifiers,
      text: action.key,
      unmodifiedText: action.key,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'char',
      modifiers: modifiers,
      text: action.key,
      unmodifiedText: action.key,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

  } else if (action.key === 'Enter') {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: modifiers,
      text: '\r',
      unmodifiedText: '\r',
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'char',
      modifiers: modifiers,
      text: '\r',
      unmodifiedText: '\r',
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: 'Enter',
      code: action.code || 'Enter',
      windowsVirtualKeyCode: 13
    }).catch(() => {});

  } else {
    // Non-printable or shortcut key (e.g. Backspace, Tab, Arrows, Esc, or Ctrl+A/Ctrl+C)
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});

    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: modifiers,
      key: action.key,
      code: action.code,
      windowsVirtualKeyCode: action.keyCode
    }).catch(() => {});
  }
}

async function endPlayback() {
  state.isPlaying = false;
  broadcastState();

  if (state.createPdf && sessionCaptures.length > 0) {
    await generateAndDownloadPdf(sessionCaptures, sessionPrefix, currentSubfolder);
  }
  sessionCaptures = [];
}

async function getImageDimensions(dataUrl) {
  // Extract dimensions from PNG header (fast, no canvas needed)
  // PNG: 8-byte sig + 4-byte len + "IHDR" + 4-byte W + 4-byte H
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64.substring(0, 64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // IHDR starts at offset 12 (after 8 sig + 4 len + 4 type)
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { width: width >>> 0, height: height >>> 0 };
}

async function generateAndDownloadPdf(captures, prefix, subfolder) {
  try {
    const { PDFDocument } = PDFLib;
    const pdfDoc = await PDFDocument.create();

    for (const capture of captures) {
      const base64Data = capture.dataUrl.split(',')[1];
      const pngBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const pngImage = await pdfDoc.embedPng(pngBytes);

      // Create a page exactly the same size as the image (1pt = 1px), scaled
      // down only when a long strip exceeds the PDF page size limit (14400pt)
      const fit = Math.min(1, PDF_MAX_PAGE_DIM / Math.max(capture.width, capture.height));
      const width = capture.width * fit;
      const height = capture.height * fit;
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(pngImage, { x: 0, y: 0, width, height });
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const pdfDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(pdfBlob);
    });

    const filename = `${prefix || subfolder || 'capture'}.pdf`;
    const filePath = subfolder ? `${subfolder}/${filename}` : filename;

    await chrome.downloads.download({
      url: pdfDataUrl,
      filename: filePath,
      saveAs: false
    });
  } catch (err) {
    console.error('PDF generation failed:', err);
  }
}
