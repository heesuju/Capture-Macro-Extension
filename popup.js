document.addEventListener('DOMContentLoaded', () => {
  const btnRecord = document.getElementById('btnRecord');
  const btnPlay = document.getElementById('btnPlay');
  const btnClear = document.getElementById('btnClear');
  const btnSetArea = document.getElementById('btnSetArea');
  const btnClearArea = document.getElementById('btnClearArea');
  const statusDisplay = document.getElementById('status');
  const actionCount = document.getElementById('actionCount');
  const areaStatus = document.getElementById('areaStatus');
  const prefixInput = document.getElementById('prefixInput');
  const captureFirstCheckbox = document.getElementById('captureFirstCheckbox');
  const btnSave = document.getElementById('btnSave');
  const btnLoad = document.getElementById('btnLoad');
  const btnDelete = document.getElementById('btnDelete');
  const saveNameInput = document.getElementById('saveNameInput');
  const savedRecordingsSelect = document.getElementById('savedRecordingsSelect');

  function updateUI(state) {
    actionCount.textContent = state.actions.length;
    
    if (document.activeElement !== prefixInput) {
      prefixInput.value = state.prefix || '';
    }
    
    if (document.activeElement !== captureFirstCheckbox) {
      captureFirstCheckbox.checked = state.captureFirst || false;
    }

    if (state.savedRecordings && document.activeElement !== savedRecordingsSelect) {
      const currentVal = savedRecordingsSelect.value;
      savedRecordingsSelect.innerHTML = '<option value="">Select a recording...</option>';
      for (const name of Object.keys(state.savedRecordings)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = `${name} (${state.savedRecordings[name].length} actions)`;
        if (name === currentVal) option.selected = true;
        savedRecordingsSelect.appendChild(option);
      }
    }
    
    if (state.captureRect) {
      areaStatus.textContent = `Custom (${state.captureRect.width}x${state.captureRect.height})`;
      btnClearArea.style.display = 'block';
    } else {
      areaStatus.textContent = 'Full Page';
      btnClearArea.style.display = 'none';
    }
    
    if (state.isSelectingArea) {
      statusDisplay.textContent = 'Status: Draw Rectangle...';
      statusDisplay.className = 'status recording';
      btnRecord.disabled = true;
      btnPlay.disabled = true;
      btnClear.disabled = true;
      btnSetArea.disabled = true;
      btnClearArea.disabled = true;
    } else if (state.isRecording) {
      statusDisplay.textContent = 'Status: Recording...';
      statusDisplay.className = 'status recording';
      btnRecord.textContent = 'Stop Recording';
      btnRecord.className = 'btn danger';
      btnRecord.disabled = false;
      btnPlay.disabled = true;
      btnClear.disabled = true;
    } else if (state.isPlaying) {
      statusDisplay.textContent = 'Status: Playing...';
      statusDisplay.className = 'status playing';
      btnRecord.disabled = true;
      btnClear.disabled = true;
      btnPlay.textContent = 'Stop Macro';
      btnPlay.className = 'btn danger';
      btnPlay.disabled = false;
    } else {
      statusDisplay.textContent = 'Status: Ready';
      statusDisplay.className = 'status';
      btnRecord.textContent = 'Start Recording';
      btnRecord.className = 'btn primary';
      btnRecord.disabled = false;
      btnClear.disabled = false;
      btnPlay.textContent = 'Play Macro';
      btnPlay.className = 'btn success';
      btnPlay.disabled = state.actions.length === 0;
      btnSetArea.disabled = false;
      btnClearArea.disabled = !state.captureRect;
    }
  }

  function fetchState() {
    chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
      if (response) updateUI(response);
    });
  }

  btnRecord.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'toggleRecording' }, (response) => {
      if (response) updateUI(response);
    });
  });

  btnPlay.addEventListener('click', () => {
    if (btnPlay.textContent === 'Stop Macro') {
      chrome.runtime.sendMessage({ command: 'stopPlayback' }, (response) => {
        if (response) updateUI(response);
      });
    } else {
      const prefix = prefixInput.value.trim();
      chrome.runtime.sendMessage({ command: 'startPlayback', prefix: prefix }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  btnClear.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'clearActions' }, (response) => {
      if (response) updateUI(response);
    });
  });

  btnSetArea.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'startSelectingArea' }, (response) => {
      if (response) updateUI(response);
    });
  });

  btnClearArea.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'clearArea' }, (response) => {
      if (response) updateUI(response);
    });
  });

  prefixInput.addEventListener('input', () => {
    chrome.runtime.sendMessage({ command: 'updatePrefix', prefix: prefixInput.value });
  });

  captureFirstCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateCaptureFirst', captureFirst: captureFirstCheckbox.checked });
  });

  btnSave.addEventListener('click', () => {
    const name = saveNameInput.value.trim();
    if (name) {
      chrome.runtime.sendMessage({ command: 'saveRecording', name: name }, (response) => {
        if (response) updateUI(response);
        saveNameInput.value = '';
      });
    }
  });

  btnLoad.addEventListener('click', () => {
    const name = savedRecordingsSelect.value;
    if (name) {
      chrome.runtime.sendMessage({ command: 'loadRecording', name: name }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  btnDelete.addEventListener('click', () => {
    const name = savedRecordingsSelect.value;
    if (name) {
      chrome.runtime.sendMessage({ command: 'deleteRecording', name: name }, (response) => {
        if (response) {
          updateUI(response);
          savedRecordingsSelect.value = '';
        }
      });
    }
  });

  // Listen for updates from background (like action recorded or playback ended)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state);
    }
  });

  fetchState();
});
