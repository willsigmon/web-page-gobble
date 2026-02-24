/**
 * Web Page Gobble — Content Script
 * Runs inside the target page. Handles:
 *   - Measuring full page dimensions
 *   - Scrolling through the page viewport-by-viewport
 *   - Signaling the background to capture each viewport
 *   - Collecting page context metadata (title, URL, headings, meta)
 *   - Hiding fixed/sticky elements after first capture to avoid duplication
 *
 * IMPORTANT: Chrome enforces a hard limit of 2 captureVisibleTab calls/sec.
 * The background worker handles this, but we add a 350ms settle delay here
 * to ensure repaint completes before signaling capture.
 */

(() => {
  if (window.__gobbleInjected) return;
  window.__gobbleInjected = true;

  const SETTLE_DELAY_MS = 350; // time after scroll for repaint to finish

  let scrollIndex = 0;
  let totalScrolls = 0;
  let pageHeight = 0;
  let viewportHeight = 0;
  let originalScrollY = 0;
  let originalScrollBehavior = '';
  let settings = {};
  let fixedElements = [];
  let overlay = null;

  // ── Message Handler ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
    const handlers = {
      'begin-scroll-capture': () => beginCapture(msg.settings),
      'next-scroll': () => captureNextViewport(),
      'capture-error': () => cleanupCapture(msg.error),
      'status-update': () => updateOverlay(msg.status),
    };
    handlers[msg.action]?.();
  });

  // ── Capture Orchestration ───────────────────────────────────────────────

  function beginCapture(cfg) {
    settings = cfg;
    originalScrollY = window.scrollY;

    // Disable smooth scrolling — we need instant jumps
    originalScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';

    // Hide scrollbar to avoid it appearing in captures
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'visible';

    // Measure full page
    pageHeight = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.documentElement.clientHeight
    );
    viewportHeight = window.innerHeight;
    totalScrolls = Math.ceil(pageHeight / viewportHeight);
    scrollIndex = 0;

    showOverlay();
    detectFixedElements();

    // Scroll to top and start
    window.scrollTo(0, 0);
    waitForSettleThenCapture();
  }

  function captureNextViewport() {
    scrollIndex++;

    // After the first viewport is captured, hide fixed/sticky elements
    // so they don't repeat in every subsequent frame
    if (scrollIndex === 1) {
      applyFixedElementHiding();
    }

    if (scrollIndex >= totalScrolls) {
      finishCapture();
      return;
    }

    const targetY = scrollIndex * viewportHeight;
    window.scrollTo(0, targetY);
    waitForSettleThenCapture();
  }

  function waitForSettleThenCapture() {
    // Wait for the next animation frame (ensures scroll has applied),
    // then wait SETTLE_DELAY for lazy-loaded images and repaint
    requestAnimationFrame(() => {
      setTimeout(() => requestCaptureOfCurrentViewport(), SETTLE_DELAY_MS);
    });
  }

  function requestCaptureOfCurrentViewport() {
    const currentY = window.scrollY;
    const remaining = pageHeight - currentY;
    const clipHeight = Math.min(viewportHeight, remaining);

    updateOverlay(`Capturing ${scrollIndex + 1} of ${totalScrolls}`);

    chrome.runtime.sendMessage({
      action: 'capture-viewport',
      scrollY: currentY,
      viewportHeight,
      clipHeight,
      index: scrollIndex,
    });
  }

  function finishCapture() {
    const pageInfo = collectPageInfo();

    chrome.runtime.sendMessage({
      action: 'capture-complete',
      pageInfo,
    });

    cleanup();
  }

  function cleanupCapture(error) {
    cleanup();
    if (error) console.error('SnapForge capture error:', error);
  }

  function cleanup() {
    restoreFixedElements();
    document.documentElement.style.scrollBehavior = originalScrollBehavior;
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
    window.scrollTo(0, originalScrollY);
    removeOverlay();
  }

  // ── Page Info Collector ─────────────────────────────────────────────────

  function collectPageInfo() {
    const headings = [];
    document.querySelectorAll('h1, h2, h3').forEach((h) => {
      headings.push({
        level: parseInt(h.tagName[1]),
        text: h.textContent.trim().slice(0, 200),
        offsetTop: h.offsetTop,
      });
    });

    const metaTags = {};
    document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
      const key = m.getAttribute('name') || m.getAttribute('property');
      const val = m.getAttribute('content');
      if (key && val) metaTags[key] = val.slice(0, 500);
    });

    const links = [];
    document.querySelectorAll('a[href]').forEach((a) => {
      const href = a.href;
      const text = a.textContent.trim().slice(0, 100);
      if (href && text && !href.startsWith('javascript:')) {
        links.push({ href, text });
      }
    });

    // Collect visible text content for DOM-based text extraction
    const visibleText = extractVisibleText();

    return {
      url: window.location.href,
      title: document.title,
      pageHeight,
      viewportHeight,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
      headings,
      metaTags,
      linkCount: links.length,
      topLinks: links.slice(0, 50),
      capturedAt: new Date().toISOString(),
      documentLang: document.documentElement.lang || 'unknown',
      visibleText: visibleText.slice(0, 50000), // cap at 50k chars
    };
  }

  function extractVisibleText() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }

          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return NodeFilter.FILTER_REJECT;
          }

          const text = node.textContent.trim();
          return text.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      }
    );

    const chunks = [];
    while (walker.nextNode()) {
      chunks.push(walker.currentNode.textContent.trim());
    }
    return chunks.join('\n');
  }

  // ── Fixed Element Management ────────────────────────────────────────────

  function detectFixedElements() {
    fixedElements = [];
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        fixedElements.push({
          el,
          origVisibility: el.style.visibility,
        });
      }
    });
  }

  function applyFixedElementHiding() {
    fixedElements.forEach(({ el }) => {
      el.style.visibility = 'hidden';
    });
  }

  function restoreFixedElements() {
    fixedElements.forEach(({ el, origVisibility }) => {
      el.style.visibility = origVisibility;
    });
    fixedElements = [];
  }

  // ── Overlay UI ──────────────────────────────────────────────────────────

  function showOverlay() {
    overlay = document.createElement('div');
    overlay.id = 'gobble-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.3); z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      pointer-events: none;
    `;
    overlay.innerHTML = `
      <div style="
        background: #1a1a2e; color: #e0e0ff; padding: 24px 40px;
        border-radius: 12px; font-size: 16px; text-align: center;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      ">
        <div style="font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #E8A849;">
          Gobble gobble...
        </div>
        <div id="gobble-status">Measuring page...</div>
        <div style="margin-top: 12px; width: 200px; height: 4px; background: #333; border-radius: 2px; overflow: hidden;">
          <div id="gobble-progress" style="width: 0%; height: 100%; background: #D4762C; transition: width 0.3s;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function updateOverlay(status) {
    const statusEl = document.getElementById('gobble-status');
    const progressEl = document.getElementById('gobble-progress');
    if (statusEl) statusEl.textContent = status;
    if (progressEl && totalScrolls > 0) {
      progressEl.style.width = `${Math.round(((scrollIndex + 1) / totalScrolls) * 100)}%`;
    }
  }

  function removeOverlay() {
    overlay?.remove();
    overlay = null;
  }
})();
