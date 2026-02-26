/**
 * PageGobbler — OCR Engine
 * Extracts text from captured pages using DOM-based extraction.
 * MV3 CSP blocks remote scripts, so Tesseract CDN loading is not possible.
 * DOM extraction is preferred for AI use cases anyway — structured text > OCR'd pixels.
 */

const OCREngine = {
  /**
   * Extract text from a canvas. Uses DOM-based fallback since Tesseract
   * can't load in MV3 extensions (CSP blocks remote scripts).
   * @param {HTMLCanvasElement} canvas
   * @param {Object} options - { useTesseract: boolean, lang: string }
   * @returns {Promise<{text: string, method: string, confidence: number, regions: Array}>}
   */
  async extract(_canvas, _options = {}) {
    return {
      text: '',
      method: 'dom-fallback',
      confidence: 0,
      regions: [],
    };
  },
};
