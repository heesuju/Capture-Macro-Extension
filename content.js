let isRecording = false;

// Fetch initial state in case we were just injected
chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
  if (response) {
    isRecording = response.isRecording;
    if (isRecording) {
      console.log('Auto Capture: Initialized in recording state');
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.command === 'setRecordingState') {
    isRecording = message.isRecording;
    if (isRecording) {
      console.log('Auto Capture: Recording started');
    } else {
      console.log('Auto Capture: Recording stopped');
    }
    sendResponse({ success: true });
  }
});

document.addEventListener('mousedown', (e) => {
  if (!isRecording) return;
  
  // Send the click coordinates to the background script
  chrome.runtime.sendMessage({
    command: 'recordAction',
    action: {
      type: 'click',
      x: e.clientX,
      y: e.clientY,
      timestamp: Date.now()
    }
  });
}, true); // Use capture phase to intercept as early as possible
