let isRecording = false;
let captureRectDiv = null;

// Fetch initial state in case we were just injected
chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
  if (response) {
    isRecording = response.isRecording;
    if (isRecording) {
      console.log('Auto Capture: Initialized in recording state');
    }
    if (response.captureRect) {
      drawPersistentRect(response.captureRect);
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
  } else if (message.command === 'startSelectingArea') {
    startSelection();
    sendResponse({ success: true });
  } else if (message.command === 'clearArea') {
    if (captureRectDiv) {
      captureRectDiv.remove();
      captureRectDiv = null;
    }
    sendResponse({ success: true });
  } else if (message.command === 'hideRect') {
    if (captureRectDiv) captureRectDiv.style.display = 'none';
    sendResponse({ success: true });
  } else if (message.command === 'showRect') {
    if (captureRectDiv) captureRectDiv.style.display = 'block';
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


function drawPersistentRect(rect) {
  if (!captureRectDiv) {
    captureRectDiv = document.createElement('div');
    captureRectDiv.style.position = 'fixed';
    captureRectDiv.style.border = '2px dashed red';
    captureRectDiv.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
    captureRectDiv.style.pointerEvents = 'none';
    captureRectDiv.style.zIndex = '9999999';
    document.body.appendChild(captureRectDiv);
  }
  captureRectDiv.style.left = rect.x + 'px';
  captureRectDiv.style.top = rect.y + 'px';
  captureRectDiv.style.width = rect.width + 'px';
  captureRectDiv.style.height = rect.height + 'px';
  captureRectDiv.style.display = 'block';
}

function startSelection() {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100vw';
  overlay.style.height = '100vh';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.3)';
  overlay.style.zIndex = '9999998';
  overlay.style.cursor = 'crosshair';
  
  const selection = document.createElement('div');
  selection.style.position = 'absolute';
  selection.style.border = '2px dashed #fff';
  selection.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
  overlay.appendChild(selection);
  document.body.appendChild(overlay);

  let startX, startY;
  let isDragging = false;

  const onMouseDown = (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    selection.style.left = startX + 'px';
    selection.style.top = startY + 'px';
    selection.style.width = '0px';
    selection.style.height = '0px';
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    selection.style.left = x + 'px';
    selection.style.top = y + 'px';
    selection.style.width = width + 'px';
    selection.style.height = height + 'px';
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const width = Math.abs(e.clientX - startX);
    const height = Math.abs(e.clientY - startY);
    
    overlay.remove();
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);

    const rect = { x, y, width, height };
    
    // Send to background
    chrome.runtime.sendMessage({
      command: 'areaSelected',
      rect: rect
    });
    
    drawPersistentRect(rect);
  };

  overlay.addEventListener('mousedown', onMouseDown);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseup', onMouseUp);
}
