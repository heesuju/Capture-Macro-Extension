let state = {
  isRecording: false,
  isPlaying: false,
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
    
    // Notify active tab
    chrome.tabs.query({active: true, lastFocusedWindow: true}, function(tabs) {
      if (tabs[0]) {
        const target = { tabId: tabs[0].id };
        
        if (state.isRecording) {
          // Attach debugger NOW so the banner appears during recording, 
          // keeping the page layout and coordinates identical for playback.
          chrome.debugger.attach(target, '1.3').catch(() => {});
        } else {
          // We don't detach here because they might play it back right away.
          // We will detach when they clear the actions.
        }

        chrome.tabs.sendMessage(tabs[0].id, {
          command: 'setRecordingState',
          isRecording: state.isRecording
        }).catch(() => {});
        
        // Inject content script if not already injected
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
  } else if (message.command === 'clearActions') {
    state.actions = [];
    
    // Detach debugger when clearing actions
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
  }
  return true;
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    // If it's already attached (from recording phase), it will throw here.
    // We can safely ignore this error and proceed.
    console.log('Debugger attach skipped/failed (likely already attached):', err);
  }

  captureCount = 0;

  for (let i = 0; i < state.actions.length; i++) {
    const action = state.actions[i];
    
    // Wait for the recorded delay
    await sleep(action.delay);

    if (action.type === 'click') {
      // Simulate physical click
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

      // Wait a bit for the UI to update after the click
      await sleep(1000); 

      // Take a screenshot
      const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, {format: 'png'});
      
      // Download the screenshot
      captureCount++;
      const filename = `capture_${captureCount.toString().padStart(3, '0')}.png`;
      
      await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false
      });
    }
  }

  await chrome.debugger.detach(target);
  endPlayback();
}

function endPlayback() {
  state.isPlaying = false;
  broadcastState();
}
