const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const electronPath = require("electron");
const projectRoot = path.join(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deeppaper-pdf-reader-"));
const userDataDir = path.join(testRoot, "profile");
const pdfPath = path.join(testRoot, "reader-smoke.pdf");
const port = 9300 + Math.floor(Math.random() * 500);
const embeddingPort = port + 600;
const targetText = "This sentence should enter the corpus.";
const screenshotDir = path.resolve(process.env.DEEPPAPER_SMOKE_SCREENSHOT_DIR || path.join(os.tmpdir(), "deeppaper-ui-qa"));
let electronProcess;
let socket;
let embeddingServer;
let embeddingRequestCount = 0;
let embeddingBatchRejectionCount = 0;
let embeddingSingleFailureCount = 0;
let multimodalEmbeddingRequestCount = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMinimalPdf(filePath) {
  const content = `BT /F1 18 Tf 72 700 Td (${targetText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  fs.writeFileSync(filePath, pdf, "binary");
}

async function findPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await wait(250);
  }
  throw new Error("Timed out waiting for the DeepPaper renderer.");
}

function createCdpClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    ws,
    ready,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after 45 seconds`));
        }, 45000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value;
}

async function waitForReader(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await evaluate(client, `(() => ({
      ready: Boolean(document.querySelector("#pdfViewer .page .textLayer span")),
      error: document.querySelector(".pdf-reader-error")?.textContent || "",
      readerStatus: document.querySelector("#pdfReaderStatus")?.textContent || ""
    }))()`);
    if (status.error) throw new Error(status.error);
    if (status.ready) return;
    await wait(200);
  }
  throw new Error("PDF.js reader did not render a selectable text layer.");
}

async function waitForApp(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(client, `typeof state !== "undefined" && typeof papers !== "undefined" && typeof render === "function"`);
    if (ready) return;
    await wait(100);
  }
  throw new Error("Timed out waiting for the DeepPaper app scripts.");
}

async function main() {
  createMinimalPdf(pdfPath);
  embeddingServer = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      embeddingRequestCount += 1;
      const payload = JSON.parse(body || "{}");
      if (request.url?.endsWith("/embeddings/multimodal")) {
        multimodalEmbeddingRequestCount += 1;
        const textPart = Array.isArray(payload.input) && payload.input.length === 1 ? payload.input[0] : null;
        if (textPart?.type !== "text" || !textPart.text) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "multimodal endpoint requires typed text input" } }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          model: payload.model,
          data: { embedding: String(textPart.text).includes("sentence") ? [1, 0, 0] : [0, 1, 0] }
        }));
        return;
      }
      const inputIsArray = Array.isArray(payload.input);
      const inputs = inputIsArray ? payload.input : [payload.input];
      if (inputIsArray) {
        embeddingBatchRejectionCount += 1;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "embedding endpoint requires scalar input" } }));
        return;
      }
      if (inputs.length === 1 && embeddingSingleFailureCount === 0) {
        embeddingSingleFailureCount += 1;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "temporary embedding failure" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        model: payload.model,
        data: inputs.map((text, index) => ({
          index,
          embedding: String(text).includes("sentence") ? [1, 0, 0] : [0, 1, 0]
        }))
      }));
    });
  });
  await new Promise((resolve) => embeddingServer.listen(embeddingPort, "127.0.0.1", resolve));
  electronProcess = spawn(electronPath, [
    projectRoot,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`
  ], {
    cwd: projectRoot,
    stdio: "ignore",
    windowsHide: true
  });

  const page = await findPage();
  const client = createCdpClient(page.webSocketDebuggerUrl);
  socket = client.ws;
  await client.ready;
  await client.send("Runtime.enable");
  await waitForApp(client);

  const setup = await evaluate(client, `(async () => {
    const extractedPages = await window.deepPaper.extractPdfPages(${JSON.stringify(pdfPath)});
    const paper = {
      id: "pdf-reader-smoke-paper",
      kind: "pdf",
      filePath: ${JSON.stringify(pdfPath)},
      fileName: "reader-smoke.pdf",
      text: extractedPages.text || ${JSON.stringify(targetText)},
      title: "PDF Reader Smoke Paper",
      titleEn: "PDF Reader Smoke Paper",
      titleZh: "PDF 阅读器测试论文",
      year: "2026",
      venue: "Smoke Test",
      pageCount: extractedPages.pageCount || 1,
      pageTextOffsets: extractedPages.pageTextOffsets || [],
      status: "已解析",
      keywords: ["待删除关键词", "全局删除关键词", "阅读器测试", "论文阅读", "文本提取", "本地文献", "PDF解析", "页面定位", "语料管理", "文献检索", "关键词编辑", "数据保存"],
      analysis: {
        keywords: ["待删除关键词", "全局删除关键词", "阅读器测试", "论文阅读", "文本提取", "本地文献", "PDF解析", "页面定位", "语料管理", "文献检索", "关键词编辑", "数据保存"],
        method: { modules: ["待删除关键词"] }
      }
    };
    papers = [paper];
    corpus = [{
      id: "existing-pdf-anchor",
      paperId: paper.id,
      paperTitleEn: paper.titleEn,
      type: "excerpt",
      text: ${JSON.stringify(targetText)},
      pdfAnchor: {
        version: 1,
        pages: [{ pageNumber: 1, rects: [{ x: 10, y: 10, width: 25, height: 3 }] }]
      },
      createdAt: new Date().toISOString()
    }];
    state.selectedId = paper.id;
    state.detailTab = "analysis";
    saveLibrary();
    saveCorpus();
    render();
    document.querySelector("#addKeywordBtn")?.click();
    const keywordInput = document.querySelector("#keywordAddInput");
    keywordInput.value = "新增关键词";
    keywordInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const keywordAdded = paperKeywords(papers[0]).includes("新增关键词")
      && [...document.querySelectorAll(".keyword-token")].some((item) => item.textContent === "新增关键词");
    const deleteButton = [...document.querySelectorAll(".keyword-token")].find((item) => item.textContent === "待删除关键词");
    deleteButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const keywordDeleted = !paperKeywords(papers[0]).includes("待删除关键词")
      && ![...document.querySelectorAll(".keyword-token")].some((item) => item.textContent === "待删除关键词");
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    const sidebarDeleteButton = [...document.querySelectorAll(".keyword-sidebar-chip")]
      .find((item) => item.textContent === "全局删除关键词");
    sidebarDeleteButton?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    window.confirm = originalConfirm;
    const sidebarKeywordDeleted = !paperKeywords(papers[0]).includes("全局删除关键词")
      && ![...document.querySelectorAll(".keyword-sidebar-chip")].some((item) => item.textContent === "全局删除关键词");
    const keywordCleanupReady = parseKeywords(["1正则化", "3D MRI（T1加权", "1. 正则化", "long explanatory English keyword"])
      .join("|") === "L1 正则化|3D MRI（T1加权）|正则化";
    await showPaperSource(paper.id);
    const libraryAiCandidates = window.deepPaperLibraryAi?.retrieveCandidates?.(papers, "阅读器测试", 5) || [];
    const ragIndex = window.deepPaperRag?.buildPassageIndex?.(papers);
    const embeddingPassages = [
      ...ragIndex.passages,
      { ...ragIndex.passages[0], passageId: "pdf-reader-smoke-paper:rag:1:extra-1", text: "A second embedding passage." },
      { ...ragIndex.passages[0], passageId: "pdf-reader-smoke-paper:rag:1:extra-2", text: "A third embedding passage." },
      { ...ragIndex.passages[0], passageId: "pdf-reader-smoke-paper:rag:1:duplicate", text: ragIndex.passages[0].text }
    ];
    const ragCandidates = window.deepPaperRag?.searchPassages?.(ragIndex, "sentence", 5, {
      extractTerms: window.deepPaperLibraryAi?.extractTerms,
      termAliases: window.deepPaperLibraryAi?.termAliases
    }) || [];
    const embeddingConfig = {
      embeddingEnabled: true,
      embeddingBaseUrl: "http://127.0.0.1:${embeddingPort}/v1",
      embeddingApiKey: "smoke-key",
      embeddingModel: "smoke-embedding"
    };
    const indexed = await window.deepPaperVectorStore.indexPassages(
      embeddingPassages,
      embeddingConfig,
      async (texts) => {
        const response = await window.deepPaper.createEmbeddings({ ...embeddingConfig, input: texts });
        if (!response.ok) throw new Error(response.error);
        return response.vectors;
      }
    );
    const vectorStatus = await window.deepPaperVectorStore.getStatus(embeddingPassages, embeddingConfig);
    const metadataMap = await window.deepPaperVectorStore.getMetadataMap(embeddingPassages, embeddingConfig);
    const queryEmbedding = await window.deepPaper.createEmbeddings({ ...embeddingConfig, input: ["sentence"] });
    const multimodalEmbedding = await window.deepPaper.createEmbeddings({
      ...embeddingConfig,
      embeddingBaseUrl: "http://127.0.0.1:${embeddingPort}/v1/embeddings/multimodal",
      embeddingModel: "doubao-embedding-vision-250615",
      input: ["sentence", "another passage"]
    });
    const vectorMap = await window.deepPaperVectorStore.getVectorMap(embeddingPassages, embeddingConfig);
    const hybridCandidates = window.deepPaperRag.searchPassagesHybrid(ragIndex, "unmatched semantic request", queryEmbedding.vectors[0], vectorMap, 5, {
      extractTerms: window.deepPaperLibraryAi?.extractTerms,
      termAliases: window.deepPaperLibraryAi?.termAliases
    });
    document.querySelector("#openLibraryAiBtn")?.click();
    const libraryAiPanelOpen = !document.querySelector("#libraryAiPanel")?.classList.contains("hidden");
    document.querySelector("#closeLibraryAiBtn")?.click();
    document.querySelector("#openDeepPaperAgentBtn")?.click();
    const agentPanel = document.querySelector("#deepPaperAgentPanel");
    const agentPanelOpen = Boolean(agentPanel && !agentPanel.classList.contains("hidden"));
    const agentEmptyReady = Boolean(agentPanel?.querySelector("#agentGoalInput") && agentPanel?.querySelector("#agentRunBtn"));
    const agentStopHidden = getComputedStyle(agentPanel?.querySelector("#agentStopBtn")).display === "none";
    const semanticIndexReady = Boolean(window.deepPaperVectorStore?.getStatus && agentPanel?.querySelector("#agentBuildIndexBtn"));
    document.querySelector("#editApiProfileBtn")?.click();
    const profileModal = document.querySelector("#apiProfileModal");
    const profileDialog = profileModal?.querySelector(".api-profile-dialog");
    const profileBox = document.querySelector("#apiProfileBox");
    const embeddingConfigReady = Boolean(
      document.querySelector("#apiProfileEmbeddingEnabled")
      && document.querySelector("#apiProfileEmbeddingBaseUrl")
      && document.querySelector("#apiProfileEmbeddingModelInput")
    );
    const profileModalReady = Boolean(
      profileModal
      && !profileModal.classList.contains("hidden")
      && profileDialog?.getBoundingClientRect().width > profileBox?.getBoundingClientRect().width
      && !profileBox?.contains(document.querySelector("#apiProfileEditor"))
      && document.querySelector("#apiProfileEditorTitle")?.textContent === "编辑接口"
    );
    const embeddingToggle = document.querySelector("#apiProfileEmbeddingEnabled");
    embeddingToggle.checked = true;
    embeddingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    const embeddingToggleReady = !document.querySelector("#embeddingFields")?.classList.contains("hidden")
      && document.querySelector("#embeddingStatusText")?.textContent === "已启用";
    embeddingToggle.checked = false;
    embeddingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#closeApiProfileEditorBtn")?.click();
    const profileModalClosed = profileModal?.classList.contains("hidden");
    document.querySelector("#agentCloseBtn")?.click();
    return {
      hasReaderScript: typeof renderDetailWithSourceQuote === "function",
      sourceTab: state.detailTab,
      hasLibraryAiButton: Boolean(document.querySelector("#openLibraryAiBtn")),
      libraryAiPanelOpen,
      libraryAiCandidateId: libraryAiCandidates[0]?.id || "",
      hasAgentButton: Boolean(document.querySelector("#openDeepPaperAgentBtn")),
      agentPanelOpen,
      agentEmptyReady,
      agentStopHidden,
      semanticIndexReady,
      embeddingConfigReady,
      profileModalReady,
      profileModalClosed,
      embeddingToggleReady,
      keywordAdded,
      keywordDeleted,
      sidebarKeywordDeleted,
      keywordCleanupReady,
      pageMapOk: Boolean(extractedPages.ok && extractedPages.pageTextOffsets?.[0]?.pageNumber === 1),
      ragPageNumber: ragCandidates[0]?.pageNumber || 0,
      ragPassageText: ragCandidates[0]?.text || "",
      vectorIndexed: indexed.indexed,
      vectorEmbedded: indexed.embedded,
      vectorReused: indexed.reused,
      vectorStatusIndexed: vectorStatus.indexed,
      vectorMetadataOk: metadataMap.get(ragIndex.passages[0].passageId)?.pageNumber === 1
        && metadataMap.get(ragIndex.passages[0].passageId)?.cleaningVersion === ragIndex.cleaningVersion,
      multimodalEmbeddingOk: multimodalEmbedding.ok,
      multimodalVectorCount: multimodalEmbedding.vectors?.length || 0,
      hybridPassageId: hybridCandidates[0]?.passageId || "",
      hybridMode: hybridCandidates[0]?.retrievalMode || ""
    };
  })()`);
  if (setup.sourceTab !== "source") throw new Error("DeepPaper did not switch to the source tab.");
  if (!setup.hasLibraryAiButton || !setup.libraryAiPanelOpen || setup.libraryAiCandidateId !== "pdf-reader-smoke-paper") {
    throw new Error(`Library AI integration did not initialize: ${JSON.stringify(setup)}`);
  }
  if (!setup.hasAgentButton || !setup.agentPanelOpen || !setup.agentEmptyReady || !setup.agentStopHidden || !setup.semanticIndexReady || !setup.embeddingConfigReady || !setup.profileModalReady || !setup.profileModalClosed || !setup.embeddingToggleReady) {
    throw new Error(`Agent UI did not initialize: ${JSON.stringify(setup)}`);
  }
  if (!setup.keywordAdded || !setup.keywordDeleted || !setup.sidebarKeywordDeleted || !setup.keywordCleanupReady) {
    throw new Error(`Keyword editing did not persist correctly: ${JSON.stringify(setup)}`);
  }
  if (!setup.pageMapOk || setup.ragPageNumber !== 1 || !setup.ragPassageText.includes("sentence")) {
    throw new Error(`RAG integration did not initialize: ${JSON.stringify(setup)}`);
  }
  if (setup.vectorIndexed !== 4 || setup.vectorStatusIndexed !== 4 || setup.vectorEmbedded !== 3 || setup.vectorReused !== 1 || !setup.vectorMetadataOk || !setup.hybridPassageId || setup.hybridMode !== "hybrid") {
    throw new Error(`Semantic RAG integration did not initialize: ${JSON.stringify(setup)}`);
  }
  if (!setup.multimodalEmbeddingOk || setup.multimodalVectorCount !== 2 || multimodalEmbeddingRequestCount !== 2) {
    throw new Error(`Volcengine multimodal Embedding IPC did not initialize: ${JSON.stringify(setup)}`);
  }
  if (!embeddingBatchRejectionCount || !embeddingSingleFailureCount || embeddingRequestCount < 5) {
    throw new Error("Embedding indexing did not reduce rejected batches and retry temporary failures.");
  }
  await waitForReader(client);

  const result = await evaluate(client, `(async () => {
    const target = ${JSON.stringify(targetText)};
    const spans = [...document.querySelectorAll("#pdfViewer .textLayer span")];
    const span = spans.find((item) => item.textContent.includes(target));
    if (!span?.firstChild) return { ok: false, reason: "target text span missing" };
    const toolbarPresentInitially = Boolean(document.querySelector("#pdfSelectionToolbar"));
    const leftResizer = document.querySelector('[data-resizer="left"]');
    const rightResizer = document.querySelector('[data-resizer="right"]');
    const sidebarWidthBefore = document.querySelector(".sidebar").getBoundingClientRect().width;
    const stateSidebarBefore = state.layout.sidebar;
    leftResizer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 340 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 340 }));
    const sidebarWidthAfter = document.querySelector(".sidebar").getBoundingClientRect().width;
    const stateSidebarAfter = state.layout.sidebar;
    const middleWidthBefore = document.querySelector(".main").getBoundingClientRect().width;
    rightResizer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 900 }));
    window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 960 }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 960 }));
    const middleWidthAfter = document.querySelector(".main").getBoundingClientRect().width;
    const resizerWidth = leftResizer.getBoundingClientRect().width;
    const start = span.firstChild.textContent.indexOf(target);
    const range = document.createRange();
    range.setStart(span.firstChild, start);
    range.setEnd(span.firstChild, start + target.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector("#pdfViewer").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const toolbarPresentAfterSelection = Boolean(document.querySelector("#pdfSelectionToolbar"));
    const outlinePresent = Boolean(document.querySelector("#pdfOutlineBtn, #pdfOutlinePanel"));
    const saved = JSON.parse(localStorage.getItem("deeppaper.corpus.v1") || "[]");
    return {
      ok: !toolbarPresentInitially && !toolbarPresentAfterSelection && !outlinePresent && sidebarWidthAfter > sidebarWidthBefore && middleWidthAfter > middleWidthBefore && resizerWidth >= 10 && saved[0]?.text === target && saved[0]?.pdfAnchor?.pages?.[0]?.pageNumber === 1,
      toolbarPresentInitially,
      toolbarPresentAfterSelection,
      outlinePresent,
      sidebarWidthBefore,
      sidebarWidthAfter,
      stateSidebarBefore,
      stateSidebarAfter,
      viewportWidth: window.innerWidth,
      appWidth: document.querySelector(".app").getBoundingClientRect().width,
      gridTemplateColumns: getComputedStyle(document.querySelector(".app")).gridTemplateColumns,
      appChildren: [...document.querySelector(".app").children].map((item) => ({
        className: item.className,
        width: item.getBoundingClientRect().width,
        left: item.getBoundingClientRect().left,
        gridColumn: getComputedStyle(item).gridColumn,
        cssWidth: getComputedStyle(item).width,
        minWidth: getComputedStyle(item).minWidth,
        maxWidth: getComputedStyle(item).maxWidth,
        justifySelf: getComputedStyle(item).justifySelf
      })),
      middleWidthBefore,
      middleWidthAfter,
      resizerWidth,
      savedText: saved[0]?.text || "",
      pageNumber: saved[0]?.pdfAnchor?.pages?.[0]?.pageNumber || null,
      rectCount: saved[0]?.pdfAnchor?.pages?.[0]?.rects?.length || 0,
      anchorVisible: Boolean(document.querySelector(".deeppaper-pdf-anchor")),
      iframePresent: Boolean(document.querySelector("iframe.pdf-preview-frame")),
      oldQuoteBoxPresent: Boolean(document.querySelector(".source-quote-tool"))
    };
  })()`);
  if (!result?.ok || !result.anchorVisible || result.iframePresent || result.oldQuoteBoxPresent || result.rectCount < 1) {
    throw new Error(`PDF reader smoke test failed: ${JSON.stringify(result)}`);
  }

  const savedId = await evaluate(client, `(async () => {
    const id = corpus[0].id;
    state.detailTab = "analysis";
    render();
    await showPaperSource("pdf-reader-smoke-paper");
    return id;
  })()`);
  await waitForReader(client);
  let persistedAnchor = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    persistedAnchor = await evaluate(client, `Boolean(document.querySelector(".deeppaper-pdf-anchor"))`);
    if (persistedAnchor) break;
    await wait(100);
  }
  const jumpResult = await evaluate(client, `(async () => {
    state.corpusOpen = true;
    renderCorpus();
    const jumpButton = document.querySelector('[data-corpus-jump="${savedId}"]');
    const jumpLabel = jumpButton?.textContent || "";
    await jumpToCorpusSource("${savedId}");
    return {
      jumpLabel,
      selectedId: state.selectedId,
      detailTab: state.detailTab,
      corpusClosed: !state.corpusOpen
    };
  })()`);
  if (!persistedAnchor || !jumpResult.jumpLabel.includes("第 1 页") || jumpResult.selectedId !== "pdf-reader-smoke-paper" || jumpResult.detailTab !== "source" || !jumpResult.corpusClosed) {
    throw new Error(`PDF persistence/jump smoke test failed: ${JSON.stringify({ persistedAnchor, jumpResult })}`);
  }
  if (screenshotDir) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    await client.send("Page.enable");
    await evaluate(client, `document.querySelector("#openDeepPaperAgentBtn")?.click()`);
    await wait(150);
    const agentShot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(screenshotDir, "agent-panel.png"), agentShot.data, "base64");
    await evaluate(client, `(() => {
      document.querySelector("#agentCloseBtn")?.click();
      state.configOpen = true;
      applyConfigPanel();
      document.querySelector("#editApiProfileBtn")?.click();
      document.querySelector(".embedding-config-details").open = true;
      const embeddingToggle = document.querySelector("#apiProfileEmbeddingEnabled");
      embeddingToggle.checked = true;
      embeddingToggle.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await wait(150);
    const configShot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(screenshotDir, "embedding-config.png"), configShot.data, "base64");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
    await wait(100);
    const mobileConfigShot = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(screenshotDir, "embedding-config-mobile.png"), mobileConfigShot.data, "base64");
    await client.send("Emulation.clearDeviceMetricsOverride");
  }
  console.log(`PDF reader smoke test passed: page ${result.pageNumber}, ${result.rectCount} anchor rect(s), persistence and source jump verified.`);
  await Promise.race([client.send("Browser.close"), wait(1000)]);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      socket?.close();
      embeddingServer?.close();
      if (electronProcess && !electronProcess.killed) electronProcess.kill();
      await wait(500);
      if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup of the isolated test instance.
    }
  });
