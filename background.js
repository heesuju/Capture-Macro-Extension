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
  captureMode: 'single', // 'single' | 'zoom_grid'
  zoomMultiplier: 2       // 2 | 3 | 4 -- quality multiplier for zoom_grid mode
};

const MAX_CANVAS_DIM = 16000; // stay under the ~16384/32768px canvas ceiling in both browsers
const ZOOM_SETTLE_DELAY = 300; // ms to let layout/zoom settle before each grid tile capture

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
  if (state.captureMode === 'zoom_grid') {
    await captureZoomGrid(tabs, tabId, prefix);
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

// ── Zoom Grid Capture ──────────────────────────────────────────────────
// Boosts effective devicePixelRatio via chrome.tabs.setZoom, and compensates
// by growing the physical window by the same factor so the CSS layout
// viewport (and therefore responsive breakpoints) stays unchanged.
async function enterZoomGridMode(windowId, tabId, multiplier, screenInfo) {
  const win = await chrome.windows.get(windowId);
  const original = { width: win.width, height: win.height, left: win.left, top: win.top };

  // chrome.windows.update REJECTS bounds that would leave more than half the
  // window off-screen -- it does not silently clamp. Clamp to the actual
  // available screen space ourselves and anchor the window inside it.
  const maxWidth = screenInfo ? screenInfo.availWidth : original.width;
  const maxHeight = screenInfo ? screenInfo.availHeight : original.height;
  const targetLeft = screenInfo ? screenInfo.availLeft : original.left;
  const targetTop = screenInfo ? screenInfo.availTop : original.top;

  const targetWidth = Math.min(Math.round(original.width * multiplier), maxWidth);
  const targetHeight = Math.min(Math.round(original.height * multiplier), maxHeight);

  let updated;
  try {
    updated = await chrome.windows.update(windowId, {
      left: targetLeft,
      top: targetTop,
      width: targetWidth,
      height: targetHeight
    });
  } catch (err) {
    // Last-resort fallback: proceed without resizing/zooming rather than aborting.
    console.error('CheeseIt: zoom grid window resize failed, continuing at native resolution:', err);
    return { original, effectiveMultiplier: 1 };
  }

  const widthRatio = updated.width / original.width;
  const heightRatio = updated.height / original.height;
  const effectiveMultiplier = Math.max(1, Math.min(multiplier, widthRatio, heightRatio));

  await chrome.tabs.setZoom(tabId, effectiveMultiplier);

  return { original, effectiveMultiplier };
}

async function exitZoomGridMode(windowId, tabId, original) {
  await chrome.tabs.setZoom(tabId, 0).catch(() => {}); // 0 = reset to the tab's default zoom
  await chrome.windows.update(windowId, {
    width: original.width,
    height: original.height,
    left: original.left,
    top: original.top
  }).catch(() => {});
}

async function captureZoomGrid(tabs, tabId, prefix) {
  const windowId = tabs[0].windowId;
  const requestedMultiplier = state.zoomMultiplier || 2;

  // content.js is only injected on record/select-area, not declaratively --
  // make sure it's present before relying on it for grid metrics/scrolling.
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});

  const before = await chrome.tabs.sendMessage(tabId, { command: 'getLayoutFingerprint' }).catch(() => null);
  const screenInfo = await chrome.tabs.sendMessage(tabId, { command: 'getScreenInfo' }).catch(() => null);
  const { original } = await enterZoomGridMode(windowId, tabId, requestedMultiplier, screenInfo);

  try {
    await sleep(ZOOM_SETTLE_DELAY);

    if (before) {
      const after = await chrome.tabs.sendMessage(tabId, { command: 'getLayoutFingerprint' }).catch(() => null);
      if (after && (after.innerWidth !== before.innerWidth || after.innerHeight !== before.innerHeight)) {
        throw new Error('Zoom Grid capture aborted: page layout changed at this quality level (window could not grow enough to compensate). Try a lower multiplier.');
      }
    }

    if (state.captureRect) {
      await captureZoomGridSelection(tabs, tabId, prefix);
    } else {
      await captureZoomGridFullPage(tabs, tabId, prefix);
    }
  } finally {
    await exitZoomGridMode(windowId, tabId, original);
  }
}

// captureRect is drawn within a single viewport, so no scrolling/tiling is
// needed -- just take one supersampled shot and crop it at the boosted scale.
async function captureZoomGridSelection(tabs, tabId, prefix) {
  await chrome.tabs.sendMessage(tabId, { command: 'hideRect' }).catch(() => {});
  await sleep(100);

  const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' });

  await chrome.tabs.sendMessage(tabId, { command: 'showRect' }).catch(() => {});

  const metrics = await chrome.tabs.sendMessage(tabId, { command: 'getZoomGridMetrics' });
  const croppedDataUrl = await cropImage(dataUrl, state.captureRect, metrics.devicePixelRatio);

  await saveCapture(croppedDataUrl, prefix);
}

// Full page: tile a 2D grid of boosted-zoom captures with zero overlap, then
// stitch rows (and rows-into-one-image) via OffscreenCanvas, falling back to
// separate files whenever the stitched size would exceed canvas limits.
async function captureZoomGridFullPage(tabs, tabId, prefix) {
  const windowId = tabs[0].windowId;
  const metrics = await chrome.tabs.sendMessage(tabId, { command: 'getZoomGridMetrics' });
  const dpr = metrics.devicePixelRatio;
  const tileWcss = metrics.viewportWidth;
  const tileHcss = metrics.viewportHeight;
  const totalWcss = metrics.pageWidth;
  const totalHcss = metrics.pageHeight;

  const cols = Math.max(1, Math.ceil(totalWcss / tileWcss));
  const rows = Math.max(1, Math.ceil(totalHcss / tileHcss));

  const rowStrips = [];
  let anyRowFellBack = false;

  try {
    for (let r = 0; r < rows; r++) {
      const yCss = r * tileHcss;
      const remHcss = totalHcss - yCss;
      const cropTopPx = remHcss < tileHcss ? Math.round((tileHcss - remHcss) * dpr) : 0;

      const tileBitmaps = [];

      for (let c = 0; c < cols; c++) {
        const xCss = c * tileWcss;
        const remWcss = totalWcss - xCss;
        const cropLeftPx = remWcss < tileWcss ? Math.round((tileWcss - remWcss) * dpr) : 0;

        await chrome.tabs.sendMessage(tabId, { command: 'scrollToGridPosition', x: xCss, y: yCss });
        if (r > 0 || c > 0) {
          await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyElements', enable: true }).catch(() => {});
        }
        await sleep(ZOOM_SETTLE_DELAY);

        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        let bitmap = await dataUrlToBitmap(dataUrl);

        if (cropLeftPx > 0 || cropTopPx > 0) {
          bitmap = await cropBitmap(bitmap, cropLeftPx, cropTopPx);
        }
        tileBitmaps.push(bitmap);
      }

      const rowWidthPx = tileBitmaps.reduce((sum, b) => sum + b.width, 0);
      const rowHeightPx = tileBitmaps[0].height;

      if (rowWidthPx > MAX_CANVAS_DIM) {
        anyRowFellBack = true;
        for (let c = 0; c < tileBitmaps.length; c++) {
          const tileDataUrl = await bitmapToDataUrl(tileBitmaps[c]);
          await downloadNumbered(tileDataUrl, prefix, `_r${r + 1}c${c + 1}`);
        }
        rowStrips.push(null);
        continue;
      }

      const rowCanvas = new OffscreenCanvas(rowWidthPx, rowHeightPx);
      const rowCtx = rowCanvas.getContext('2d');
      let xOffset = 0;
      for (const bitmap of tileBitmaps) {
        rowCtx.drawImage(bitmap, xOffset, 0);
        xOffset += bitmap.width;
      }
      rowStrips.push({ bitmap: await createImageBitmap(rowCanvas), width: rowWidthPx, height: rowHeightPx });
    }
  } finally {
    await chrome.tabs.sendMessage(tabId, { command: 'suppressStickyElements', enable: false }).catch(() => {});
    await chrome.tabs.sendMessage(tabId, { command: 'scrollToGridPosition', x: 0, y: 0 }).catch(() => {});
  }

  if (anyRowFellBack) return; // tiles for oversized rows already saved individually above

  const totalHeightPx = rowStrips.reduce((sum, row) => sum + row.height, 0);

  if (totalHeightPx > MAX_CANVAS_DIM) {
    for (let i = 0; i < rowStrips.length; i++) {
      const rowDataUrl = await bitmapToDataUrl(rowStrips[i].bitmap);
      await downloadNumbered(rowDataUrl, prefix, `_row${i + 1}`);
    }
    return;
  }

  const finalCanvas = new OffscreenCanvas(rowStrips[0].width, totalHeightPx);
  const finalCtx = finalCanvas.getContext('2d');
  let yOffset = 0;
  for (const row of rowStrips) {
    finalCtx.drawImage(row.bitmap, 0, yOffset);
    yOffset += row.height;
  }

  const finalBlob = await finalCanvas.convertToBlob({ type: 'image/png' });
  const finalDataUrl = await blobToDataUrl(finalBlob);

  await saveCapture(finalDataUrl, prefix);
}

async function downloadNumbered(dataUrl, prefix, suffix) {
  captureCount++;
  const filename = `${prefix}_${captureCount.toString().padStart(3, '0')}${suffix}.png`;
  const filePath = currentSubfolder ? `${currentSubfolder}/${filename}` : filename;
  await chrome.downloads.download({ url: dataUrl, filename: filePath, saveAs: false });
}

async function saveCapture(dataUrl, prefix) {
  captureCount++;
  const filename = `${prefix}_${captureCount.toString().padStart(3, '0')}.png`;
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

async function bitmapToDataUrl(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return await blobToDataUrl(blob);
}

async function cropBitmap(bitmap, cropLeftPx, cropTopPx) {
  const w = bitmap.width - cropLeftPx;
  const h = bitmap.height - cropTopPx;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, cropLeftPx, cropTopPx, w, h, 0, 0, w, h);
  return await createImageBitmap(canvas);
}

async function cropImage(dataUrl, rect, dprOverride) {
  const bitmap = await dataUrlToBitmap(dataUrl);

  const dpr = dprOverride || rect.devicePixelRatio || 1;
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

  if (prefix && prefix.length > 0) {
    sessionPrefix = prefix;
    state.prefix = prefix;
  } else {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    sessionPrefix = `${yy}${mm}${dd}`;
    state.prefix = '';
  }

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

  if (prefix && prefix.length > 0) {
    sessionPrefix = prefix;
    state.prefix = prefix;
  } else {
    // Generate 6 char YYMMDD
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    sessionPrefix = `${yy}${mm}${dd}`;
    state.prefix = '';
  }
  
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

      // Create a page exactly the same size as the image (1pt = 1px)
      const page = pdfDoc.addPage([capture.width, capture.height]);
      page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: capture.width,
        height: capture.height
      });
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
    const pdfDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(pdfBlob);
    });

    const filename = `${prefix || 'capture'}.pdf`;
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
