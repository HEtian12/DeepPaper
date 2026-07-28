(() => {
  const PDFJS_ROOT = "./node_modules/pdfjs-dist";
  const PDF_CORPUS_TYPES = ["摘录", "高亮", "批注"];
  let pdfModulesPromise = null;
  let activePdfReader = null;
  let pdfReaderGeneration = 0;

  state.pendingPdfPage = null;
  state.pendingPdfHighlightId = null;

  function resourceUrl(relativePath) {
    return new URL(`${PDFJS_ROOT}/${relativePath}`, window.location.href).href;
  }

  function loadPdfModules() {
    if (!pdfModulesPromise) {
      pdfModulesPromise = import(`${PDFJS_ROOT}/legacy/build/pdf.mjs`).then(async (pdfjsLib) => {
        globalThis.pdfjsLib = pdfjsLib;
        const viewerLib = await import(`${PDFJS_ROOT}/legacy/web/pdf_viewer.mjs`);
        pdfjsLib.GlobalWorkerOptions.workerSrc = resourceUrl("legacy/build/pdf.worker.mjs");
        return { pdfjsLib, viewerLib };
      });
    }
    return pdfModulesPromise;
  }

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data?.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
    if (data?.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.buffer.byteLength);
    }
    throw new Error("无法识别 PDF 文件数据。 ");
  }

  function destroyPdfReader() {
    pdfReaderGeneration += 1;
    if (!activePdfReader) return;
    try {
      activePdfReader.loadingTask?.destroy();
      activePdfReader.pdfDocument?.destroy();
    } catch {
      // The reader is already being replaced.
    }
    activePdfReader = null;
  }

  function renderPdfReaderShell(paper) {
    if (paper.kind === "image") {
      return paper.imageDataUrl
        ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "图片")}" /></section>`
        : `<section class="source-preview empty compact">这张图片没有可预览的数据。</section>`;
    }

    return `
      <section class="pdf-workspace" id="deepPaperPdfReader" data-paper-id="${escapeHtml(paper.id)}">
        <header class="pdf-reader-toolbar">
          <button id="pdfPrevPageBtn" class="pdf-icon-button" type="button" title="上一页">‹</button>
          <label class="pdf-page-control" title="跳转页码">
            <input id="pdfPageInput" type="number" min="1" value="1" />
            <span id="pdfPageCount">/ --</span>
          </label>
          <button id="pdfNextPageBtn" class="pdf-icon-button" type="button" title="下一页">›</button>
          <span class="pdf-toolbar-divider"></span>
          <button id="pdfZoomOutBtn" class="pdf-icon-button" type="button" title="缩小">−</button>
          <span id="pdfZoomLabel" class="pdf-zoom-label">--</span>
          <button id="pdfZoomInBtn" class="pdf-icon-button" type="button" title="放大">+</button>
          <button id="pdfFitWidthBtn" class="pdf-tool-button" type="button" title="适合页面宽度">适宽</button>
          <div class="pdf-search-control">
            <input id="pdfSearchInput" type="search" placeholder="在 PDF 中搜索" />
            <button id="pdfSearchPrevBtn" class="pdf-icon-button" type="button" title="上一个结果">↑</button>
            <button id="pdfSearchNextBtn" class="pdf-icon-button" type="button" title="下一个结果">↓</button>
          </div>
        </header>
        <div class="pdf-reader-stage" id="pdfReaderStage">
          <div id="pdfViewerContainer" class="pdf-viewer-container" tabindex="0">
            <div id="pdfViewer" class="pdfViewer"></div>
          </div>
        </div>
        <footer id="pdfReaderStatus" class="pdf-reader-status">正在打开 PDF...</footer>
      </section>
    `;
  }

  function renderDetailWithPdfReader(paper) {
    const tab = state.detailTab === "source" ? "source" : "analysis";
    const existingReader = document.querySelector("#deepPaperPdfReader");
    if (paper && tab === "source" && activePdfReader?.paperId === paper.id && existingReader) {
      if (state.pendingPdfPage) navigatePdfPage(state.pendingPdfPage);
      return;
    }

    destroyPdfReader();
    if (!paper) {
      els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
      return;
    }

    const header = tab === "analysis" ? `
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
    ` : "";

    els.detailPanel.innerHTML = `
      <div class="detail-inner ${tab === "source" ? "source-only pdf-source-detail" : ""}">
        ${header}
        <div class="detail-tabs">
          <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
          <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
        </div>
        ${tab === "source" ? renderPdfReaderShell(paper) : renderAnalysisDetail(paper)}
      </div>
    `;

    document.querySelectorAll("[data-detail-tab]").forEach((button) => {
      button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
    });
    if (tab === "analysis") bindAnalysisDetail(paper);
    if (tab === "source" && paper.kind !== "image") mountPdfReader(paper);
  }

  async function mountPdfReader(paper) {
    const generation = ++pdfReaderGeneration;
    const root = document.querySelector("#deepPaperPdfReader");
    const container = document.querySelector("#pdfViewerContainer");
    const viewerElement = document.querySelector("#pdfViewer");
    if (!root || !container || !viewerElement) return;

    bindPdfReaderControls(paper);
    hideSelectionButton();

    try {
      const [{ pdfjsLib, viewerLib }, fileResult] = await Promise.all([
        loadPdfModules(),
        window.deepPaper.readPdfBytes(paper.filePath)
      ]);
      if (generation !== pdfReaderGeneration || state.selectedId !== paper.id || state.detailTab !== "source") return;
      if (!fileResult?.ok) throw new Error(fileResult?.error || "读取 PDF 失败。");

      const eventBus = new viewerLib.EventBus();
      const linkService = new viewerLib.PDFLinkService({ eventBus });
      const findController = new viewerLib.PDFFindController({ eventBus, linkService });
      const pdfViewer = new viewerLib.PDFViewer({
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        findController,
        textLayerMode: 1,
        removePageBorders: false
      });
      linkService.setViewer(pdfViewer);

      const bytes = toUint8Array(fileResult.data);
      const loadingTask = pdfjsLib.getDocument({
        data: bytes,
        cMapUrl: resourceUrl("cmaps/"),
        cMapPacked: true,
        standardFontDataUrl: resourceUrl("standard_fonts/"),
        wasmUrl: resourceUrl("wasm/")
      });
      activePdfReader = {
        paperId: paper.id,
        paper,
        eventBus,
        linkService,
        findController,
        pdfViewer,
        loadingTask,
        pdfDocument: null
      };
      bindPdfViewerEvents(activePdfReader);

      const pdfDocument = await loadingTask.promise;
      if (generation !== pdfReaderGeneration || activePdfReader?.paperId !== paper.id) {
        pdfDocument.destroy();
        return;
      }
      activePdfReader.pdfDocument = pdfDocument;
      pdfViewer.setDocument(pdfDocument);
      linkService.setDocument(pdfDocument, null);
      document.querySelector("#pdfPageCount").textContent = `/ ${pdfDocument.numPages}`;
      document.querySelector("#pdfReaderStatus").textContent = `${pdfDocument.numPages} 页 · 支持选择和复制正文文字`;
    } catch (error) {
      if (generation !== pdfReaderGeneration) return;
      const status = document.querySelector("#pdfReaderStatus");
      if (status) status.textContent = `PDF 打开失败：${error.message}`;
      const viewer = document.querySelector("#pdfViewer");
      if (viewer) viewer.innerHTML = `<div class="pdf-reader-error">${escapeHtml(error.message)}</div>`;
    }
  }

  function bindPdfViewerEvents(reader) {
    reader.eventBus.on("pagesinit", () => {
      reader.pdfViewer.currentScaleValue = "page-width";
      const targetPage = state.pendingPdfPage || 1;
      state.pendingPdfPage = null;
      reader.pdfViewer.currentPageNumber = Math.max(1, Math.min(targetPage, reader.pdfDocument?.numPages || targetPage));
      updatePdfToolbar(reader);
    });
    reader.eventBus.on("pagechanging", ({ pageNumber }) => {
      const input = document.querySelector("#pdfPageInput");
      if (input) input.value = pageNumber;
    });
    reader.eventBus.on("scalechanging", () => updatePdfToolbar(reader));
    reader.eventBus.on("textlayerrendered", ({ pageNumber }) => renderPdfAnchorsForPage(reader.paper, pageNumber));
  }

  function bindPdfReaderControls(paper) {
    document.querySelector("#pdfPrevPageBtn")?.addEventListener("click", () => changePdfPage(-1));
    document.querySelector("#pdfNextPageBtn")?.addEventListener("click", () => changePdfPage(1));
    document.querySelector("#pdfPageInput")?.addEventListener("change", (event) => navigatePdfPage(Number(event.target.value)));
    document.querySelector("#pdfPageInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") navigatePdfPage(Number(event.target.value));
    });
    document.querySelector("#pdfZoomOutBtn")?.addEventListener("click", () => changePdfZoom(0.9));
    document.querySelector("#pdfZoomInBtn")?.addEventListener("click", () => changePdfZoom(1.1));
    document.querySelector("#pdfFitWidthBtn")?.addEventListener("click", () => {
      if (activePdfReader) activePdfReader.pdfViewer.currentScaleValue = "page-width";
    });
    document.querySelector("#pdfSearchInput")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") findInPdf(event.shiftKey);
    });
    document.querySelector("#pdfSearchPrevBtn")?.addEventListener("click", () => findInPdf(true));
    document.querySelector("#pdfSearchNextBtn")?.addEventListener("click", () => findInPdf(false));
  }

  function updatePdfToolbar(reader) {
    const label = document.querySelector("#pdfZoomLabel");
    if (label) label.textContent = `${Math.round((reader.pdfViewer.currentScale || 1) * 100)}%`;
  }

  function changePdfPage(delta) {
    if (!activePdfReader) return;
    navigatePdfPage(activePdfReader.pdfViewer.currentPageNumber + delta);
  }

  function navigatePdfPage(pageNumber) {
    if (!activePdfReader?.pdfDocument) {
      state.pendingPdfPage = Number(pageNumber) || 1;
      return;
    }
    const page = Math.max(1, Math.min(Number(pageNumber) || 1, activePdfReader.pdfDocument.numPages));
    activePdfReader.pdfViewer.currentPageNumber = page;
    const pageElement = document.querySelector(`.pdfViewer .page[data-page-number="${page}"]`);
    pageElement?.scrollIntoView({ block: "start" });
  }

  function changePdfZoom(multiplier) {
    if (!activePdfReader) return;
    const current = activePdfReader.pdfViewer.currentScale || 1;
    activePdfReader.pdfViewer.currentScaleValue = String(Math.max(0.35, Math.min(4, current * multiplier)));
  }

  function findInPdf(findPrevious) {
    if (!activePdfReader) return;
    const query = document.querySelector("#pdfSearchInput")?.value.trim() || "";
    if (!query) return;
    activePdfReader.eventBus.dispatch("find", {
      source: window,
      type: "again",
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false
    });
  }

  function capturePdfSelection(paper) {
    const selection = window.getSelection();
    const viewer = document.querySelector("#pdfViewer");
    const text = String(selection?.toString() || "").replace(/\s+/g, " ").trim();
    if (!selection?.rangeCount || !text || !viewer?.contains(selection.anchorNode) || !viewer.contains(selection.focusNode)) {
      hidePdfSelectionToolbar();
      return;
    }
    const anchorLayer = selection.anchorNode.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
    const focusLayer = selection.focusNode.nodeType === Node.TEXT_NODE ? selection.focusNode.parentElement : selection.focusNode;
    if (!anchorLayer?.closest?.(".textLayer") || !focusLayer?.closest?.(".textLayer")) {
      hidePdfSelectionToolbar();
      return;
    }

    const range = selection.getRangeAt(0);
    const clientRects = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 1);
    const pages = captureSelectionPages(clientRects);
    if (!pages.length) {
      hidePdfSelectionToolbar();
      return;
    }
    state.pendingPdfSelection = { paperId: paper.id, text, pages };
    showPdfSelectionToolbar(clientRects[clientRects.length - 1], text);
  }

  function captureSelectionPages(clientRects) {
    const pages = [];
    document.querySelectorAll("#pdfViewer .page[data-page-number]").forEach((pageElement) => {
      const pageRect = pageElement.getBoundingClientRect();
      const rects = clientRects.map((rect) => intersectRectWithPage(rect, pageRect)).filter(Boolean);
      if (!rects.length) return;
      pages.push({
        pageNumber: Number(pageElement.dataset.pageNumber),
        rects: rects.map((rect) => ({
          x: roundPercent((rect.left - pageRect.left) / pageRect.width),
          y: roundPercent((rect.top - pageRect.top) / pageRect.height),
          width: roundPercent(rect.width / pageRect.width),
          height: roundPercent(rect.height / pageRect.height)
        }))
      });
    });
    return pages;
  }

  function intersectRectWithPage(rect, pageRect) {
    const left = Math.max(rect.left, pageRect.left);
    const top = Math.max(rect.top, pageRect.top);
    const right = Math.min(rect.right, pageRect.right);
    const bottom = Math.min(rect.bottom, pageRect.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  function roundPercent(value) {
    return Math.round(Math.max(0, Math.min(1, value)) * 100000) / 1000;
  }

  function showPdfSelectionToolbar(lastRect, text) {
    const toolbar = document.querySelector("#pdfSelectionToolbar");
    const summary = document.querySelector("#pdfSelectionSummary");
    if (!toolbar || !lastRect) return;
    if (summary) summary.textContent = `已选 ${text.length} 字`;
    toolbar.classList.remove("hidden");
    const estimatedWidth = 330;
    const left = Math.max(10, Math.min(window.innerWidth - estimatedWidth - 10, lastRect.left));
    const top = Math.max(10, lastRect.top - 46);
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
  }

  function hidePdfSelectionToolbar() {
    state.pendingPdfSelection = null;
    document.querySelector("#pdfSelectionToolbar")?.classList.add("hidden");
  }

  function savePdfSelection(paper, action) {
    const pending = state.pendingPdfSelection;
    if (!pending?.text || pending.paperId !== paper.id) {
      setStatus("请先在 PDF 正文中选中一句话。", true);
      return;
    }
    let note = "";
    if (action === "note") {
      const value = prompt("给这段文字写批注：", "");
      if (value === null) return;
      note = value.trim();
    }
    const typeMap = { corpus: "摘录", highlight: "高亮", note: "批注" };
    const pageNumbers = pending.pages.map((page) => page.pageNumber);
    const item = {
      id: crypto.randomUUID(),
      paperId: paper.id,
      paperTitleZh: paper.titleZh || paper.analysis?.title_zh || paper.title || "",
      paperTitleEn: paper.titleEn || paper.analysis?.title_en || "",
      paperVenue: paper.venue || "",
      paperYear: paper.year || "",
      sourceLabel: pageNumbers.length === 1 ? `PDF 第 ${pageNumbers[0]} 页` : `PDF 第 ${pageNumbers[0]}-${pageNumbers.at(-1)} 页`,
      type: typeMap[action] || "摘录",
      text: pending.text,
      tags: [...paperKeywords(paper)],
      note,
      pdfAnchor: { version: 1, pages: pending.pages },
      createdAt: new Date().toISOString()
    };
    corpus.unshift(item);
    saveCorpus();
    state.pendingPdfSelection = null;
    state.pendingPdfHighlightId = item.id;
    window.getSelection()?.removeAllRanges();
    hidePdfSelectionToolbar();
    renderAllPdfAnchors(paper);
    els.openCorpusBtn.textContent = `语料库 (${corpus.length})`;
    renderCorpus();
    const actionLabel = action === "highlight" ? "高亮" : action === "note" ? "批注" : "语料";
    setStatus(`已保存${actionLabel}：PDF 第 ${pageNumbers[0]} 页。`);
  }

  function renderAllPdfAnchors(paper) {
    document.querySelectorAll("#pdfViewer .page[data-page-number]").forEach((page) => {
      renderPdfAnchorsForPage(paper, Number(page.dataset.pageNumber));
    });
  }

  function renderPdfAnchorsForPage(paper, pageNumber) {
    const page = document.querySelector(`#pdfViewer .page[data-page-number="${pageNumber}"]`);
    if (!page) return;
    let layer = page.querySelector(":scope > .deeppaper-pdf-anchor-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "deeppaper-pdf-anchor-layer";
      page.appendChild(layer);
    }
    layer.innerHTML = "";
    corpus.filter((item) => item.paperId === paper.id && item.pdfAnchor?.pages?.length).forEach((item) => {
      const pageAnchor = item.pdfAnchor.pages.find((entry) => Number(entry.pageNumber) === pageNumber);
      if (!pageAnchor) return;
      pageAnchor.rects.forEach((rect, index) => {
        const mark = document.createElement("div");
        mark.className = `deeppaper-pdf-anchor ${pdfAnchorClass(item.type)}${item.id === state.pendingPdfHighlightId ? " is-target" : ""}`;
        mark.style.left = `${rect.x}%`;
        mark.style.top = `${rect.y}%`;
        mark.style.width = `${rect.width}%`;
        mark.style.height = `${rect.height}%`;
        mark.title = item.note || item.text;
        if (index === 0 && item.type === "批注") {
          const badge = document.createElement("span");
          badge.textContent = "批";
          mark.appendChild(badge);
        }
        layer.appendChild(mark);
      });
    });
  }

  function pdfAnchorClass(type) {
    if (type === "高亮") return " is-highlight";
    if (type === "批注") return " is-note";
    return " is-corpus";
  }

  function ensurePdfCorpusOptions() {
    PDF_CORPUS_TYPES.forEach((type) => {
      if (![...els.corpusTypeFilter.options].some((option) => option.value === type)) {
        els.corpusTypeFilter.insertAdjacentHTML("beforeend", `<option value="${type}">${type}</option>`);
      }
    });
  }

  function corpusTypeOptionsWithPdf(selected) {
    return ["摘录", "高亮", "批注", "动机", "Gap", "方法", "贡献", "结果", "写作用句", "其他"]
      .map((type) => `<option value="${type}" ${selected === type ? "selected" : ""}>${type}</option>`)
      .join("");
  }

  function corpusCardWithPdfAnchor(item) {
    const title = item.paperTitleZh || item.paperTitleEn || "未知论文";
    const firstPage = item.pdfAnchor?.pages?.[0]?.pageNumber;
    const jumpLabel = firstPage ? `定位原文 · 第 ${firstPage} 页` : "查看论文";
    return `
      <article class="corpus-card" data-corpus-id="${item.id}">
        <div class="corpus-card-head">
          <select class="corpus-type" data-corpus-type="${item.id}">
            ${corpusTypeOptionsWithPdf(item.type)}
          </select>
          <div class="corpus-card-actions">
            <button class="secondary small-btn" data-corpus-jump="${item.id}">${jumpLabel}</button>
            <button class="secondary danger small-btn" data-corpus-delete="${item.id}">删除</button>
          </div>
        </div>
        <textarea class="corpus-text" data-corpus-text="${item.id}">${escapeHtml(item.text)}</textarea>
        <div class="corpus-source">${escapeHtml(title)}${item.sourceLabel ? ` · ${escapeHtml(item.sourceLabel)}` : ""}</div>
        <input class="corpus-tags-input" data-corpus-tags="${item.id}" value="${escapeHtml((item.tags || []).join("，"))}" placeholder="标签，用逗号分隔" />
        <input class="corpus-note-input" data-corpus-note="${item.id}" value="${escapeHtml(item.note || "")}" placeholder="批注或备注，可选" />
      </article>
    `;
  }

  async function jumpToPdfCorpusSource(id) {
    const item = corpus.find((entry) => entry.id === id);
    if (!item) return;
    const paper = papers.find((entry) => entry.id === item.paperId);
    if (!paper) {
      setStatus("来源论文不在当前文献库中。", true);
      return;
    }
    state.selectedId = paper.id;
    state.pendingPdfPage = item.pdfAnchor?.pages?.[0]?.pageNumber || 1;
    state.pendingPdfHighlightId = item.id;
    state.corpusOpen = false;
    renderCorpus();
    if (paper.kind === "pdf" && item.pdfAnchor) {
      await showPaperSource(paper.id);
      setStatus(`已定位到 PDF 第 ${state.pendingPdfPage || item.pdfAnchor.pages[0].pageNumber} 页。`);
      return;
    }
    state.detailTab = "analysis";
    render();
    setStatus("已跳转到来源论文。 ");
  }

  const originalUpdateCorpusItem = updateCorpusItem;
  const originalDeleteCorpusItem = deleteCorpusItem;
  updateCorpusItem = function updateCorpusItemWithPdf(id, patch) {
    originalUpdateCorpusItem(id, patch);
    if (activePdfReader) renderAllPdfAnchors(activePdfReader.paper);
  };
  deleteCorpusItem = function deleteCorpusItemWithPdf(id) {
    originalDeleteCorpusItem(id);
    if (activePdfReader) renderAllPdfAnchors(activePdfReader.paper);
  };

  renderSourcePreview = renderPdfReaderShell;
  renderDetail = renderDetailWithPdfReader;
  corpusTypeOptions = corpusTypeOptionsWithPdf;
  corpusCard = corpusCardWithPdfAnchor;
  jumpToCorpusSource = jumpToPdfCorpusSource;

  ensurePdfCorpusOptions();
  window.addEventListener("beforeunload", destroyPdfReader);
  render();
})();
