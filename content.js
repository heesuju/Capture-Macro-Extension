(function() {
  if (window.__autoCaptureInitialized) return;
  window.__autoCaptureInitialized = true;

  let isRecording = false;
  let captureRectDiv = null;

  // Fetch initial state in case we were just injected
  chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
    if (response) {
      isRecording = response.isRecording;
      if (isRecording) {
        console.log('CheeseIt: Initialized in recording state');
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
        console.log('CheeseIt: Recording started');
      } else {
        console.log('CheeseIt: Recording stopped');
      }
      sendResponse({ success: true });
    } else if (message.command === 'startSelectingArea') {
      startSelection(message.ratio);
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
    } else if (message.command === 'suppressStickyElements') {
      suppressStickyElements(message.enable);
      sendResponse({ success: true });
    } else if (message.command === 'beginScrollStrip') {
      sendResponse(beginScrollStrip(message.rect));
    } else if (message.command === 'scrollStripTo') {
      sendResponse(scrollStripTo(message.y));
    } else if (message.command === 'endScrollStrip') {
      endScrollStrip();
      sendResponse({ success: true });
    }
  });

  // el -> original inline visibility. Kept as a map so repeated enable calls
  // (one per tile) add newly-appearing elements without recording our own
  // 'hidden' as the value to restore.
  const suppressedStickyElements = new Map();

  // Hides every fixed element and every sticky element that is currently
  // stuck, so nothing repeats down a scroll strip.
  function suppressStickyElements(enable) {
    if (!enable) {
      for (const [el, origVisibility] of suppressedStickyElements) {
        el.style.visibility = origVisibility;
      }
      suppressedStickyElements.clear();
      return;
    }
    for (const el of document.querySelectorAll('*')) {
      if (suppressedStickyElements.has(el) || el === captureRectDiv) continue;
      const style = window.getComputedStyle(el);
      const pos = style.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      if (pos === 'fixed' || isStuck(el, style, rect)) {
        suppressedStickyElements.set(el, el.style.visibility);
        el.style.visibility = 'hidden';
      }
    }
  }

  // A sticky element in normal flow is regular page content and must stay
  // visible; only hide it while it is pinned to its scroll container's edge.
  function isStuck(el, style, rect) {
    const scroller = findScrollParent(el.parentElement);
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = parseFloat(style.top);
    const bottom = parseFloat(style.bottom);
    if (!isNaN(top) && Math.abs(rect.top - (box.top + top)) < 2) return true;
    if (!isNaN(bottom) && Math.abs(box.bottom - bottom - rect.bottom) < 2) return true;
    return false;
  }

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const oy = window.getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  }

  function findScrollParent(el) {
    while (el && el !== document.body && el !== document.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Scroll strip ────────────────────────────────────────────────────
  // The strip is built by scrolling one "scroller" (the window, or an inner
  // scrollable element under the selected area) and capturing a fixed
  // viewport region each step. Positions are reported back as actually
  // reached, so the background can crop away any overlap exactly.
  let stripScroller = null; // null = window
  let stripOrigin = null;   // scroll position to restore afterwards

  function windowRegion() {
    // clientWidth/Height exclude scrollbars, so they never end up in the strip
    const doc = document.documentElement;
    return { x: 0, y: 0, width: doc.clientWidth, height: doc.clientHeight };
  }

  function elementRegion(el) {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + el.clientLeft,
      y: r.top + el.clientTop,
      width: el.clientWidth,
      height: el.clientHeight
    };
  }

  function intersect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
  }

  function scrollTop() {
    return stripScroller ? stripScroller.scrollTop : window.scrollY;
  }

  function maxScrollTop() {
    if (stripScroller) return stripScroller.scrollHeight - stripScroller.clientHeight;
    const doc = document.documentElement;
    return Math.max(doc.scrollHeight, document.body.scrollHeight) - doc.clientHeight;
  }

  function beginScrollStrip(rect) {
    stripScroller = null;
    let region = windowRegion();

    if (rect) {
      // If the selection sits on an inner scrollable panel (chat log, table,
      // side pane...), scroll that panel instead of the page.
      if (captureRectDiv) captureRectDiv.style.display = 'none';
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      stripScroller = findScrollParent(hit);
      if (stripScroller) region = elementRegion(stripScroller);
      region = intersect(region, rect);
    }

    stripOrigin = stripScroller
      ? { el: stripScroller, top: stripScroller.scrollTop }
      : { x: window.scrollX, y: window.scrollY };

    return {
      region,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scroller: stripScroller ? 'element' : 'window'
    };
  }

  function scrollStripTo(y) {
    if (stripScroller) {
      stripScroller.scrollTo({ top: y, behavior: 'instant' });
    } else {
      window.scrollTo({ top: y, left: window.scrollX, behavior: 'instant' });
    }
    return { actual: scrollTop(), maxScroll: maxScrollTop() };
  }

  function endScrollStrip() {
    suppressStickyElements(false);
    if (stripOrigin) {
      if (stripOrigin.el) {
        stripOrigin.el.scrollTo({ top: stripOrigin.top, behavior: 'instant' });
      } else {
        window.scrollTo({ top: stripOrigin.y, left: stripOrigin.x, behavior: 'instant' });
      }
    }
    stripScroller = null;
    stripOrigin = null;
  }

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

  document.addEventListener('keydown', (e) => {
    if (!isRecording) return;

    // Skip standalone modifier keys to avoid cluttering recorded actions
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      return;
    }

    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

    chrome.runtime.sendMessage({
      command: 'recordAction',
      action: {
        type: 'keydown',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode || e.which || 0,
        modifiers: modifiers,
        timestamp: Date.now()
      }
    });
  }, true);


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

function startSelection(ratio) {
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
    
    let width = Math.abs(currentX - startX);
    let height = Math.abs(currentY - startY);
    
    if (ratio) {
      if (width / height > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
    }
    
    const x = currentX < startX ? startX - width : startX;
    const y = currentY < startY ? startY - height : startY;
    
    selection.style.left = x + 'px';
    selection.style.top = y + 'px';
    selection.style.width = width + 'px';
    selection.style.height = height + 'px';
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    let width = Math.abs(currentX - startX);
    let height = Math.abs(currentY - startY);
    
    if (ratio) {
      if (width / height > ratio) {
        width = height * ratio;
      } else {
        height = width / ratio;
      }
    }
    
    const x = currentX < startX ? startX - width : startX;
    const y = currentY < startY ? startY - height : startY;
    
    overlay.remove();
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);

    const rect = { 
      x, 
      y, 
      width, 
      height,
      devicePixelRatio: window.devicePixelRatio || 1
    };
    
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
})();

