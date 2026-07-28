const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const electronPath = require("electron");
const projectRoot = path.join(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deeppaper-pdf-reader-"));
const userDataDir = path.join(testRoot, "profile");
const pdfPath = path.join(testRoot, "reader-smoke.pdf");
const port = 9300 + Math.floor(Math.random() * 500);
const targetText = "This sentence should enter the corpus.";
let electronProcess;
let socket;

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
    const { resolve, reject } = pending.get(message.id);
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
        pending.set(id, { resolve, reject });
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
    const paper = {
      id: "pdf-reader-smoke-paper",
      kind: "pdf",
      filePath: ${JSON.stringify(pdfPath)},
      fileName: "reader-smoke.pdf",
      text: ${JSON.stringify(targetText)},
      title: "PDF Reader Smoke Paper",
      titleEn: "PDF Reader Smoke Paper",
      titleZh: "PDF 阅读器测试论文",
      year: "2026",
      venue: "Smoke Test",
      pageCount: 1,
      status: "已解析",
      analysis: { keywords: ["阅读器测试"] }
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
    await showPaperSource(paper.id);
    const libraryAiCandidates = window.deepPaperLibraryAi?.retrieveCandidates?.(papers, "阅读器测试", 5) || [];
    document.querySelector("#openLibraryAiBtn")?.click();
    const libraryAiPanelOpen = !document.querySelector("#libraryAiPanel")?.classList.contains("hidden");
    document.querySelector("#closeLibraryAiBtn")?.click();
    return {
      hasReaderScript: typeof renderDetailWithSourceQuote === "function",
      sourceTab: state.detailTab,
      hasLibraryAiButton: Boolean(document.querySelector("#openLibraryAiBtn")),
      libraryAiPanelOpen,
      libraryAiCandidateId: libraryAiCandidates[0]?.id || ""
    };
  })()`);
  if (setup.sourceTab !== "source") throw new Error("DeepPaper did not switch to the source tab.");
  if (!setup.hasLibraryAiButton || !setup.libraryAiPanelOpen || setup.libraryAiCandidateId !== "pdf-reader-smoke-paper") {
    throw new Error(`Library AI integration did not initialize: ${JSON.stringify(setup)}`);
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
  console.log(`PDF reader smoke test passed: page ${result.pageNumber}, ${result.rectCount} anchor rect(s), persistence and source jump verified.`);
  await client.send("Browser.close");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      socket?.close();
      if (electronProcess && !electronProcess.killed) electronProcess.kill();
      await wait(500);
      if (path.resolve(testRoot).startsWith(path.resolve(os.tmpdir()))) {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup of the isolated test instance.
    }
  });
