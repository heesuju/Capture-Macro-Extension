document.addEventListener('DOMContentLoaded', () => {
  const btnRecord = document.getElementById('btnRecord');
  const btnPlay = document.getElementById('btnPlay');
  const btnClear = document.getElementById('btnClear');
  const statusDisplay = document.getElementById('status');
  const actionCount = document.getElementById('actionCount');

  function updateUI(state) {
    actionCount.textContent = state.actions.length;
    
    if (state.isRecording) {
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
      chrome.runtime.sendMessage({ command: 'startPlayback' }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  btnClear.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'clearActions' }, (response) => {
      if (response) updateUI(response);
    });
  });

  // Listen for updates from background (like action recorded or playback ended)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state);
    }
  });

  fetchState();
});
