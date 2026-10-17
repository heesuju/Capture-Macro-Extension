(function() {
  if (window.__autoCaptureInitialized) return;
  window.__autoCaptureInitialized = true;

  let isRecording = false;
  let captureRectDiv = null;
  let rectRatio = null;      // locked width/height ratio of the area, or null for free
  let rectLocked = false;    // set by the background while a macro plays back

  // Fetch initial state in case we were just injected
  chrome.runtime.sendMessage({ command: 'getState' }, (response) => {
    if (response) {
      isRecording = response.isRecording;
      if (isRecording) {
        console.log('Cheezing: Initialized in recording state');
      }
      rectRatio = typeof response.captureRatio === 'number' ? response.captureRatio : null;
      rectLocked = !!response.isPlaying;
      if (response.captureRect) {
        drawPersistentRect(response.captureRect);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.command === 'setRecordingState') {
      isRecording = message.isRecording;
      if (isRecording) {
        hookAllDocuments();
        console.log('Cheezing: Recording started');
      } else {
        console.log('Cheezing: Recording stopped');
      }
      updateRectInteractivity();
      sendResponse({ success: true });
    } else if (message.command === 'setRectLocked') {
      rectLocked = message.locked;
      updateRectInteractivity();
      sendResponse({ success: true });
    } else if (message.command === 'startSelectingArea') {
      startSelection(message.ratio);
      sendResponse({ success: true });
    } else if (message.command === 'clearArea') {
      if (captureRectDiv) {
        captureRectDiv.remove();
        captureRectDiv = null;
        currentRect = null;
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
    } else if (message.command === 'getPageActivity') {
      sendResponse(getPageActivity());
    } else if (message.command === 'setLeaveGuard') {
      if (message.enable) {
        window.addEventListener('beforeunload', confirmLeave);
      } else {
        window.removeEventListener('beforeunload', confirmLeave);
      }
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

  // ── Same-origin frames ──────────────────────────────────────────────
  // Some sites (e.g. Naver blogs) show the whole page inside a same-origin
  // iframe that scrolls on its own. The script runs in the top frame only,
  // so it reaches into those frames directly. Cross-origin frames stay opaque.
  function frameDocument(frame) {
    try {
      return frame.contentDocument;
    } catch (err) {
      return null;
    }
  }

  // Calls fn for the top document and every same-origin frame document in it
  function forEachDocument(fn, doc = document) {
    fn(doc);
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      const child = frameDocument(frame);
      if (child) forEachDocument(fn, child);
    }
  }

  function viewOf(node) {
    const doc = node.ownerDocument || node;
    return doc.defaultView || window;
  }

  // Top-left of a frame window's viewport, in top-frame viewport px
  function frameOffset(win) {
    let x = 0;
    let y = 0;
    while (win.document !== document && win.frameElement) {
      const frame = win.frameElement;
      const r = frame.getBoundingClientRect();
      const cs = viewOf(frame).getComputedStyle(frame);
      x += r.left + frame.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      y += r.top + frame.clientTop + (parseFloat(cs.paddingTop) || 0);
      win = viewOf(frame);
    }
    return { x, y };
  }

  function offsetRegion(r, o) {
    return { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
  }

  // ── Page activity (for waiting until the page settles) ───────────────
  // Started on first request; the page counts as just-changed at that point
  // so it must then stay quiet for the full window. Frame documents are
  // picked up as they appear (e.g. after an iframe navigates), and count as
  // just-changed too.
  let lastMutationAt = 0;
  const observedDocuments = new WeakSet();

  function getPageActivity() {
    let fontsLoading = false;
    forEachDocument((doc) => {
      if (!observedDocuments.has(doc)) {
        observedDocuments.add(doc);
        lastMutationAt = Date.now();
        new MutationObserver(() => { lastMutationAt = Date.now(); })
          .observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      if (doc.fonts && doc.fonts.status === 'loading') fontsLoading = true;
    });
    return {
      msSinceMutation: Date.now() - lastMutationAt,
      pendingImages: countPendingImagesInView(),
      fontsLoading
    };
  }

  function countPendingImagesInView() {
    let pending = 0;
    forEachDocument((doc) => {
      const win = viewOf(doc);
      for (const img of doc.images) {
        if (img.complete) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth) pending++;
      }
    });
    return pending;
  }

  // Shows Chrome's "Leave site?" dialog while a capture is in progress
  function confirmLeave(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  // el -> original inline visibility. Kept as a map so repeated enable calls
  // (one per tile) add newly-appearing elements without recording our own
  // 'hidden' as the value to restore.
  const suppressedStickyElements = new Map();

  // Hides every fixed element and every sticky element that is currently
  // stuck, so nothing repeats down a scroll strip. Covers each document from
  // the top down to the one being scrolled, but never an element holding the
  // scroller itself (a fixed panel, or the iframe the page lives in).
  function suppressStickyElements(enable) {
    if (!enable) {
      for (const [el, origVisibility] of suppressedStickyElements) {
        el.style.visibility = origVisibility;
      }
      suppressedStickyElements.clear();
      return;
    }
    const scroller = stripScroller || { win: window, el: null };
    const keep = scrollerChain(scroller);
    for (const doc of keep.documents) {
      for (const el of doc.querySelectorAll('*')) {
        if (suppressedStickyElements.has(el) || el === captureRectDiv) continue;
        if (keep.nodes.some((node) => el.contains(node))) continue;
        suppressStickyElement(el);
      }
    }
  }

  // The documents from the top down to the scroller's, and the nodes in them
  // that contain the scroller (iframe elements, and the scrolled element).
  function scrollerChain(scroller) {
    const documents = [];
    const nodes = scroller.el ? [scroller.el] : [];
    let win = scroller.win;
    for (;;) {
      documents.unshift(win.document);
      if (win.document === document || !win.frameElement) break;
      nodes.push(win.frameElement);
      win = viewOf(win.frameElement);
    }
    return { documents, nodes };
  }

  function suppressStickyElement(el) {
    const style = viewOf(el).getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    if (pos === 'fixed' || isStuck(el, style, rect)) {
      suppressedStickyElements.set(el, el.style.visibility);
      el.style.visibility = 'hidden';
    }
  }

  // A sticky element in normal flow is regular page content and must stay
  // visible; only hide it while it is pinned to its scroll container's edge.
  function isStuck(el, style, rect) {
    const scroller = findScrollParent(el.parentElement);
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: viewOf(el).innerHeight };
    const top = parseFloat(style.top);
    const bottom = parseFloat(style.bottom);
    if (!isNaN(top) && Math.abs(rect.top - (box.top + top)) < 2) return true;
    if (!isNaN(bottom) && Math.abs(box.bottom - bottom - rect.bottom) < 2) return true;
    return false;
  }

  function isScrollable(el) {
    if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) return false;
    const oy = viewOf(el).getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  }

  function findScrollParent(el) {
    while (el && el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Scroll strip ────────────────────────────────────────────────────
  // The strip is built by scrolling one "scroller" and capturing a fixed
  // viewport region each step. A scroller is { win, el }: an inner scrollable
  // element `el` (chat log, table, side pane...) in window `win`, or with
  // el = null, the document of `win` itself -- the page, or a same-origin
  // frame the page lives in. Positions are reported back as actually
  // reached, so the background can crop away any overlap exactly.
  let stripScroller = null;
  let stripOrigin = null;   // scroll position to restore afterwards

  // Without a selected area, an inner scroller is used only if it covers at
  // least this share of the viewport, so a small scroll box that happens to
  // sit in the middle of the page isn't taken for the page.
  const MIN_FULL_PAGE_SCROLLER_SHARE = 0.5;

  // A window's viewport in its own px; clientWidth/Height exclude scrollbars,
  // so they never end up in the strip
  function windowRegion(win = window) {
    const doc = win.document.documentElement;
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

  // The visible part of a window's viewport, in top-frame px
  function visibleWindowRegion(win) {
    let region = offsetRegion(windowRegion(win), frameOffset(win));
    while (win.document !== document && win.frameElement) {
      win = viewOf(win.frameElement);
      region = intersect(region, offsetRegion(windowRegion(win), frameOffset(win)));
    }
    return region;
  }

  // The scroller's visible area, in top-frame px
  function scrollerRegion(s) {
    const view = visibleWindowRegion(s.win);
    if (!s.el) return view;
    return intersect(view, offsetRegion(elementRegion(s.el), frameOffset(s.win)));
  }

  function scrollTop(s) {
    return s.el ? s.el.scrollTop : s.win.scrollY;
  }

  function maxScrollTop(s) {
    if (s.el) return s.el.scrollHeight - s.el.clientHeight;
    const doc = s.win.document;
    const body = doc.body ? doc.body.scrollHeight : 0;
    return Math.max(doc.documentElement.scrollHeight, body) - doc.documentElement.clientHeight;
  }

  function scrollLeft(s) {
    return s.el ? s.el.scrollLeft : s.win.scrollX;
  }

  function scrollerTo(s, top, left = scrollLeft(s)) {
    (s.el || s.win).scrollTo({ top, left, behavior: 'instant' });
  }

  // The innermost scroller under a top-frame point: descends into same-origin
  // frames, then climbs back out to the first element or frame document that
  // can scroll. Returns null if only the top page itself is left.
  function findScrollerAt(x, y) {
    let win = window;
    let hit = document.elementFromPoint(x, y);
    while (hit && (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME')) {
      const doc = frameDocument(hit);
      if (!doc || !doc.defaultView) break;
      win = doc.defaultView;
      const o = frameOffset(win);
      hit = doc.elementFromPoint(x - o.x, y - o.y);
    }
    for (;;) {
      const el = hit && findScrollParent(hit);
      if (el) return { win, el };
      if (win.document === document || !win.frameElement) return null;
      if (maxScrollTop({ win, el: null }) > 1) return { win, el: null };
      hit = win.frameElement;
      win = viewOf(hit);
    }
  }

  function beginScrollStrip(rect) {
    const page = { win: window, el: null };
    const view = windowRegion();
    const area = rect ? intersect(view, rect) : view;
    let scroller = null;

    // With an area, scroll whatever sits under it. Without one, scroll the
    // page -- unless it can't scroll, as when it lives in a big iframe.
    if (rect || maxScrollTop(page) <= 1) {
      if (captureRectDiv) captureRectDiv.style.display = 'none';
      scroller = findScrollerAt(area.x + area.width / 2, area.y + area.height / 2);
      if (scroller && !rect) {
        const r = scrollerRegion(scroller);
        if (r.width * r.height < MIN_FULL_PAGE_SCROLLER_SHARE * view.width * view.height) scroller = null;
      }
    }
    stripScroller = scroller || page;

    let region = scroller ? scrollerRegion(scroller) : view;
    if (rect) region = intersect(region, rect);

    stripOrigin = {
      scroller: stripScroller,
      top: scrollTop(stripScroller),
      left: scrollLeft(stripScroller)
    };

    return {
      region,
      innerWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      scroller: !stripScroller.el && stripScroller.win.document === document
        ? 'window'
        : stripScroller.el ? 'element' : 'frame'
    };
  }

  function scrollStripTo(y) {
    const s = stripScroller || { win: window, el: null };
    scrollerTo(s, y);
    return { actual: scrollTop(s), maxScroll: maxScrollTop(s) };
  }

  function endScrollStrip() {
    suppressStickyElements(false);
    if (stripOrigin) {
      scrollerTo(stripOrigin.scroller, stripOrigin.top, stripOrigin.left);
    }
    stripScroller = null;
    stripOrigin = null;
  }

  // ── Recording ───────────────────────────────────────────────────────
  // Listens in the top document and every same-origin frame document, and
  // hooks frames again whenever one (re)loads. Clicks are recorded in
  // top-frame px, which is where playback dispatches them.
  const hookedDocuments = new WeakSet();

  function hookAllDocuments() {
    forEachDocument(hookDocument);
  }

  function hookDocument(doc) {
    if (hookedDocuments.has(doc)) return;
    hookedDocuments.add(doc);
    doc.addEventListener('mousedown', (e) => recordMouseDown(e, doc), true); // capture phase: intercept as early as possible
    doc.addEventListener('keydown', recordKeyDown, true);
    // load doesn't bubble, but capture-phase listeners still see it
    doc.addEventListener('load', (e) => {
      if (e.target.tagName === 'IFRAME' || e.target.tagName === 'FRAME') hookAllDocuments();
    }, true);
  }

  function recordMouseDown(e, doc) {
    if (!isRecording) return;
    const o = frameOffset(viewOf(doc));

    // Send the click coordinates to the background script
    chrome.runtime.sendMessage({
      command: 'recordAction',
      action: {
        type: 'click',
        x: e.clientX + o.x,
        y: e.clientY + o.y,
        timestamp: Date.now()
      }
    });
  }

  function recordKeyDown(e) {
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
  }

  hookAllDocuments();


// ── Capture area box ──────────────────────────────────────────────────
// The box itself ignores the mouse so the page under it stays usable; only
// its border strips (drag to move) and handles (drag to resize) respond.
// They are switched off while recording or playing back a macro, so macro
// clicks always reach the page.
const EDGE_GRAB = 8;        // px width of the draggable border strips
const HANDLE_SIZE = 10;     // px
const MIN_AREA_SIZE = 10;   // px, smallest width/height when resizing
const HANDLES = {           // [moves left, top, right, bottom edge]
  nw: [1, 1, 0, 0], n: [0, 1, 0, 0], ne: [0, 1, 1, 0], e: [0, 0, 1, 0],
  se: [0, 0, 1, 1], s: [0, 0, 0, 1], sw: [1, 0, 0, 1], w: [1, 0, 0, 0]
};
let currentRect = null;
let sizeTag = null;

function drawPersistentRect(rect) {
  if (!captureRectDiv) buildRectBox();
  currentRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  layoutRectBox();
  captureRectDiv.style.display = 'block';
  updateRectInteractivity();
}

function buildRectBox() {
  captureRectDiv = document.createElement('div');
  Object.assign(captureRectDiv.style, {
    position: 'fixed',
    border: '2px dashed red',
    backgroundColor: 'rgba(255, 0, 0, 0.1)',
    pointerEvents: 'none',
    zIndex: '9999999',
    boxSizing: 'border-box'
  });

  // Border strips: drag to move
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const strip = document.createElement('div');
    strip.dataset.cheezingGrip = 'move';
    const horizontal = side === 'top' || side === 'bottom';
    Object.assign(strip.style, {
      position: 'absolute',
      cursor: 'move',
      [side]: `-${EDGE_GRAB / 2}px`,
      [horizontal ? 'left' : 'top']: '0',
      [horizontal ? 'width' : 'height']: '100%',
      [horizontal ? 'height' : 'width']: `${EDGE_GRAB}px`
    });
    strip.addEventListener('mousedown', (e) => startRectDrag(e, 'move'));
    captureRectDiv.appendChild(strip);
  }

  // Handles: drag to resize
  for (const name of Object.keys(HANDLES)) {
    const handle = document.createElement('div');
    handle.dataset.cheezingGrip = name;
    const [l, t, r, b] = HANDLES[name];
    Object.assign(handle.style, {
      position: 'absolute',
      width: `${HANDLE_SIZE}px`,
      height: `${HANDLE_SIZE}px`,
      background: '#fff',
      border: '2px solid red',
      boxSizing: 'border-box',
      cursor: `${name}-resize`,
      left: l ? `-${HANDLE_SIZE / 2}px` : r ? `calc(100% - ${HANDLE_SIZE / 2}px)` : `calc(50% - ${HANDLE_SIZE / 2}px)`,
      top: t ? `-${HANDLE_SIZE / 2}px` : b ? `calc(100% - ${HANDLE_SIZE / 2}px)` : `calc(50% - ${HANDLE_SIZE / 2}px)`
    });
    handle.addEventListener('mousedown', (e) => startRectDrag(e, name));
    captureRectDiv.appendChild(handle);
  }

  // Close button above the top-right corner: clears the area
  const closeBtn = document.createElement('div');
  closeBtn.dataset.cheezingGrip = 'close';
  closeBtn.textContent = '×';
  chrome.storage.local.get('settings', ({ settings }) => {
    closeBtn.title = settings && settings.language === 'ko' ? '영역 지우기' : 'Clear area';
  });
  Object.assign(closeBtn.style, {
    position: 'absolute',
    right: '-2px',
    bottom: '100%',
    marginBottom: '6px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    background: 'red',
    color: '#fff',
    font: '700 14px/18px sans-serif',
    textAlign: 'center',
    cursor: 'pointer',
    userSelect: 'none'
  });
  closeBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ command: 'clearArea' });
  });
  captureRectDiv.appendChild(closeBtn);

  // Size readout shown while dragging
  sizeTag = document.createElement('div');
  Object.assign(sizeTag.style, {
    position: 'absolute',
    left: '0',
    bottom: '100%',
    marginBottom: '6px',
    padding: '2px 6px',
    background: 'red',
    color: '#fff',
    font: '600 11px/1.4 sans-serif',
    borderRadius: '3px',
    whiteSpace: 'nowrap',
    display: 'none'
  });
  captureRectDiv.appendChild(sizeTag);

  document.body.appendChild(captureRectDiv);
}

function layoutRectBox() {
  const r = currentRect;
  Object.assign(captureRectDiv.style, {
    left: r.x + 'px',
    top: r.y + 'px',
    width: r.width + 'px',
    height: r.height + 'px'
  });
  sizeTag.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
}

function updateRectInteractivity() {
  if (!captureRectDiv) return;
  const editable = !isRecording && !rectLocked;
  for (const grip of captureRectDiv.querySelectorAll('[data-cheezing-grip]')) {
    const name = grip.dataset.cheezingGrip;
    // With a locked ratio only the corners resize (they keep the ratio)
    const sideHandle = name.length === 1;
    const visible = editable && !(sideHandle && rectRatio);
    grip.style.pointerEvents = visible ? 'auto' : 'none';
    if (name !== 'move') grip.style.display = visible ? 'block' : 'none';
  }
}

function startRectDrag(e, grip) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const start = { ...currentRect };
  const startX = e.clientX;
  const startY = e.clientY;
  const doc = document.documentElement;
  const maxW = doc.clientWidth;
  const maxH = doc.clientHeight;
  sizeTag.style.display = 'block';

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (grip === 'move') {
      currentRect.x = clamp(start.x + dx, 0, maxW - start.width);
      currentRect.y = clamp(start.y + dy, 0, maxH - start.height);
    } else {
      currentRect = resizeRect(start, HANDLES[grip], dx, dy, maxW, maxH);
    }
    layoutRectBox();
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    sizeTag.style.display = 'none';
    chrome.runtime.sendMessage({
      command: 'areaUpdated',
      rect: { ...currentRect, devicePixelRatio: window.devicePixelRatio || 1 }
    });
  };

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

function resizeRect(start, [l, t, r, b], dx, dy, maxW, maxH) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (l) left = clamp(left + dx, 0, right - MIN_AREA_SIZE);
  if (r) right = clamp(right + dx, left + MIN_AREA_SIZE, maxW);
  if (t) top = clamp(top + dy, 0, bottom - MIN_AREA_SIZE);
  if (b) bottom = clamp(bottom + dy, top + MIN_AREA_SIZE, maxH);

  if (rectRatio) {
    // Corner drag with a locked ratio: follow whichever direction moved more,
    // anchored at the opposite corner, then shrink to fit the screen.
    let w = right - left;
    let h = bottom - top;
    if (w / start.width >= h / start.height) h = w / rectRatio; else w = h * rectRatio;
    const anchorX = l ? start.x + start.width : start.x;
    const anchorY = t ? start.y + start.height : start.y;
    const roomW = l ? anchorX : maxW - anchorX;
    const roomH = t ? anchorY : maxH - anchorY;
    const fit = Math.min(1, roomW / w, roomH / h);
    w *= fit;
    h *= fit;
    left = l ? anchorX - w : anchorX;
    top = t ? anchorY - h : anchorY;
    right = left + w;
    bottom = top + h;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

const MIN_SELECTION_SIZE = 5; // px; smaller drags count as a click, i.e. cancel

function startSelection(ratio) {
  // Hide the current area while drawing, so its grips can't catch the drag
  if (captureRectDiv) captureRectDiv.style.display = 'none';
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

  // Removes the overlay and all of its listeners
  const finish = () => {
    overlay.remove();
    overlay.removeEventListener('mousedown', onMouseDown);
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown, true);
  };

  // Esc (or a click without dragging) cancels and keeps the previous area
  const cancel = () => {
    finish();
    if (captureRectDiv && currentRect) captureRectDiv.style.display = 'block';
    chrome.runtime.sendMessage({ command: 'areaSelectionCancelled' });
  };

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
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

    if (width < MIN_SELECTION_SIZE || height < MIN_SELECTION_SIZE) {
      cancel();
      return;
    }
    finish();
    rectRatio = ratio || null;

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
  document.addEventListener('keydown', onKeyDown, true);
}
})();

