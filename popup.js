document.addEventListener('DOMContentLoaded', () => {
  const btnRecord   = document.getElementById('btnRecord');
  const btnPlay     = document.getElementById('btnPlay');
  const btnSetArea  = document.getElementById('btnSetArea');
  const areaBtns    = document.querySelectorAll('.area-btn');
  const statusDisplay = document.getElementById('status');
  const actionCount = document.getElementById('actionCount');
  const areaStatus  = document.getElementById('areaStatus');
  const prefixInput = document.getElementById('prefixInput');
  const captureFirstCheckbox = document.getElementById('captureFirstCheckbox');
  const btnSave     = document.getElementById('btnSave');
  const btnDelete   = document.getElementById('btnDelete');
  const saveNameInput = document.getElementById('saveNameInput');
  const savedRecordingsSelect = document.getElementById('savedRecordingsSelect');

  const macroEnabledToggle = document.getElementById('macroEnabledToggle');
  const macroPanel  = document.getElementById('macroPanel');
  const macroToggleRow = document.getElementById('macroToggleRow');
  const macroBadge  = document.getElementById('macroBadge');
  const recordSection = document.getElementById('recordSection');
  const saveSection = document.getElementById('saveSection');

  let currentState = {};
  let hasUnsavedRecording = false; // true after recording stops before saving
  let prevIsRecording = false;

  // ── Macro toggle ──────────────────────────────────────
  function setMacroOpen(open) {
    macroEnabledToggle.checked = open;
    macroPanel.classList.toggle('open', open);
    chrome.runtime.sendMessage({ command: 'updateMacroEnabled', macroEnabled: open });
  }

  // Fix: stop propagation from the toggle switch label so it doesn't double-fire
  macroToggleRow.addEventListener('click', (e) => {
    if (e.target.closest('.toggle-switch')) return; // native label handles the checkbox
    // Clicked elsewhere on the row — manually flip
    macroEnabledToggle.checked = !macroEnabledToggle.checked;
    setMacroOpen(macroEnabledToggle.checked);
  });

  macroEnabledToggle.addEventListener('change', () => {
    setMacroOpen(macroEnabledToggle.checked);
  });

  // ── Macro panel: show/hide sections ──────────────────
  function refreshMacroPanelSections() {
    const isNew = savedRecordingsSelect.value === '';
    const isRecording = currentState.isRecording || false;

    // Record section only visible in New mode
    recordSection.style.display = isNew ? 'flex' : 'none';

    // Delete button only when a saved recording is selected
    btnDelete.style.display = isNew ? 'none' : 'inline-flex';

    // Save row: only after a new recording was stopped
    const showSave = isNew && hasUnsavedRecording && !isRecording;
    saveSection.style.display = showSave ? 'flex' : 'none';
  }

  // ── Area buttons ──────────────────────────────────────
  function setActiveAreaBtn(ratio) {
    areaBtns.forEach(b => b.classList.toggle('active', b.dataset.ratio === ratio));
  }

  areaBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.ratio;
      setActiveAreaBtn(val);
      if (val === 'full') {
        chrome.runtime.sendMessage({ command: 'clearArea' }, (response) => {
          if (response) updateUI(response);
        });
      } else {
        btnSetArea.style.display = 'block';
        btnSetArea.textContent = 'Draw Area on Page';
      }
    });
  });

  btnSetArea.addEventListener('click', () => {
    const activeBtn = document.querySelector('.area-btn.active');
    const ratioVal = activeBtn ? activeBtn.dataset.ratio : 'free';
    const ratio = ratioVal === 'free' ? null : parseFloat(ratioVal);
    chrome.runtime.sendMessage({ command: 'startSelectingArea', ratio }, (response) => {
      if (response) updateUI(response);
    });
  });

  // ── Recordings select — auto-load on change ───────────
  savedRecordingsSelect.addEventListener('change', () => {
    hasUnsavedRecording = false;
    const name = savedRecordingsSelect.value;
    if (name) {
      chrome.runtime.sendMessage({ command: 'loadRecording', name }, (response) => {
        if (response) updateUI(response);
      });
    } else {
      // "New Recording" selected — clear current actions
      chrome.runtime.sendMessage({ command: 'clearActions' }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  // ── UI update ─────────────────────────────────────────
  function updateUI(state) {
    currentState = state;

    // Detect when recording just stopped → mark unsaved
    if (prevIsRecording && !state.isRecording && state.actions.length > 0) {
      hasUnsavedRecording = true;
    }
    prevIsRecording = state.isRecording;

    actionCount.textContent = state.actions.length;

    if (document.activeElement !== prefixInput) {
      prefixInput.value = state.prefix || '';
    }
    if (document.activeElement !== captureFirstCheckbox) {
      captureFirstCheckbox.checked = state.captureFirst || false;
    }

    // Macro enabled
    const macroOn = state.macroEnabled || false;
    macroEnabledToggle.checked = macroOn;
    macroPanel.classList.toggle('open', macroOn);

    // Badge
    if (macroOn && state.actions.length > 0) {
      macroBadge.style.display = 'inline';
      macroBadge.textContent = state.actions.length;
    } else {
      macroBadge.style.display = 'none';
    }

    // Rebuild recordings dropdown (preserve selection)
    if (state.savedRecordings && document.activeElement !== savedRecordingsSelect) {
      const currentVal = savedRecordingsSelect.value;
      savedRecordingsSelect.innerHTML = '<option value="">＋ New Recording</option>';
      for (const name of Object.keys(state.savedRecordings)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        if (name === currentVal) option.selected = true;
        savedRecordingsSelect.appendChild(option);
      }
    }

    // Macro panel section visibility
    refreshMacroPanelSections();

    // Capture area
    if (state.captureRect) {
      const activeRatio = state.captureRatio ? String(state.captureRatio) : 'free';
      setActiveAreaBtn(activeRatio);
      areaStatus.textContent = `Custom (${state.captureRect.width}×${state.captureRect.height})`;
      btnSetArea.style.display = 'block';
      btnSetArea.textContent = 'Redraw Area';
    } else {
      setActiveAreaBtn('full');
      areaStatus.textContent = 'Full Page';
      btnSetArea.style.display = 'none';
      btnSetArea.textContent = 'Draw Area on Page';
    }

    // Global state modes
    if (state.isSelectingArea) {
      statusDisplay.textContent = 'Draw Rectangle...';
      statusDisplay.className = 'status recording';
      statusDisplay.classList.remove('hidden');
      btnRecord.disabled = true;
      btnPlay.disabled = true;
      btnSetArea.disabled = true;
      areaBtns.forEach(b => b.disabled = true);

    } else if (state.isRecording) {
      statusDisplay.textContent = 'Recording...';
      statusDisplay.className = 'status recording';
      statusDisplay.classList.remove('hidden');
      btnRecord.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop`;
      btnRecord.className = 'btn danger record-btn';
      btnRecord.disabled = false;
      btnPlay.disabled = true;

    } else if (state.isPlaying) {
      statusDisplay.textContent = 'Playing...';
      statusDisplay.className = 'status playing';
      statusDisplay.classList.remove('hidden');
      btnRecord.disabled = true;
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop`;
      btnPlay.className = 'btn danger';
      btnPlay.disabled = false;

    } else {
      // Idle
      statusDisplay.className = 'status hidden';
      btnRecord.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8"/></svg> Record`;
      btnRecord.className = 'btn primary record-btn';
      btnRecord.disabled = false;
      btnPlay.innerHTML = `<svg class="btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Run`;
      btnPlay.className = 'btn success';
      btnPlay.disabled = false;
      btnSetArea.disabled = false;
      areaBtns.forEach(b => b.disabled = false);
    }
  }

  function fetchState() {
    chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
      if (response) updateUI(response);
    });
  }

  // ── Button listeners ──────────────────────────────────
  btnRecord.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'toggleRecording' }, (response) => {
      if (response) updateUI(response);
    });
  });

  btnPlay.addEventListener('click', () => {
    if (btnPlay.textContent.includes('Stop')) {
      chrome.runtime.sendMessage({ command: 'stopPlayback' }, (response) => {
        if (response) updateUI(response);
      });
    } else {
      const prefix = prefixInput.value.trim();
      chrome.runtime.sendMessage({ command: 'startPlayback', prefix }, (response) => {
        if (response) updateUI(response);
      });
    }
  });

  prefixInput.addEventListener('input', () => {
    chrome.runtime.sendMessage({ command: 'updatePrefix', prefix: prefixInput.value });
  });

  captureFirstCheckbox.addEventListener('change', () => {
    chrome.runtime.sendMessage({ command: 'updateCaptureFirst', captureFirst: captureFirstCheckbox.checked });
  });

  btnSave.addEventListener('click', () => {
    const name = saveNameInput.value.trim();
    if (!name) return;
    chrome.runtime.sendMessage({ command: 'saveRecording', name }, (response) => {
      if (response) {
        hasUnsavedRecording = false;
        saveNameInput.value = '';
        // After saving, select the new recording in the dropdown
        updateUI(response);
        savedRecordingsSelect.value = name;
        refreshMacroPanelSections();
      }
    });
  });

  btnDelete.addEventListener('click', () => {
    const name = savedRecordingsSelect.value;
    if (!name) return;
    chrome.runtime.sendMessage({ command: 'deleteRecording', name }, (response) => {
      if (response) {
        savedRecordingsSelect.value = '';
        updateUI(response);
      }
    });
  });

  // Background state updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATE_UPDATE') {
      updateUI(message.state);
    }
  });

  fetchState();
});
