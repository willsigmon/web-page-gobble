/**
 * Web Page Gobble — Background Service Worker
 * Orchestrates the full-page screenshot capture pipeline:
 *   1. Tells content script to measure page & start scrolling
 *   2. Captures each viewport via chrome.tabs.captureVisibleTab
 *   3. Passes stitched image to processing pipeline (compress, section, OCR)
 */

const DEFAULT_SETTINGS = {
  format: 'png',          // png | jpeg | webp
  quality: 0.92,          // jpeg/webp quality
  maxFileSizeMB: 3,       // target max per-section
  enableOCR: true,
  enableSections: true,
  sectionMaxHeight: 4096, // px per section slice
  compressionStrategy: 'auto', // auto | aggressive | lossless
};

let captureState = null;
let lastCaptureTime = 0;
const MIN_CAPTURE_INTERVAL_MS = 550; // Chrome enforces 2 calls/sec max (500ms); add buffer

// ── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    'start-capture': () => handleStartCapture(sender.tab?.id ?? msg.tabId),
    'capture-viewport': () => handleCaptureViewport(msg, sender),
    'capture-complete': () => handleCaptureComplete(msg, sender),
    'get-settings': () => handleGetSettings(sendResponse),
    'save-settings': () => handleSaveSettings(msg.settings, sendResponse),
  };

  const handler = handlers[msg.action];
  if (handler) {
    handler();
    return true; // keep channel open for async
  }
});

// ── Capture Flow ────────────────────────────────────────────────────────────

async function handleStartCapture(tabId) {
  if (!tabId) return;

  const settings = await loadSettings();
  captureState = {
    tabId,
    settings,
    captures: [],
    status: 'measuring',
    startTime: Date.now(),
  };

  // Inject and run the content script capture routine
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content.js'],
    });
  } catch (_) {
    // content script may already be injected
  }

  chrome.tabs.sendMessage(tabId, {
    action: 'begin-scroll-capture',
    settings,
  });
}

async function handleCaptureViewport(msg, sender) {
  if (!captureState) return;

  const tabId = sender.tab?.id ?? captureState.tabId;

  // Enforce rate limit: Chrome allows max 2 captureVisibleTab calls/sec
  const now = Date.now();
  const elapsed = now - lastCaptureTime;
  if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_CAPTURE_INTERVAL_MS - elapsed));
  }

  try {
    lastCaptureTime = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: captureState.settings.format === 'webp' ? 'png' : captureState.settings.format,
      quality: Math.round(captureState.settings.quality * 100),
    });

    captureState.captures.push({
      dataUrl,
      scrollY: msg.scrollY,
      viewportHeight: msg.viewportHeight,
      clipHeight: msg.clipHeight,
      index: msg.index,
    });

    // Tell content script to continue
    chrome.tabs.sendMessage(tabId, { action: 'next-scroll' });
  } catch (err) {
    console.error('captureVisibleTab failed:', err);
    chrome.tabs.sendMessage(tabId, { action: 'capture-error', error: err.message });
  }
}

async function handleCaptureComplete(msg, sender) {
  if (!captureState) return;

  const tabId = sender.tab?.id ?? captureState.tabId;
  const { captures, settings } = captureState;
  const pageInfo = msg.pageInfo;

  // Send status update
  chrome.tabs.sendMessage(tabId, { action: 'status-update', status: 'processing' });

  try {
    // Stitch captures into full-page image using offscreen document approach
    // Since service workers can't use Canvas, we send data to viewer page
    const result = {
      captures: captures.map(c => ({
        dataUrl: c.dataUrl,
        scrollY: c.scrollY,
        viewportHeight: c.viewportHeight,
        clipHeight: c.clipHeight,
        index: c.index,
      })),
      pageInfo,
      settings,
      timestamp: Date.now(),
      elapsedMs: Date.now() - captureState.startTime,
    };

    // Store result and open viewer
    await chrome.storage.local.set({ lastCapture: result });
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer/viewer.html') });
  } catch (err) {
    console.error('Processing failed:', err);
    chrome.tabs.sendMessage(tabId, { action: 'capture-error', error: err.message });
  } finally {
    captureState = null;
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function handleGetSettings(sendResponse) {
  const settings = await loadSettings();
  sendResponse({ settings });
}

async function handleSaveSettings(settings, sendResponse) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  await chrome.storage.local.set({ settings: merged });
  sendResponse({ settings: merged });
}

// ── Keyboard shortcut ───────────────────────────────────────────────────────

chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'take-screenshot') {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab) handleStartCapture(tab.id);
    });
  }
});
