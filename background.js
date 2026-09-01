let state = {
  isRecording: false,
  isPlaying: false,
  isSelectingArea: false,
  captureRect: null,
  actions: []
};

let lastActionTime = 0;
let captureCount = 0;

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
          chrome.tabs.sendMessage(tabs[0].id, { command: 'startSelectingArea' }).catch(() => {});
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
    if (!state.isPlaying && state.actions.length > 0) {
      startPlayback();
    }
    sendResponse(state);
  } else if (message.command === 'stopPlayback') {
    state.isPlaying = false;
    broadcastState();
    sendResponse(state);
  }
  return true;
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cropImage(dataUrl, rect) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  
  const canvas = new OffscreenCanvas(rect.width, rect.height);
  const ctx = canvas.getContext('2d');
  
  ctx.drawImage(bitmap, 
    rect.x, rect.y, rect.width, rect.height,
    0, 0, rect.width, rect.height
  );
  
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  const reader = new FileReader();
  reader.readAsDataURL(croppedBlob);
  
  return new Promise((resolve) => {
    reader.onloadend = () => resolve(reader.result);
  });
}

async function startPlayback() {
  state.isPlaying = true;
  state.isRecording = false; // Ensure recording is off
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
        });
        
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: action.x,
          y: action.y,
          button: 'left',
          clickCount: 1
        });

        await sleep(1000); 
        if (!state.isPlaying) break;

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
        const filename = `capture_${captureCount.toString().padStart(3, '0')}.png`;
        
        await chrome.downloads.download({
          url: dataUrl,
          filename: filename,
          saveAs: false
        });
      }
    }
    if (state.isPlaying) await sleep(500);
  }

  await chrome.debugger.detach(target).catch(() => {});
  endPlayback();
}

function endPlayback() {
  state.isPlaying = false;
  broadcastState();
}
