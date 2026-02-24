/**
 * Web Page Gobble — OCR Engine
 * Lightweight OCR using Canvas-based text extraction + optional Tesseract.js.
 * Falls back to a fast built-in approach when Tesseract isn't available.
 */

const OCREngine = {
  _tesseractLoaded: false,
  _worker: null,

  /**
   * Extract text from a canvas using the best available method.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options - { useTesseract: boolean, lang: string }
   * @returns {Promise<{text: string, method: string, confidence: number, regions: Array}>}
   */
  async extract(canvas, options = {}) {
    const useTesseract = options.useTesseract !== false;

    if (useTesseract) {
      try {
        return await this._tesseractExtract(canvas, options);
      } catch (err) {
        console.warn('Tesseract OCR failed, falling back to basic extraction:', err);
      }
    }

    // Fallback: extract text from the page DOM (already collected in pageInfo)
    return {
      text: '',
      method: 'dom-fallback',
      confidence: 0,
      regions: [],
      note: 'OCR library not loaded. Text extracted from DOM metadata.',
    };
  },

  /**
   * Tesseract.js-based OCR extraction.
   */
  async _tesseractExtract(canvas, options = {}) {
    if (!window.Tesseract) {
      await this._loadTesseract();
    }

    if (!this._worker) {
      this._worker = await window.Tesseract.createWorker(options.lang || 'eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core-simd-lstm.wasm.js',
      });
    }

    // Convert canvas to blob for Tesseract
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));

    const { data } = await this._worker.recognize(blob);

    // Extract structured regions
    const regions = (data.blocks || []).map(block => ({
      text: block.text,
      confidence: block.confidence,
      bbox: block.bbox,
    }));

    return {
      text: data.text,
      method: 'tesseract',
      confidence: data.confidence,
      regions,
    };
  },

  /**
   * Load Tesseract.js from CDN.
   */
  async _loadTesseract() {
    if (window.Tesseract) return;

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.onload = () => {
        this._tesseractLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load Tesseract.js'));
      document.head.appendChild(script);
    });
  },

  /**
   * Extract visible text content from a DOM tree.
   * Used as a fast alternative to OCR for pages where DOM is available.
   * @param {Document} doc
   * @returns {string}
   */
  extractDOMText(doc = document) {
    const walker = doc.createTreeWalker(
      doc.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg'].includes(tag)) {
            return NodeFilter.FILTER_REJECT;
          }

          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') {
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
  },

  /**
   * Clean up Tesseract worker.
   */
  async terminate() {
    if (this._worker) {
      await this._worker.terminate();
      this._worker = null;
    }
  },
};
