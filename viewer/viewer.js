/**
 * Web Page Gobble — Viewer Page Controller
 * Processes the captured data: stitch → compress → section → OCR → display.
 */

(async () => {
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const progressFill = document.getElementById('progress-fill');
  const sectionsGrid = document.getElementById('sections-grid');
  const metaGrid = document.getElementById('meta-grid');
  const ocrText = document.getElementById('ocr-text');
  const jsonOutput = document.getElementById('json-output');
  const btnDownloadAll = document.getElementById('btn-download-all');
  const btnCopyText = document.getElementById('btn-copy-text');
  const btnCopyMeta = document.getElementById('btn-copy-metadata');

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // State
  let processedSections = [];
  let fullMetadata = {};
  let extractedText = '';

  // ── Load captured data ──────────────────────────────────────────────────

  setStatus('Loading capture data...', 5);

  const stored = await chrome.storage.local.get('lastCapture');
  const captureData = stored.lastCapture;

  if (!captureData) {
    setStatus('No capture data found. Please capture a page first.', 0, true);
    return;
  }

  const { captures, pageInfo, settings } = captureData;

  // ── Step 1: Stitch ────────────────────────────────────────────────────

  setStatus(`Stitching ${captures.length} viewport captures...`, 15);

  let fullCanvas;
  try {
    fullCanvas = await ImageProcessor.stitch(captures, pageInfo);
  } catch (err) {
    console.error('Stitch failed:', err);
    setStatus(`Stitch error: ${err.message}`, 15, true);
    return;
  }

  setStatus(`Stitched: ${fullCanvas.width} × ${fullCanvas.height}px`, 30);

  // ── Step 2: Smart Section ─────────────────────────────────────────────

  let sections;
  if (settings.enableSections) {
    setStatus('Finding smart section break points...', 40);
    sections = ImageProcessor.smartSection(fullCanvas, {
      sectionMaxHeight: settings.sectionMaxHeight,
      devicePixelRatio: pageInfo.devicePixelRatio,
    });
    setStatus(`Split into ${sections.length} section(s)`, 50);
  } else {
    sections = [{ canvas: fullCanvas, startY: 0, endY: fullCanvas.height, index: 0 }];
  }

  // ── Step 3: Compress each section ─────────────────────────────────────

  processedSections = [];
  for (let i = 0; i < sections.length; i++) {
    const pct = 50 + Math.round((i / sections.length) * 25);
    setStatus(`Compressing section ${i + 1} of ${sections.length}...`, pct);

    const result = await ImageProcessor.compress(sections[i].canvas, {
      maxFileSizeMB: settings.maxFileSizeMB,
      compressionStrategy: settings.compressionStrategy,
      quality: settings.quality,
    });

    const url = URL.createObjectURL(result.blob);
    processedSections.push({
      ...sections[i],
      blob: result.blob,
      url,
      format: result.format,
      quality: result.quality,
      scaled: result.scaled,
      scaleFactor: result.scaleFactor,
      sizeMB: (result.blob.size / (1024 * 1024)).toFixed(2),
    });
  }

  // ── Step 4: OCR ───────────────────────────────────────────────────────

  if (settings.enableOCR) {
    setStatus('Running OCR text extraction...', 80);
    try {
      const ocrResult = await OCREngine.extract(fullCanvas, {
        useTesseract: true,
        lang: pageInfo.documentLang === 'unknown' ? 'eng' : pageInfo.documentLang,
      });

      if (ocrResult.text) {
        extractedText = ocrResult.text;
      } else {
        // Fall back to DOM-collected text
        extractedText = buildDOMText(pageInfo);
      }

      // Append confidence info
      if (ocrResult.confidence > 0) {
        extractedText += `\n\n--- OCR Confidence: ${ocrResult.confidence.toFixed(1)}% (${ocrResult.method}) ---`;
      }
    } catch (err) {
      console.warn('OCR failed:', err);
      extractedText = buildDOMText(pageInfo);
      extractedText += '\n\n--- OCR engine failed, text extracted from DOM ---';
    }
  } else {
    extractedText = buildDOMText(pageInfo);
    extractedText += '\n\n--- OCR disabled, text extracted from DOM metadata ---';
  }

  ocrText.textContent = extractedText || '(No text extracted)';

  // ── Step 5: Build metadata ────────────────────────────────────────────

  setStatus('Building metadata...', 90);

  fullMetadata = {
    source: {
      url: pageInfo.url,
      title: pageInfo.title,
      capturedAt: pageInfo.capturedAt,
      language: pageInfo.documentLang,
    },
    dimensions: {
      pageWidth: pageInfo.viewportWidth,
      pageHeight: pageInfo.pageHeight,
      devicePixelRatio: pageInfo.devicePixelRatio,
      capturedWidth: fullCanvas.width,
      capturedHeight: fullCanvas.height,
    },
    sections: processedSections.map((s, i) => ({
      index: i,
      format: s.format,
      quality: s.quality,
      sizeMB: s.sizeMB,
      scaled: s.scaled,
      scaleFactor: s.scaleFactor || 1,
      startY: s.startY,
      endY: s.endY,
      heightPx: s.endY - s.startY,
    })),
    pageStructure: {
      headings: pageInfo.headings,
      linkCount: pageInfo.linkCount,
      topLinks: pageInfo.topLinks?.slice(0, 20),
    },
    meta: pageInfo.metaTags,
    processing: {
      elapsedMs: captureData.elapsedMs,
      totalCaptures: captures.length,
      compressionStrategy: settings.compressionStrategy,
      ocrEnabled: settings.enableOCR,
    },
  };

  renderMetadata(pageInfo);
  jsonOutput.textContent = JSON.stringify(fullMetadata, null, 2);

  // ── Step 6: Render sections ───────────────────────────────────────────

  renderSections(processedSections);

  // ── Done ──────────────────────────────────────────────────────────────

  setStatus(`Done — ${processedSections.length} section(s), total ${totalSizeMB(processedSections)} MB`, 100);
  statusBar.classList.add('done');

  // Enable action buttons
  btnDownloadAll.disabled = false;
  btnCopyText.disabled = false;
  btnCopyMeta.disabled = false;

  // Clean up capture data from storage (it can be large)
  chrome.storage.local.remove('lastCapture');

  // ── Event Handlers ────────────────────────────────────────────────────

  btnDownloadAll.addEventListener('click', () => downloadAll());
  btnCopyText.addEventListener('click', () => copyToClipboard(extractedText, btnCopyText));
  btnCopyMeta.addEventListener('click', () => copyToClipboard(JSON.stringify(fullMetadata, null, 2), btnCopyMeta));

  // ── Render Functions ──────────────────────────────────────────────────

  function renderSections(sections) {
    sectionsGrid.innerHTML = '';

    sections.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'section-card';

      const formatLabel = s.format.split('/')[1].toUpperCase();
      const dims = `${s.canvas.width} × ${s.canvas.height}`;

      card.innerHTML = `
        <div class="section-card-header">
          <div>
            <span class="badge">Section ${i + 1}</span>
            <span class="size">${dims} · ${s.sizeMB} MB · ${formatLabel} @ ${Math.round(s.quality * 100)}%${s.scaled ? ` · scaled ${Math.round((s.scaleFactor || 1) * 100)}%` : ''}</span>
          </div>
          <div class="section-card-actions">
            <button data-action="download" data-index="${i}">Download</button>
            <button data-action="open" data-index="${i}">Open</button>
          </div>
        </div>
      `;

      const img = document.createElement('img');
      img.src = s.url;
      img.alt = `Section ${i + 1}`;
      img.loading = 'lazy';
      card.appendChild(img);

      card.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(e.target.dataset.index);
          if (e.target.dataset.action === 'download') {
            downloadSection(idx);
          } else {
            window.open(sections[idx].url, '_blank');
          }
        });
      });

      sectionsGrid.appendChild(card);
    });
  }

  function renderMetadata(info) {
    const items = [
      { label: 'URL', value: `<a href="${escapeHtml(info.url)}" target="_blank">${escapeHtml(info.url)}</a>` },
      { label: 'Title', value: escapeHtml(info.title) },
      { label: 'Captured', value: info.capturedAt },
      { label: 'Page Size', value: `${info.viewportWidth} × ${info.pageHeight} px` },
      { label: 'Device Pixel Ratio', value: `${info.devicePixelRatio}x` },
      { label: 'Language', value: info.documentLang },
    ];

    // Add headings
    if (info.headings?.length > 0) {
      const headingsHtml = info.headings.map(h =>
        `<li class="h${h.level}">${'—'.repeat(h.level - 1)} ${escapeHtml(h.text)}</li>`
      ).join('');
      items.push({ label: 'Page Structure', value: `<ul class="headings-list">${headingsHtml}</ul>` });
    }

    // Add meta tags
    if (info.metaTags) {
      const metaEntries = Object.entries(info.metaTags).slice(0, 10);
      if (metaEntries.length > 0) {
        const metaHtml = metaEntries.map(([k, v]) =>
          `<strong>${escapeHtml(k)}</strong>: ${escapeHtml(v)}`
        ).join('<br>');
        items.push({ label: 'Meta Tags', value: metaHtml });
      }
    }

    metaGrid.innerHTML = items.map(item => `
      <div class="meta-item">
        <div class="meta-label">${item.label}</div>
        <div class="meta-value">${item.value}</div>
      </div>
    `).join('');
  }

  // ── Utility Functions ─────────────────────────────────────────────────

  function setStatus(text, pct, isError = false) {
    statusText.textContent = text;
    progressFill.style.width = `${pct}%`;
    if (isError) {
      statusBar.classList.add('error');
    }
  }

  function totalSizeMB(sections) {
    return sections.reduce((sum, s) => sum + parseFloat(s.sizeMB), 0).toFixed(2);
  }

  function downloadSection(index) {
    const section = processedSections[index];
    const ext = section.format.split('/')[1];
    const name = `gobble_${sanitizeFilename(fullMetadata.source.title)}_section${index + 1}.${ext}`;
    triggerDownload(section.url, name);
  }

  function downloadAll() {
    processedSections.forEach((_, i) => {
      setTimeout(() => downloadSection(i), i * 300);
    });

    // Also download metadata JSON
    const metaBlob = new Blob([JSON.stringify(fullMetadata, null, 2)], { type: 'application/json' });
    const metaUrl = URL.createObjectURL(metaBlob);
    const metaName = `gobble_${sanitizeFilename(fullMetadata.source.title)}_metadata.json`;
    setTimeout(() => triggerDownload(metaUrl, metaName), processedSections.length * 300);

    // And OCR text
    if (extractedText) {
      const textBlob = new Blob([extractedText], { type: 'text/plain' });
      const textUrl = URL.createObjectURL(textBlob);
      const textName = `gobble_${sanitizeFilename(fullMetadata.source.title)}_ocr.txt`;
      setTimeout(() => triggerDownload(textUrl, textName), (processedSections.length + 1) * 300);
    }
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  function sanitizeFilename(str) {
    return (str || 'page').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function buildDOMText(info) {
    const parts = [];
    if (info.title) parts.push(`# ${info.title}\n`);
    if (info.url) parts.push(`URL: ${info.url}\n`);

    if (info.headings?.length) {
      parts.push('\n## Page Structure\n');
      info.headings.forEach(h => {
        parts.push(`${'#'.repeat(h.level)} ${h.text}`);
      });
    }

    if (info.metaTags?.description) {
      parts.push(`\n## Description\n${info.metaTags.description}`);
    }

    if (info.topLinks?.length) {
      parts.push('\n## Key Links\n');
      info.topLinks.slice(0, 20).forEach(l => {
        parts.push(`- [${l.text}](${l.href})`);
      });
    }

    return parts.join('\n');
  }
})();
