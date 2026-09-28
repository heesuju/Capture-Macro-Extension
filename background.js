let state = {
  isRecording: false,
  isPlaying: false,
  isSelectingArea: false,
  captureRect: null,
  prefix: '',
  actions: [],
  captureFirst: false,
  macroEnabled: false,
  savedRecordings: {}
};

chrome.storage.local.get(['savedRecordings'], (result) => {
  if (result.savedRecordings) {
    state.savedRecordings = result.savedRecordings;
  }
});

let lastActionTime = 0;
let captureCount = 0;
let sessionPrefix = '';

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'getState') {
    sendResponse(state);
  } else if (message.command === 'toggleRecording') {
    state.isRecording = !state.isRecording;
    if (state.isRecording) {
      lastActionTime = Date.now();
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
  } else if (message.command === 'updateMacroEnabled') {
    state.macroEnabled = message.macroEnabled;
    sendResponse(state);
  } else if (message.command === 'saveRecording') {
    if (message.name && state.actions.length > 0) {
      state.savedRecordings[message.name] = state.actions;
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'loadRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      state.actions = state.savedRecordings[message.name];
      broadcastState();
    }
    sendResponse(state);
  } else if (message.command === 'deleteRecording') {
    if (message.name && state.savedRecordings[message.name]) {
      delete state.savedRecordings[message.name];
      chrome.storage.local.set({savedRecordings: state.savedRecordings});
      broadcastState();
    }
    sendResponse(state);
  }
  return true;
});

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
  }

  if (state.captureRect) {
    dataUrl = await cropImage(dataUrl, state.captureRect);
  }
  
  captureCount++;
  const filename = `${prefix}_${captureCount.toString().padStart(3, '0')}.png`;
  
  await chrome.downloads.download({
    url: dataUrl,
    filename: filename,
    saveAs: false
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cropImage(dataUrl, rect) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  
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
  const reader = new FileReader();
  reader.readAsDataURL(croppedBlob);
  
  return new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
  });
}

async function takeSingleCapture(prefix) {
  state.isPlaying = true;
  broadcastState();

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
    await captureScreenshot(tabs, tabs[0].id, sessionPrefix);
  }

  endPlayback();
}

async function startPlayback(prefix) {
  state.isPlaying = true;
  state.isRecording = false; // Ensure recording is off
  
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
      await captureScreenshot(tabs, tabId, sessionPrefix);
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
      await captureScreenshot(tabs, tabId, sessionPrefix);
    }

    if (state.isPlaying) await sleep(500);
  }

  await chrome.debugger.detach(target).catch(() => {});
  endPlayback();
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

function endPlayback() {
  state.isPlaying = false;
  broadcastState();
}
