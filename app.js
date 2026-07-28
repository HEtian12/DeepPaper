const STORAGE_KEY = "deeppaper.library.v1";
const CORPUS_KEY = "deeppaper.corpus.v1";
const COLLECTIONS_KEY = "deeppaper.collections.v1";
const CONFIG_KEY = "deeppaper.config.v1";
const FAVORITE_COLLECTION_ID = "favorite";
const DEFAULT_STATUS_MESSAGES = [
  "就绪：导入 PDF 后可单篇解析，也可以用“解析未解析”批量处理。",
  "提示：勾选论文后可批量解析或删除；删除只移除软件记录，不删除原 PDF。",
  "提示：左上角“导出库”可迁移完整解析结果，新电脑导入后不用重新 AI 解析。",
  "提示：每篇论文标题和摘要旁边的中/EN 可以单独切换，全局切换会批量切换显示语言。",
  "提示：右键关键词可删除，点 + 可以添加自定义关键词。",
  "提示：全文检索适合找相关内容，关键词检索适合严格按标签筛选；两者都支持 AND/OR。"
];
let statusTimer = null;

let papers = loadLibrary();
let corpus = loadCorpus();
let collections = loadCollections();
let state = {
  selectedId: papers[0]?.id || null,
  fullTextQuery: "",
  fullTextMode: "or",
  keywordQuery: "",
  keywordMode: "or",
  favoriteOnly: false,
  activeCollectionId: null,
  collectionsOpen: false,
  collectionCreating: false,
  collectionActionId: null,
  collectionRenamingId: null,
  collectionPickerPaperId: null,
  chatQuery: "",
  sort: "newest",
  batchSelectedIds: new Set(),
  duplicateGroups: [],
  corpusOpen: false,
  corpusQuery: "",
  corpusType: "",
  pendingSelection: null,
  chatAttachments: [],
  detailTab: "analysis",
  globalLanguage: "zh",
  theme: "standard",
  configOpen: false,
  layout: {
    sidebar: 330,
    detail: 430,
    sourceDetail: 1000
  }
};

const els = {
  apiKeyInput: document.querySelector("#apiKeyInput"),
  providerSelect: document.querySelector("#providerSelect"),
  toggleConfigBtn: document.querySelector("#toggleConfigBtn"),
  configPanel: document.querySelector("#configPanel"),
  modelSelect: document.querySelector("#modelSelect"),
  themeSelect: document.querySelector("#themeSelect"),
  saveKeyBtn: document.querySelector("#saveKeyBtn"),
  checkBalanceBtn: document.querySelector("#checkBalanceBtn"),
  balanceInfo: document.querySelector("#balanceInfo"),
  importPdfBtn: document.querySelector("#importPdfBtn"),
  importImageBtn: document.querySelector("#importImageBtn"),
  importLibraryBtn: document.querySelector("#importLibraryBtn"),
  exportLibraryBtn: document.querySelector("#exportLibraryBtn"),
  dropZone: document.querySelector("#dropZone"),
  fullTextSearchInput: document.querySelector("#fullTextSearchInput"),
  fullTextSearchMode: document.querySelector("#fullTextSearchMode"),
  keywordSearchInput: document.querySelector("#keywordSearchInput"),
  keywordSearchMode: document.querySelector("#keywordSearchMode"),
  keywordSuggestions: document.querySelector("#keywordSuggestions"),
  keywordList: document.querySelector("#keywordList"),
  analyzeAllBtn: document.querySelector("#analyzeAllBtn"),
  analyzeSelectedBtn: document.querySelector("#analyzeSelectedBtn"),
  deleteSelectedBtn: document.querySelector("#deleteSelectedBtn"),
  favoriteFilterBtn: document.querySelector("#favoriteFilterBtn"),
  collectionMenu: document.querySelector("#collectionMenu"),
  openCorpusBtn: document.querySelector("#openCorpusBtn"),
  globalLanguageSelect: document.querySelector("#globalLanguageSelect"),
  sortSelect: document.querySelector("#sortSelect"),
  manageBtn: document.querySelector("#manageBtn"),
  managePanel: document.querySelector("#managePanel"),
  detectDuplicatesBtn: document.querySelector("#detectDuplicatesBtn"),
  removeDuplicatesBtn: document.querySelector("#removeDuplicatesBtn"),
  clearLibraryBtn: document.querySelector("#clearLibraryBtn"),
  duplicateReport: document.querySelector("#duplicateReport"),
  libraryTitle: document.querySelector("#libraryTitle"),
  statusBar: document.querySelector("#statusBar"),
  paperList: document.querySelector("#paperList"),
  detailPanel: document.querySelector("#detailPanel"),
  selectionAddBtn: document.querySelector("#selectionAddBtn"),
  corpusPanel: document.querySelector("#corpusPanel"),
  closeCorpusBtn: document.querySelector("#closeCorpusBtn"),
  corpusTitle: document.querySelector("#corpusTitle"),
  corpusSearchInput: document.querySelector("#corpusSearchInput"),
  corpusTypeFilter: document.querySelector("#corpusTypeFilter"),
  corpusList: document.querySelector("#corpusList")
};

initConfig();
bindEvents();
render();

function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadCorpus() {
  try {
    return JSON.parse(localStorage.getItem(CORPUS_KEY) || "[]");
  } catch {
    return [];
  }
}

function loadCollections() {
  try {
    const value = JSON.parse(localStorage.getItem(COLLECTIONS_KEY) || "[]");
    return Array.isArray(value) ? value.map(normalizeCollection) : [];
  } catch {
    return [];
  }
}

function saveLibrary() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(papers, null, 2));
}

function saveCorpus() {
  localStorage.setItem(CORPUS_KEY, JSON.stringify(corpus, null, 2));
}

function saveCollections() {
  localStorage.setItem(COLLECTIONS_KEY, JSON.stringify(collections, null, 2));
}

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config, null, 2));
}

function currentConfig() {
  return {
    provider: els.providerSelect.value,
    apiKey: els.apiKeyInput.value.trim(),
    model: els.modelSelect.value,
    globalLanguage: state.globalLanguage,
    theme: state.theme,
    configOpen: state.configOpen,
    layout: state.layout
  };
}

function initConfig() {
  const config = loadConfig();
  els.providerSelect.value = config.provider || "deepseek";
  els.apiKeyInput.value = config.apiKey || "";
  els.modelSelect.value = config.model || "deepseek-chat";
  state.globalLanguage = config.globalLanguage || "zh";
  state.theme = config.theme || "standard";
  state.configOpen = Boolean(config.configOpen);
  state.layout = normalizeLayout(config.layout);
  els.globalLanguageSelect.value = state.globalLanguage;
  els.themeSelect.value = state.theme;
  applyConfigPanel();
  applyTheme();
  applyLayout();
}

function bindEvents() {
  els.saveKeyBtn.addEventListener("click", () => {
    saveConfig(currentConfig());
    setStatus("配置已保存。");
  });

  els.checkBalanceBtn.addEventListener("click", checkBalance);

  els.providerSelect.addEventListener("change", () => {
    if (els.providerSelect.value === "doubao" && (!els.modelSelect.value || els.modelSelect.value.startsWith("deepseek"))) {
      els.modelSelect.value = "doubao-1-5-vision-pro-32k";
    }
    if (els.providerSelect.value === "deepseek" && (!els.modelSelect.value || els.modelSelect.value.startsWith("doubao"))) {
      els.modelSelect.value = "deepseek-chat";
    }
    saveConfig(currentConfig());
  });

  els.toggleConfigBtn.addEventListener("click", () => {
    state.configOpen = !state.configOpen;
    applyConfigPanel();
    saveConfig(currentConfig());
  });

  els.themeSelect.addEventListener("change", (event) => {
    state.theme = event.target.value;
    applyTheme();
    saveConfig(currentConfig());
  });

  els.importPdfBtn.addEventListener("click", async () => {
    const filePaths = await window.deepPaper.choosePdf();
    await importPdfFiles(filePaths);
  });

  els.importImageBtn.addEventListener("click", async () => {
    const filePaths = await window.deepPaper.chooseImage();
    await importImageFiles(filePaths);
  });

  els.importLibraryBtn.addEventListener("click", importLibraryFile);
  els.exportLibraryBtn.addEventListener("click", exportLibraryFile);

  ["dragenter", "dragover"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    els.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragover");
    });
  });

  els.dropZone.addEventListener("drop", async (event) => {
    const filePaths = [...event.dataTransfer.files]
      .map((file) => window.deepPaper.getPathForFile(file))
      .filter((filePath) => filePath && filePath.toLowerCase().endsWith(".pdf"));

    if (!filePaths.length) {
      setStatus("没有识别到 PDF 文件。", true);
      return;
    }
    await importPdfFiles(filePaths);
  });

  els.dropZone.addEventListener("drop", async (event) => {
    const imagePaths = [...event.dataTransfer.files]
      .map((file) => window.deepPaper.getPathForFile(file))
      .filter(isImagePath);
    if (imagePaths.length) await importImageFiles(imagePaths);
  });

  els.fullTextSearchInput.addEventListener("input", (event) => {
    state.fullTextQuery = event.target.value;
    render();
  });

  els.fullTextSearchMode.addEventListener("change", (event) => {
    state.fullTextMode = event.target.value;
    render();
  });

  els.keywordSearchInput.addEventListener("input", (event) => {
    state.keywordQuery = event.target.value;
    render();
  });

  els.keywordSearchMode.addEventListener("change", (event) => {
    state.keywordMode = event.target.value;
    render();
  });

  els.sortSelect.addEventListener("change", (event) => {
    state.sort = event.target.value;
    render();
  });

  els.analyzeAllBtn.addEventListener("click", () => {
    const ids = papers.filter((paper) => !paper.analysis).map((paper) => paper.id);
    analyzeBatch(ids, "未解析论文");
  });

  els.analyzeSelectedBtn.addEventListener("click", () => {
    analyzeBatch([...state.batchSelectedIds], "选中论文");
  });

  els.deleteSelectedBtn.addEventListener("click", deleteSelectedPapers);
  els.favoriteFilterBtn.addEventListener("click", () => {
    state.collectionsOpen = !state.collectionsOpen;
    render();
  });
  els.openCorpusBtn.addEventListener("click", () => {
    state.corpusOpen = true;
    renderCorpus();
  });
  els.closeCorpusBtn.addEventListener("click", () => {
    state.corpusOpen = false;
    renderCorpus();
  });
  els.corpusSearchInput.addEventListener("input", (event) => {
    state.corpusQuery = event.target.value;
    renderCorpus();
  });
  els.corpusTypeFilter.addEventListener("change", (event) => {
    state.corpusType = event.target.value;
    renderCorpus();
  });
  els.selectionAddBtn.addEventListener("click", addPendingSelectionToCorpus);
  els.detailPanel.addEventListener("mouseup", handleDetailSelection);

  els.globalLanguageSelect.addEventListener("change", (event) => {
    applyGlobalLanguage(event.target.value);
  });

  els.manageBtn.addEventListener("click", () => {
    els.managePanel.classList.toggle("hidden");
  });

  els.detectDuplicatesBtn.addEventListener("click", () => {
    state.duplicateGroups = findDuplicateGroups();
    renderDuplicateReport();
  });

  els.removeDuplicatesBtn.addEventListener("click", removeDuplicateExtras);

  els.clearLibraryBtn.addEventListener("click", () => {
    if (!confirm("确认清空本地文献库？这会删除当前软件中保存的所有论文记录、解析结果、关键词和对话。")) return;
    papers = [];
    corpus = [];
    collections = [];
    state.selectedId = null;
    state.activeCollectionId = null;
    state.collectionPickerPaperId = null;
    state.batchSelectedIds.clear();
    state.duplicateGroups = [];
    saveLibrary();
    saveCorpus();
    saveCollections();
    renderDuplicateReport();
    render();
    renderCorpus();
  });

  bindColumnResizers();
}

async function checkBalance() {
  const config = currentConfig();
  if (config.provider === "doubao") {
    els.balanceInfo.textContent = "豆包/火山方舟余额请在火山方舟控制台查看；本软件当前只支持 DeepSeek 余额查询。";
    els.balanceInfo.classList.remove("error");
    return;
  }
  if (!config.apiKey) {
    els.balanceInfo.textContent = "请先填写 API Key。";
    els.balanceInfo.classList.add("error");
    return;
  }

  els.balanceInfo.textContent = "正在查询余额...";
  els.balanceInfo.classList.remove("error");
  const result = await window.deepPaper.getDeepSeekBalance(config.apiKey);
  if (!result.ok) {
    els.balanceInfo.textContent = result.error;
    els.balanceInfo.classList.add("error");
    return;
  }

  els.balanceInfo.textContent = formatBalance(result.result);
  els.balanceInfo.classList.remove("error");
}

async function importPdfFiles(filePaths) {
  if (!filePaths?.length) return;
  let imported = 0;
  let skipped = 0;
  const seenHashes = new Set(papers.map((paper) => paper.fileHash).filter(Boolean));
  const seenPaths = new Set(papers.map((paper) => paper.filePath).filter(Boolean));

  for (const filePath of filePaths) {
    setStatus(`正在提取 PDF：${filePath}`);
    const result = await window.deepPaper.extractPdf(filePath);
    if (!result.ok) {
      setStatus(`导入失败：${result.error}`, true);
      continue;
    }

    if (seenPaths.has(result.filePath) || (result.fileHash && seenHashes.has(result.fileHash))) {
      skipped += 1;
      continue;
    }

    const existing = papers.find((paper) => paper.filePath === result.filePath);
    const paper = existing || {
      id: crypto.randomUUID(),
      importedAt: new Date().toISOString(),
      analysis: null,
      chat: [],
      favorite: false,
      collectionIds: [],
      titleLang: "zh",
      abstractLang: "zh",
      abstractOpen: false
    };

    Object.assign(paper, {
      filePath: result.filePath,
      fileName: result.fileName,
      fileHash: result.fileHash,
      fileSize: result.fileSize,
      pageCount: result.pageCount,
      text: result.text,
      title: existing?.title || guessTitleFromText(result.text) || cleanTitleFromFile(result.fileName),
      status: existing?.status || "待解析",
      chat: existing?.chat || paper.chat || [],
      titleLang: existing?.titleLang || paper.titleLang || "zh",
      abstractLang: existing?.abstractLang || paper.abstractLang || "zh",
      abstractOpen: existing?.abstractOpen ?? paper.abstractOpen ?? false
    });

    if (!existing) papers.unshift(paper);
    imported += 1;
    if (result.fileHash) seenHashes.add(result.fileHash);
    seenPaths.add(result.filePath);
    state.selectedId = paper.id;
    saveLibrary();
    render();
  }

  setStatus(`已导入 ${imported} / ${filePaths.length} 个 PDF${skipped ? `，跳过重复 ${skipped} 个` : ""}。`);
}

async function importImageFiles(filePaths) {
  if (!filePaths?.length) return;
  let imported = 0;
  let skipped = 0;
  const seenHashes = new Set(papers.map((paper) => paper.fileHash).filter(Boolean));
  const seenPaths = new Set(papers.map((paper) => paper.filePath).filter(Boolean));

  for (const filePath of filePaths.filter(isImagePath)) {
    setStatus(`正在导入图片：${filePath}`);
    const result = await window.deepPaper.extractImage(filePath);
    if (!result.ok) {
      setStatus(`导入图片失败：${result.error}`, true);
      continue;
    }
    if (seenPaths.has(result.filePath) || (result.fileHash && seenHashes.has(result.fileHash))) {
      skipped += 1;
      continue;
    }
    const paper = {
      id: crypto.randomUUID(),
      kind: "image",
      importedAt: new Date().toISOString(),
      analysis: null,
      chat: [],
      favorite: false,
      collectionIds: [],
      titleLang: "zh",
      abstractLang: "zh",
      abstractOpen: false,
      filePath: result.filePath,
      fileName: result.fileName,
      fileHash: result.fileHash,
      fileSize: result.fileSize,
      mimeType: result.mimeType,
      imageDataUrl: result.imageDataUrl,
      text: "",
      title: cleanTitleFromFile(result.fileName),
      status: "待解析"
    };
    papers.unshift(paper);
    imported += 1;
    if (result.fileHash) seenHashes.add(result.fileHash);
    seenPaths.add(result.filePath);
    state.selectedId = paper.id;
    saveLibrary();
    render();
  }

  setStatus(`已导入 ${imported} / ${filePaths.length} 张图片${skipped ? `，跳过重复 ${skipped} 张` : ""}。`);
}

function isImagePath(filePath) {
  return /\.(png|jpe?g|webp|bmp)$/i.test(String(filePath || ""));
}

async function importLibraryFile() {
  const result = await window.deepPaper.importLibrary();
  if (!result.ok) {
    if (!result.canceled) setStatus(`导入库失败：${result.error}`, true);
    return;
  }

  try {
    const data = JSON.parse(result.content);
    const importedPapers = Array.isArray(data) ? data : data.papers;
    if (!Array.isArray(importedPapers)) throw new Error("文件中没有可识别的论文库数据。");
    papers = importedPapers.map(normalizeImportedPaper);
    corpus = Array.isArray(data.corpus) ? data.corpus.map(normalizeCorpusItem) : [];
    collections = Array.isArray(data.collections) ? data.collections.map(normalizeCollection) : [];
    window.deepPaperLibraryAi?.importState?.(data.libraryAi);
    state.selectedId = papers[0]?.id || null;
    state.batchSelectedIds.clear();
    state.activeCollectionId = null;
    saveLibrary();
    saveCorpus();
    saveCollections();
    setStatus(`已导入文献库：${papers.length} 篇论文`);
    render();
    renderCorpus();
  } catch (error) {
    setStatus(`导入库失败：${error.message}`, true);
  }
}

async function exportLibraryFile() {
  const payload = {
    app: "DeepPaper",
    version: 2,
    exportedAt: new Date().toISOString(),
    papers,
    corpus,
    collections,
    libraryAi: window.deepPaperLibraryAi?.exportState?.() || null
  };
  const result = await window.deepPaper.exportLibrary(payload);
  if (!result.ok) {
    if (!result.canceled) setStatus(`导出库失败：${result.error}`, true);
    return;
  }
  setStatus(`文献库已导出：${result.filePath}`);
}

function normalizeCorpusItem(item) {
  return {
    ...item,
    id: item.id || crypto.randomUUID(),
    paperId: item.paperId || "",
    text: String(item.text || ""),
    type: item.type || "其他",
    tags: Array.isArray(item.tags) ? item.tags : parseKeywords(item.tags || ""),
    note: item.note || "",
    sourceLabel: item.sourceLabel || "",
    createdAt: item.createdAt || new Date().toISOString()
  };
}

function normalizeCollection(collection) {
  return {
    id: collection.id || crypto.randomUUID(),
    name: String(collection.name || "未命名合集").trim() || "未命名合集",
    createdAt: collection.createdAt || new Date().toISOString()
  };
}

function normalizeImportedPaper(paper) {
  return {
    ...paper,
    id: paper.id || crypto.randomUUID(),
    importedAt: paper.importedAt || new Date().toISOString(),
    kind: paper.kind || "pdf",
    chat: Array.isArray(paper.chat) ? paper.chat : [],
    keywords: Array.isArray(paper.keywords) ? paper.keywords : [],
    collectionIds: Array.isArray(paper.collectionIds) ? paper.collectionIds : [],
    favorite: Boolean(paper.favorite),
    lastError: paper.lastError || null,
    lastRawAnalysis: paper.lastRawAnalysis || "",
    analysisRepaired: Boolean(paper.analysisRepaired),
    imageDataUrl: paper.imageDataUrl || "",
    mimeType: paper.mimeType || "",
    titleLang: paper.titleLang || "zh",
    abstractLang: paper.abstractLang || "zh",
    abstractOpen: Boolean(paper.abstractOpen)
  };
}

function deleteSelectedPapers() {
  const ids = [...state.batchSelectedIds];
  if (!ids.length) {
    setStatus("请先勾选要删除的论文。", true);
    return;
  }
  if (!confirm(`确认删除选中的 ${ids.length} 篇论文记录？这会删除本软件中的解析结果、关键词和对话，不会删除原 PDF 文件。`)) return;
  const idSet = new Set(ids);
  papers = papers.filter((paper) => !idSet.has(paper.id));
  corpus = corpus.filter((item) => !idSet.has(item.paperId));
  state.batchSelectedIds.clear();
  if (!papers.some((paper) => paper.id === state.selectedId)) {
    state.selectedId = papers[0]?.id || null;
  }
  saveLibrary();
  saveCorpus();
  setStatus(`已删除 ${ids.length} 篇论文记录。`);
  render();
  renderCorpus();
}

function findDuplicateGroups() {
  const buckets = new Map();
  papers.forEach((paper) => {
    const key = duplicateKey(paper);
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(paper.id);
  });
  return [...buckets.values()].filter((ids) => ids.length > 1);
}

function duplicateKey(paper) {
  if (paper.fileHash) return `hash:${paper.fileHash}`;
  const doi = paper.analysis?.doi || paper.doi;
  if (doi) return `doi:${normalizeText(doi)}`;
  const title = normalizeText(paper.titleEn || paper.analysis?.title_en || paper.titleZh || paper.analysis?.title_zh || paper.title);
  if (!title || title.length < 12) return "";
  return `title:${title}|year:${paper.year || ""}`;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function renderDuplicateReport() {
  if (!state.duplicateGroups.length) {
    els.duplicateReport.textContent = "未检测到疑似重复论文。";
    return;
  }
  els.duplicateReport.innerHTML = state.duplicateGroups.map((group, index) => {
    const items = group
      .map((id) => papers.find((paper) => paper.id === id))
      .filter(Boolean)
      .map((paper) => `<li>${escapeHtml(displayTitle(paper))} <span>${escapeHtml([paper.year, paper.venue].filter(Boolean).join(" | "))}</span></li>`)
      .join("");
    return `<div class="duplicate-group"><strong>疑似重复 ${index + 1}</strong><ul>${items}</ul></div>`;
  }).join("");
}

function removeDuplicateExtras() {
  const groups = state.duplicateGroups.length ? state.duplicateGroups : findDuplicateGroups();
  if (!groups.length) {
    setStatus("没有检测到可删除的疑似重复论文。", true);
    renderDuplicateReport();
    return;
  }
  const removeIds = groups.flatMap((group) => group.slice(1));
  if (!confirm(`确认删除 ${removeIds.length} 条疑似重复记录？每组会保留第一条记录，原 PDF 文件不会被删除。`)) return;
  const removeSet = new Set(removeIds);
  papers = papers.filter((paper) => !removeSet.has(paper.id));
  corpus = corpus.filter((item) => !removeSet.has(item.paperId));
  state.batchSelectedIds = new Set([...state.batchSelectedIds].filter((id) => !removeSet.has(id)));
  if (!papers.some((paper) => paper.id === state.selectedId)) {
    state.selectedId = papers[0]?.id || null;
  }
  state.duplicateGroups = [];
  saveLibrary();
  saveCorpus();
  renderDuplicateReport();
  setStatus(`已删除 ${removeIds.length} 条疑似重复记录。`);
  render();
  renderCorpus();
}

function applyGlobalLanguage(language) {
  state.globalLanguage = language === "en" ? "en" : "zh";
  papers.forEach((paper) => {
    paper.titleLang = state.globalLanguage;
    paper.abstractLang = state.globalLanguage;
  });
  saveLibrary();
  saveConfig(currentConfig());
  setStatus(`已切换为${state.globalLanguage === "en" ? "英文" : "中文"}视图。`);
  render();
}

function applyTheme() {
  document.body.dataset.theme = state.theme || "standard";
}

function applyConfigPanel() {
  els.configPanel.classList.toggle("collapsed", !state.configOpen);
  els.toggleConfigBtn.textContent = state.configOpen ? "收起" : "配置";
}

function applyLayout() {
  state.layout = normalizeLayout(state.layout);
  document.documentElement.style.setProperty("--sidebar-width", `${state.layout.sidebar}px`);
  document.documentElement.style.setProperty("--detail-width", `${state.layout.detail}px`);
  document.documentElement.style.setProperty("--source-detail-width", `${state.layout.sourceDetail}px`);
}

function bindColumnResizers() {
  document.querySelectorAll("[data-resizer]").forEach((resizer) => {
    resizer.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const side = resizer.dataset.resizer;
      const startX = event.clientX;
      const startSidebar = state.layout.sidebar;
      const startDetail = state.layout.detail;
      const startSourceDetail = state.layout.sourceDetail;
      const sourceFocus = document.body.classList.contains("source-focus");
      document.body.classList.add("resizing");

      const onMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (side === "left") {
          state.layout.sidebar = clampNumber(startSidebar + delta, 280, 560, startSidebar);
        } else if (sourceFocus) {
          state.layout.sourceDetail = clampNumber(startSourceDetail - delta, 520, maxSourceDetailWidth(), startSourceDetail);
        } else {
          state.layout.detail = clampNumber(startDetail - delta, 320, 760, startDetail);
        }
        applyLayout();
      };

      const onUp = () => {
        document.body.classList.remove("resizing");
        saveConfig(currentConfig());
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
  window.addEventListener("resize", applyLayout);
}

function defaultSourceDetailWidth(sidebar = 330) {
  return Math.min(1100, maxSourceDetailWidth(sidebar), Math.max(520, Math.round(window.innerWidth * 0.57)));
}

function maxSourceDetailWidth(sidebar = state.layout?.sidebar || 330) {
  return Math.max(520, window.innerWidth - sidebar - 20 - 320);
}

function normalizeLayout(layout = {}) {
  const sidebar = clampNumber(layout.sidebar, 280, 560, 330);
  const detail = clampNumber(layout.detail, 320, 760, 430);
  const sourceDetail = Math.min(
    clampNumber(layout.sourceDetail, 520, 1400, defaultSourceDetailWidth(sidebar)),
    maxSourceDetailWidth(sidebar)
  );
  return { sidebar, detail, sourceDetail };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function togglePaperTitleLanguage(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  paper.titleLang = paper.titleLang === "en" ? "zh" : "en";
  saveLibrary();
  render();
}

function togglePaperAbstractLanguage(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  paper.abstractLang = paper.abstractLang === "en" ? "zh" : "en";
  saveLibrary();
  render();
}

function togglePaperFavorite(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  paper.favorite = !paper.favorite;
  saveLibrary();
  setStatus(paper.favorite ? "已加入收藏。" : "已取消收藏。");
  render();
}

function createCollection(name) {
  const cleanName = String(name || "").trim();
  if (!cleanName) return;
  collections.unshift({
    id: crypto.randomUUID(),
    name: cleanName,
    createdAt: new Date().toISOString()
  });
  saveCollections();
  state.activeCollectionId = collections[0].id;
  state.collectionsOpen = true;
  state.collectionCreating = false;
  setStatus(`已创建合集：${cleanName}`);
  render();
}

function selectCollection(id) {
  state.activeCollectionId = state.activeCollectionId === id ? null : id;
  render();
}

function renameCollection(id, name) {
  const collection = collections.find((item) => item.id === id);
  if (!collection) return;
  const cleanName = String(name || "").trim();
  if (!cleanName) return;
  collection.name = cleanName;
  state.collectionRenamingId = null;
  state.collectionActionId = null;
  saveCollections();
  render();
}

function deleteCollection(id) {
  const collection = collections.find((item) => item.id === id);
  if (!collection) return;
  if (!confirm(`确认删除合集“${collection.name}”？论文不会被删除。`)) return;
  collections = collections.filter((item) => item.id !== id);
  papers.forEach((paper) => {
    paper.collectionIds = (paper.collectionIds || []).filter((collectionId) => collectionId !== id);
  });
  if (state.activeCollectionId === id) state.activeCollectionId = null;
  saveCollections();
  saveLibrary();
  render();
}

function togglePaperCollection(paperId, collectionId) {
  const paper = papers.find((item) => item.id === paperId);
  if (!paper) return;
  if (collectionId === FAVORITE_COLLECTION_ID) {
    paper.favorite = !paper.favorite;
  } else {
    paper.collectionIds = Array.isArray(paper.collectionIds) ? paper.collectionIds : [];
    if (paper.collectionIds.includes(collectionId)) {
      paper.collectionIds = paper.collectionIds.filter((id) => id !== collectionId);
    } else {
      paper.collectionIds.push(collectionId);
    }
  }
  saveLibrary();
  render();
}

function collectionPapersCount(id) {
  if (id === FAVORITE_COLLECTION_ID) return papers.filter((paper) => paper.favorite).length;
  return papers.filter((paper) => (paper.collectionIds || []).includes(id)).length;
}

function isPaperInCollection(paper, id) {
  if (id === FAVORITE_COLLECTION_ID) return Boolean(paper.favorite);
  return (paper.collectionIds || []).includes(id);
}

async function openPaperFile(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper?.filePath) {
    setStatus("没有可打开的 PDF 文件路径。", true);
    return;
  }

  const result = await window.deepPaper.openPdf(paper.filePath);
  if (!result.ok) {
    setStatus(`打开 PDF 失败：${result.error}`, true);
    return;
  }
  setStatus(`已打开：${paper.fileName || paper.filePath}`);
}

async function openPaperAddress(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  if (!paper.filePath) {
    setStatus("这篇论文没有可定位的本地 PDF 路径。", true);
    return;
  }
  const result = await window.deepPaper.openFileLocation(paper.filePath);
  if (!result.ok) {
    setStatus(`打开本地地址失败：${result.error}`, true);
    return;
  }
  setStatus(`已定位本地文件：${paper.fileName || paper.filePath}`);
}

async function analyzePaper(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return false;
  const config = currentConfig();
  saveConfig(config);
  setStatus(`DeepSeek 正在解析：${paper.fileName}`);
  paper.status = "解析中";
  render();

  const result = await window.deepPaper.analyzeWithDeepSeek({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    fileName: paper.fileName,
    paperText: paper.text,
    imageDataUrl: paper.imageDataUrl || ""
  });

  if (!result.ok) {
    paper.status = "解析失败";
    paper.lastError = {
      message: result.error || "未知错误",
      phase: result.phase || "unknown",
      raw: result.raw || "",
      at: new Date().toISOString()
    };
    setStatus(result.error, true);
    saveLibrary();
    render();
    return false;
  }

  paper.analysis = result.result;
  paper.lastError = null;
  paper.lastRawAnalysis = result.raw || "";
  paper.analysisRepaired = Boolean(result.repaired);
  paper.titleZh = result.result.title_zh || result.result.title || paper.titleZh;
  paper.titleEn = result.result.title_en || paper.titleEn;
  paper.title = paper.titleZh || paper.titleEn || result.result.title || paper.title;
  paper.year = result.result.year || paper.year;
  paper.venue = result.result.venue || paper.venue;
  paper.venueRank = result.result.venue_rank || paper.venueRank || null;
  paper.doi = result.result.doi || paper.doi || "";
  paper.url = result.result.url || paper.url || "";
  paper.authors = result.result.authors || paper.authors || [];
  paper.keywords = mergeKeywords(paper.keywords, result.result.keywords);
  syncDerivedKeywords(paper);
  result.result.title = paper.title;
  result.result.title_zh = paper.titleZh || null;
  result.result.title_en = paper.titleEn || null;
  result.result.venue_rank = paper.venueRank;
  result.result.doi = paper.doi || null;
  result.result.url = paper.url || null;
  result.result.keywords = paper.keywords;
  paper.status = "已解析";
  saveLibrary();
  setStatus(`解析完成：${paper.title}`);
  render();
  return true;
}

async function analyzeBatch(ids, label) {
  const uniqueIds = [...new Set(ids)].filter((id) => papers.some((paper) => paper.id === id));
  if (!uniqueIds.length) {
    setStatus(`没有需要解析的${label || "论文"}。`, true);
    return;
  }

  let success = 0;
  for (const id of uniqueIds) {
    state.selectedId = id;
    const ok = await analyzePaper(id);
    if (ok) success += 1;
  }
  setStatus(`批量解析完成：${success} / ${uniqueIds.length}`);
}

function parseKeywords(value) {
  return uniqueTextItems(
    String(value || "")
      .split(/[,，;；\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function mergeKeywords(...groups) {
  return uniqueTextItems(groups.flatMap((group) => Array.isArray(group) ? group : []));
}

function uniqueTextItems(items) {
  const seen = new Set();
  const result = [];
  items.forEach((item) => {
    const value = String(item || "").trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

function addPaperKeyword(id, value) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  const keywords = parseKeywords(value);
  if (!keywords.length) return;
  paper.keywords = mergeKeywords(paper.keywords, keywords);
  syncAnalysisKeywords(paper);
  saveLibrary();
  setStatus(`关键词已更新：${paper.keywords.length} 个`);
  render();
}

function removePaperKeyword(id, index) {
  const paper = papers.find((item) => item.id === id);
  if (!paper || !Array.isArray(paper.keywords)) return;
  paper.keywords.splice(index, 1);
  syncAnalysisKeywords(paper);
  saveLibrary();
  setStatus(`关键词已更新：${paper.keywords.length} 个`);
  render();
}

function syncAnalysisKeywords(paper) {
  if (paper.analysis) paper.analysis.keywords = paper.keywords || [];
}

function paperKeywords(paper) {
  const analysis = paper?.analysis || {};
  return uniqueTextItems([
    ...(Array.isArray(paper?.keywords) ? paper.keywords : parseKeywords(paper?.keywords || "")),
    ...(Array.isArray(analysis.keywords) ? analysis.keywords : parseKeywords(analysis.keywords || "")),
    ...(Array.isArray(analysis.keyword) ? analysis.keyword : parseKeywords(analysis.keyword || "")),
    ...(Array.isArray(analysis.key_words) ? analysis.key_words : parseKeywords(analysis.key_words || "")),
    ...(Array.isArray(analysis.tags) ? analysis.tags : parseKeywords(analysis.tags || "")),
    analysis.task,
    analysis.domain,
    analysis.method?.method_name,
    ...(Array.isArray(analysis.method?.modules) ? analysis.method.modules : parseKeywords(analysis.method?.modules || "")),
    ...(Array.isArray(analysis.modality) ? analysis.modality : parseKeywords(analysis.modality || ""))
  ]).slice(0, 12);
}

function syncDerivedKeywords(paper) {
  const keywords = paperKeywords(paper);
  if (!keywords.length) return [];
  paper.keywords = keywords;
  if (paper.analysis) paper.analysis.keywords = keywords;
  return keywords;
}

async function sendChatMessage(id) {
  const paper = papers.find((item) => item.id === id);
  const input = document.querySelector("#chatInput");
  if (!paper || !input) return;

  const message = input.value.trim();
  if (!message) return;
  const config = currentConfig();
  saveConfig(config);

  paper.chat = paper.chat || [];
  paper.chat.push({
    role: "user",
    content: message,
    at: new Date().toISOString()
  });
  input.value = "";
  saveLibrary();
  render();
  scrollChatToBottom();
  setStatus("DeepSeek 正在回答论文问题...");

  const result = await window.deepPaper.chatWithDeepSeek({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    paper: compactPaperForChat(paper),
    history: paper.chat.slice(0, -1),
    message
  });

  paper.chat = paper.chat || [];
  if (!result.ok) {
    paper.chat.push({
      role: "assistant",
      content: `请求失败：${result.error}`,
      at: new Date().toISOString(),
      error: true
    });
    setStatus(result.error, true);
  } else {
    paper.chat.push({
      role: "assistant",
      content: result.message,
      at: new Date().toISOString()
    });
    setStatus("论文对话已更新。");
  }
  saveLibrary();
  render();
  scrollChatToBottom();
}

function deleteChatMessage(id, index) {
  const paper = papers.find((item) => item.id === id);
  if (!paper?.chat?.length) return;
  paper.chat.splice(index, 1);
  saveLibrary();
  render();
  setStatus("已删除这条对话。");
}

function clearPaperChat(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper?.chat?.length) return;
  if (!confirm("确认清空这篇论文的全部对话内容？")) return;
  paper.chat = [];
  state.chatQuery = "";
  saveLibrary();
  render();
  setStatus("已清空这篇论文的对话。");
}

function scrollChatToBottom() {
  requestAnimationFrame(() => {
    const messages = document.querySelector("#chatMessages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
}

function compactPaperForChat(paper) {
  return {
    fileName: paper.fileName,
    title: paper.title,
    year: paper.year,
    venue: paper.venue,
    authors: paper.authors,
    pageCount: paper.pageCount,
    analysis: paper.analysis,
    text: paper.text
  };
}

function getFilteredPapers() {
  const fullTextTerms = parseSearchTerms(state.fullTextQuery);
  const keywordTerms = parseSearchTerms(state.keywordQuery);
  const filtered = papers.filter((paper) => {
    if (state.activeCollectionId && !isPaperInCollection(paper, state.activeCollectionId)) return false;
    const fullText = paperTextForSearch(paper).toLowerCase();
    const keywordText = paperKeywords(paper).join(" ").toLowerCase();
    return matchesTerms(fullText, fullTextTerms, state.fullTextMode) &&
      matchesTerms(keywordText, keywordTerms, state.keywordMode);
  });

  return filtered.sort((a, b) => {
    if (state.sort === "title") return displayTitle(a).localeCompare(displayTitle(b), "zh-CN");
    if (state.sort === "year-desc") return Number(b.year || 0) - Number(a.year || 0);
    return new Date(b.importedAt) - new Date(a.importedAt);
  });
}

function parseSearchTerms(value) {
  return String(value || "")
    .split(/[\s,，;；、|]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function matchesTerms(text, terms, mode) {
  if (!terms.length) return true;
  return mode === "and"
    ? terms.every((term) => text.includes(term))
    : terms.some((term) => text.includes(term));
}

function paperTextForSearch(paper) {
  const analysis = paper.analysis || {};
  return [
    paper.title,
    paper.titleZh,
    paper.titleEn,
    paper.fileName,
    paper.year,
    paper.venue,
    venueRankLabel(paper),
    ...(paper.authors || []),
    ...paperKeywords(paper),
    analysis.abstract,
    analysis.abstract_zh,
    analysis.abstract_en,
    analysis.task,
    analysis.domain,
    ...(analysis.datasets || []),
    ...(analysis.metrics || []),
    ...(analysis.contributions || []),
    analysis.motivation?.problem_background,
    analysis.motivation?.research_gap,
    analysis.motivation?.why_it_matters,
    analysis.method?.method_name,
    analysis.method?.core_idea,
    ...(analysis.method?.modules || []),
    ...(analysis.main_results || []),
    ...(analysis.writing_uses || []),
    ...(paper.chat || []).map((item) => item.content)
  ].filter(Boolean).join(" ");
}

function render() {
  const filtered = getFilteredPapers();
  const searching = parseSearchTerms(state.fullTextQuery).length || parseSearchTerms(state.keywordQuery).length;
  els.libraryTitle.textContent = searching ? `当前 ${filtered.length} / 全库 ${papers.length}` : `${papers.length} 篇论文`;
  const selectedCount = state.batchSelectedIds.size;
  const pendingCount = papers.filter((paper) => !paper.analysis).length;
  els.analyzeAllBtn.textContent = pendingCount ? `解析未解析 (${pendingCount})` : "解析未解析";
  els.analyzeSelectedBtn.textContent = selectedCount ? `解析选中 (${selectedCount})` : "解析选中";
  els.deleteSelectedBtn.textContent = selectedCount ? `删除选中 (${selectedCount})` : "删除选中";
  els.favoriteFilterBtn.textContent = state.activeCollectionId ? `合集：${activeCollectionName()}` : "合集";
  els.favoriteFilterBtn.classList.toggle("active", Boolean(state.activeCollectionId) || state.collectionsOpen);
  els.openCorpusBtn.textContent = corpus.length ? `语料库 (${corpus.length})` : "语料库";
  renderCollectionMenu();
  renderKeywords();
  renderKeywordSuggestions();
  renderPaperList(filtered);
  document.body.classList.toggle("source-focus", state.detailTab === "source");
  renderDetail(papers.find((paper) => paper.id === state.selectedId));
  if (state.corpusOpen) renderCorpus();
}

function activeCollectionName() {
  if (state.activeCollectionId === FAVORITE_COLLECTION_ID) return "收藏";
  return collections.find((item) => item.id === state.activeCollectionId)?.name || "未知合集";
}

function orderedCollections() {
  return [...collections].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function renderCollectionMenu() {
  if (!els.collectionMenu) return;
  els.collectionMenu.classList.toggle("hidden", !state.collectionsOpen);
  if (!state.collectionsOpen) return;
  const customCollections = orderedCollections();
  const customHtml = customCollections.map((collection) => `
    <button class="collection-item ${state.activeCollectionId === collection.id ? "active" : ""}" data-collection-id="${collection.id}">
      <span>${escapeHtml(collection.name)}</span>
      <span>${collectionPapersCount(collection.id)}</span>
    </button>
    ${state.collectionRenamingId === collection.id ? `
      <div class="collection-create-row collection-rename-row">
        <input data-rename-input="${collection.id}" type="text" value="${escapeHtml(collection.name)}" />
        <button class="secondary small-btn" data-confirm-rename="${collection.id}">保存</button>
        <button class="secondary small-btn" data-cancel-rename="${collection.id}">取消</button>
      </div>
    ` : ""}
    ${state.collectionActionId === collection.id ? `
      <div class="collection-actions-inline">
        <button class="secondary small-btn" data-rename-collection="${collection.id}">重命名</button>
        <button class="secondary danger small-btn" data-delete-collection="${collection.id}">删除</button>
      </div>
    ` : ""}
  `).join("");

  els.collectionMenu.innerHTML = `
    <div class="collection-menu-head">
      <button class="secondary" id="addCollectionBtn">新增合集</button>
      <button class="secondary small-btn" id="clearCollectionFilterBtn">全部论文</button>
    </div>
    ${state.collectionCreating ? `
      <div class="collection-create-row">
        <input id="newCollectionInput" type="text" placeholder="输入合集名" />
        <button class="secondary small-btn" id="confirmCollectionBtn">创建</button>
        <button class="secondary small-btn" id="cancelCollectionBtn">取消</button>
      </div>
    ` : ""}
    <div class="collection-list">
      <button class="collection-item builtin ${state.activeCollectionId === FAVORITE_COLLECTION_ID ? "active" : ""}" data-collection-id="${FAVORITE_COLLECTION_ID}">
        <span>收藏</span>
        <span>${collectionPapersCount(FAVORITE_COLLECTION_ID)}</span>
      </button>
      ${customHtml || `<div class="empty compact">还没有自定义合集。</div>`}
    </div>
    <div class="collection-hint">右键自定义合集可重命名或删除；收藏合集不可修改。</div>
  `;

  els.collectionMenu.querySelector("#addCollectionBtn").addEventListener("click", () => {
    state.collectionCreating = true;
    render();
  });
  els.collectionMenu.querySelector("#confirmCollectionBtn")?.addEventListener("click", () => {
    createCollection(els.collectionMenu.querySelector("#newCollectionInput")?.value);
  });
  els.collectionMenu.querySelector("#cancelCollectionBtn")?.addEventListener("click", () => {
    state.collectionCreating = false;
    render();
  });
  els.collectionMenu.querySelector("#newCollectionInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createCollection(event.target.value);
    if (event.key === "Escape") {
      state.collectionCreating = false;
      render();
    }
  });
  els.collectionMenu.querySelector("#newCollectionInput")?.focus();
  els.collectionMenu.querySelector("#clearCollectionFilterBtn").addEventListener("click", () => {
    state.activeCollectionId = null;
    render();
  });
  els.collectionMenu.querySelectorAll("[data-collection-id]").forEach((button) => {
    button.addEventListener("click", () => selectCollection(button.dataset.collectionId));
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const id = button.dataset.collectionId;
      if (id === FAVORITE_COLLECTION_ID) return;
      state.collectionActionId = state.collectionActionId === id ? null : id;
      render();
    });
  });
  els.collectionMenu.querySelectorAll("[data-rename-collection]").forEach((button) => {
    button.addEventListener("click", () => {
      state.collectionRenamingId = button.dataset.renameCollection;
      state.collectionActionId = null;
      render();
    });
  });
  els.collectionMenu.querySelectorAll("[data-confirm-rename]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = els.collectionMenu.querySelector(`[data-rename-input="${button.dataset.confirmRename}"]`);
      renameCollection(button.dataset.confirmRename, input?.value);
    });
  });
  els.collectionMenu.querySelectorAll("[data-cancel-rename]").forEach((button) => {
    button.addEventListener("click", () => {
      state.collectionRenamingId = null;
      render();
    });
  });
  els.collectionMenu.querySelectorAll("[data-rename-input]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") renameCollection(input.dataset.renameInput, input.value);
      if (event.key === "Escape") {
        state.collectionRenamingId = null;
        render();
      }
    });
  });
  els.collectionMenu.querySelector("[data-rename-input]")?.focus();
  els.collectionMenu.querySelectorAll("[data-delete-collection]").forEach((button) => {
    button.addEventListener("click", () => deleteCollection(button.dataset.deleteCollection));
  });
}

function renderKeywords() {
  const keywords = [...new Set(papers.flatMap((paper) => paperKeywords(paper)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const activeTerms = parseSearchTerms(state.keywordQuery);
  els.keywordList.innerHTML = "";
  keywords.forEach((keyword) => {
    const button = document.createElement("button");
    button.className = `chip ${activeTerms.includes(keyword.toLowerCase()) ? "active" : ""}`;
    button.textContent = keyword;
    button.addEventListener("click", () => {
      toggleKeywordTerm(keyword);
      render();
    });
    els.keywordList.appendChild(button);
  });
}

function toggleKeywordTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  const key = keyword.toLowerCase();
  const nextTerms = terms.includes(key)
    ? terms.filter((term) => term !== key)
    : [...terms, keyword];
  state.keywordQuery = nextTerms.join(" ");
  els.keywordSearchInput.value = state.keywordQuery;
}

function renderKeywordSuggestions() {
  if (!els.keywordSuggestions) return;
  const terms = parseSearchTerms(state.keywordQuery);
  const current = terms[terms.length - 1] || "";
  const active = new Set(terms);
  if (!current) {
    els.keywordSuggestions.innerHTML = "";
    return;
  }

  const candidates = uniqueTextItems(papers.flatMap((paper) => paperKeywords(paper)))
    .filter((keyword) => !active.has(keyword.toLowerCase()))
    .map((keyword) => ({ keyword, score: keywordSimilarity(current, keyword) }))
    .filter((item) => item.score > 0.24 || item.keyword.toLowerCase().includes(current))
    .sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword, "zh-CN"))
    .slice(0, 8);

  if (!candidates.length) {
    els.keywordSuggestions.innerHTML = "";
    return;
  }

  els.keywordSuggestions.innerHTML = `
    <div class="suggestion-label">相似关键词</div>
    <div class="suggestion-list">
      ${candidates.map((item) => `<button class="suggestion-chip" data-keyword-suggestion="${escapeHtml(item.keyword)}">${escapeHtml(item.keyword)}</button>`).join("")}
    </div>
  `;
  els.keywordSuggestions.querySelectorAll("[data-keyword-suggestion]").forEach((button) => {
    button.addEventListener("click", () => addKeywordSearchTerm(button.dataset.keywordSuggestion));
  });
}

function keywordSimilarity(query, keyword) {
  const a = String(query || "").toLowerCase();
  const b = String(keyword || "").toLowerCase();
  if (!a || !b) return 0;
  if (b.includes(a)) return 1;
  const chars = [...new Set([...a])].filter((char) => /\S/.test(char));
  if (!chars.length) return 0;
  const overlap = chars.filter((char) => b.includes(char)).length / chars.length;
  const lengthPenalty = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return overlap * 0.75 + lengthPenalty * 0.25;
}

function addKeywordSearchTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  if (!terms.includes(keyword.toLowerCase())) {
    state.keywordQuery = [...terms, keyword].join(" ");
  }
  state.keywordMode = "or";
  els.keywordSearchInput.value = state.keywordQuery;
  els.keywordSearchMode.value = "or";
  render();
}

function renderPaperList(items) {
  els.paperList.innerHTML = "";
  if (!items.length) {
    els.paperList.innerHTML = `<div class="empty">还没有匹配论文。导入 PDF 后可以用 DeepSeek 解析。</div>`;
    return;
  }

  if (!items.some((paper) => paper.id === state.selectedId)) {
    state.selectedId = items[0].id;
  }

  items.forEach((paper) => {
    const card = document.createElement("article");
    card.className = `paper-card ${paper.id === state.selectedId ? "active" : ""}`;
    card.innerHTML = `
      <div class="paper-card-head">
        <label class="paper-select" title="选中后可批量解析">
          <input type="checkbox" data-select-paper="${paper.id}" ${state.batchSelectedIds.has(paper.id) ? "checked" : ""} />
        </label>
        <div class="paper-title-wrap">
          <h3 class="paper-title">${escapeHtml(displayTitle(paper))}</h3>
        </div>
        <div class="paper-card-actions">
          <button class="open-paper-btn" data-open-paper="${paper.id}">打开文章</button>
          <button class="mini-toggle" data-toggle-title="${paper.id}">${paper.titleLang === "en" ? "EN" : "中"}</button>
        </div>
      </div>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.status].filter(Boolean).join(" | "))}</div>
      <div class="tags">${paperKeywords(paper).slice(0, 6).map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join("")}</div>
      <div class="paper-collection-row">
        <button class="paper-collection-btn" data-paper-collection="${paper.id}">加入合集</button>
        ${state.collectionPickerPaperId === paper.id ? renderPaperCollectionPicker(paper) : ""}
      </div>
    `;
    card.addEventListener("click", () => {
      state.selectedId = paper.id;
      render();
    });
    card.querySelector("[data-open-paper]").addEventListener("click", (event) => {
      event.stopPropagation();
      openPaperFile(paper.id);
    });
    const actions = card.querySelector(".paper-card-actions");
    const titleToggleButton = card.querySelector("[data-toggle-title]");
    const addressButton = document.createElement("button");
    addressButton.className = "open-paper-btn";
    addressButton.textContent = "打开地址";
    addressButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openPaperAddress(paper.id);
    });
    actions.insertBefore(addressButton, titleToggleButton);

    const appButton = document.createElement("button");
    appButton.className = "open-paper-btn";
    appButton.textContent = "选择软件";
    appButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openPaperWithApp(paper.id);
    });
    actions.insertBefore(appButton, titleToggleButton);
    appButton.remove();

    const favoriteButton = document.createElement("button");
    favoriteButton.className = `favorite-heart ${paper.favorite ? "active" : ""}`;
    favoriteButton.title = paper.favorite ? "取消收藏" : "收藏";
    favoriteButton.textContent = paper.favorite ? "♥" : "♡";
    favoriteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      togglePaperFavorite(paper.id);
    });
    actions.appendChild(favoriteButton);

    card.querySelector("[data-toggle-title]").addEventListener("click", (event) => {
      event.stopPropagation();
      togglePaperTitleLanguage(paper.id);
    });
    card.querySelector("[data-select-paper]").addEventListener("click", (event) => {
      event.stopPropagation();
    });
    card.querySelector("[data-select-paper]").addEventListener("change", (event) => {
      if (event.target.checked) {
        state.batchSelectedIds.add(paper.id);
      } else {
        state.batchSelectedIds.delete(paper.id);
      }
      render();
    });
    card.querySelector("[data-paper-collection]").addEventListener("click", (event) => {
      event.stopPropagation();
      state.collectionPickerPaperId = state.collectionPickerPaperId === paper.id ? null : paper.id;
      render();
    });
    card.querySelectorAll("[data-toggle-paper-collection]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePaperCollection(paper.id, button.dataset.togglePaperCollection);
      });
    });
    els.paperList.appendChild(card);
  });
}

function renderPaperCollectionPicker(paper) {
  const items = [
    { id: FAVORITE_COLLECTION_ID, name: "收藏", builtin: true },
    ...orderedCollections()
  ];
  return `
    <div class="paper-collection-picker">
      ${items.map((collection) => `
        <button class="collection-chip ${isPaperInCollection(paper, collection.id) ? "active" : ""}" data-toggle-paper-collection="${collection.id}">
          ${escapeHtml(collection.name)}
        </button>
      `).join("")}
      ${items.length === 1 ? `<span class="collection-empty-tip">还没有自定义合集，可在顶部“合集”中新建。</span>` : ""}
    </div>
  `;
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const analysis = paper.analysis || {};
  els.detailPanel.innerHTML = `
    <div class="detail-inner">
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" · "))}</div>
      <div class="detail-actions">
        <button class="secondary detail-action-btn" id="analyzeBtn">${paper.analysis ? "重新 AI 解析" : "AI 解析"}</button>
      </div>
      ${renderImagePreview(paper)}
      ${paper.analysisRepaired ? `<div class="analysis-repaired">这篇论文的 AI 返回格式曾自动修复，结果已保存。</div>` : ""}
      ${renderAnalysisError(paper)}
      ${renderKeywordEditor(paper)}
      ${abstractField(paper, analysis)}
      ${field("来源等级", venueRankDetail(paper))}
      ${field("动机：问题背景", analysis.motivation?.problem_background)}
      ${field("动机：研究空白", analysis.motivation?.research_gap)}
      ${field("动机：为什么重要", analysis.motivation?.why_it_matters)}
      ${field("贡献", analysis.contributions)}
      ${field("方法名称", analysis.method?.method_name)}
      ${field("方法核心", analysis.method?.core_idea)}
      ${field("方法模块", analysis.method?.modules)}
      ${field("方法流程", analysis.method?.pipeline)}
      ${field("数据集", analysis.datasets)}
      ${field("指标", analysis.metrics)}
      ${field("主要结果", analysis.main_results)}
      ${field("局限性", analysis.limitations)}
      ${field("关键词", analysis.keywords)}
      ${field("任务", analysis.task)}
      ${field("领域", analysis.domain)}
      ${field("模态", analysis.modality)}
      ${field("写作用途", analysis.writing_uses)}
      ${field("可信度备注", analysis.confidence_notes)}
      ${renderChatPanel(paper)}
    </div>
  `;
  document.querySelector("#analyzeBtn").addEventListener("click", () => analyzePaper(paper.id));
  document.querySelector("#abstractDetails")?.addEventListener("toggle", (event) => {
    paper.abstractOpen = event.target.open;
    saveLibrary();
  });
  document.querySelector("#abstractLangBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePaperAbstractLanguage(paper.id);
  });
  bindKeywordEditor(paper.id);
  document.querySelector("#sendChatBtn").addEventListener("click", () => sendChatMessage(paper.id));
  document.querySelector("#chatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage(paper.id);
    }
  });
  document.querySelector("#chatSearchInput")?.addEventListener("input", (event) => {
    state.chatQuery = event.target.value;
    render();
  });
  document.querySelector("#clearChatBtn")?.addEventListener("click", () => clearPaperChat(paper.id));
  document.querySelector("#attachChatImageBtn")?.addEventListener("click", () => attachChatImages());
  document.querySelectorAll("[data-remove-chat-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chatAttachments.splice(Number(button.dataset.removeChatAttachment), 1);
      render();
    });
  });
  document.querySelectorAll("[data-chat-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteChatMessage(paper.id, Number(button.dataset.chatDelete)));
  });
  if (!state.chatQuery) scrollChatToBottom();
}

function renderKeywordEditor(paper) {
  const chips = paperKeywords(paper).map((keyword, index) => `
    <button class="keyword-token" data-keyword-index="${index}" title="右键删除">${escapeHtml(keyword)}</button>
  `).join("");
  return `
    <section class="keyword-editor">
      <div class="field-label">关键词编辑</div>
      <div class="keyword-chip-editor">
        ${chips}
        <button class="keyword-add-btn" id="addKeywordBtn" title="添加关键词">+</button>
        <input class="keyword-add-input hidden" id="keywordAddInput" type="text" placeholder="新关键词" />
      </div>
      <div class="keyword-editor-hint">右键关键词可删除；点 + 后输入，按 Enter 保存。</div>
    </section>
  `;
}

function renderImagePreview(paper) {
  if (paper.kind !== "image" || !paper.imageDataUrl) return "";
  return `
    <section class="image-preview">
      <img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" />
    </section>
  `;
}

function renderAnalysisError(paper) {
  if (!paper.lastError) return "";
  const phaseMap = {
    config: "配置问题",
    "pdf-text": "PDF 文本问题",
    "deepseek-request": "DeepSeek 请求失败",
    "json-parse": "AI 返回格式问题",
    unknown: "未知阶段"
  };
  const rawPreview = String(paper.lastError.raw || "").trim();
  return `
    <section class="analysis-error">
      <div class="analysis-error-title">解析失败原因</div>
      <div>阶段：${escapeHtml(phaseMap[paper.lastError.phase] || paper.lastError.phase || "未知阶段")}</div>
      <div>原因：${escapeHtml(paper.lastError.message || "未知错误")}</div>
      ${paper.lastError.at ? `<div>时间：${escapeHtml(new Date(paper.lastError.at).toLocaleString())}</div>` : ""}
      ${rawPreview ? `
        <details class="analysis-raw">
          <summary>查看 AI 原始返回片段</summary>
          <pre>${escapeHtml(rawPreview.slice(0, 4000))}${rawPreview.length > 4000 ? "\n..." : ""}</pre>
        </details>
      ` : ""}
    </section>
  `;
}

function bindKeywordEditor(paperId) {
  document.querySelectorAll("[data-keyword-index]").forEach((button) => {
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      removePaperKeyword(paperId, Number(button.dataset.keywordIndex));
    });
  });

  const addButton = document.querySelector("#addKeywordBtn");
  const input = document.querySelector("#keywordAddInput");
  if (!addButton || !input) return;

  addButton.addEventListener("click", () => {
    input.classList.remove("hidden");
    input.focus();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addPaperKeyword(paperId, input.value);
    }
    if (event.key === "Escape") {
      input.value = "";
      input.classList.add("hidden");
    }
  });

  input.addEventListener("blur", () => {
    if (input.value.trim()) addPaperKeyword(paperId, input.value);
  });
}

function renderChatPanel(paper) {
  const messages = paper.chat || [];
  const content = messages.length
    ? messages.map((item) => `
        <div class="chat-message ${item.role === "assistant" ? "assistant" : "user"} ${item.error ? "error" : ""}">
          <div class="chat-role">${item.role === "assistant" ? "DeepSeek" : "我"}</div>
          <div class="chat-content">${escapeHtml(item.content)}</div>
        </div>
      `).join("")
    : `<div class="empty compact">可以直接问这篇论文的动机、贡献、方法、实验设置或写作启发。</div>`;

  return `
    <section class="chat-panel">
      <div class="chat-title">论文对话</div>
      <div class="chat-messages" id="chatMessages">${content}</div>
      <textarea id="chatInput" rows="4" placeholder="例如：这篇论文的核心动机是什么？和我的抑郁识别方向有什么关系？"></textarea>
      <button id="sendChatBtn" class="primary">发送问题</button>
    </section>
  `;
}

async function openPaperWithApp(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper?.filePath) {
    setStatus("没有可打开的本地文件路径。", true);
    return;
  }

  let result = await window.deepPaper.openFileWithApp(paper.filePath);
  if (result.missing) {
    const repaired = await repairMovedPaperPath(paper);
    if (!repaired) return;
    result = await window.deepPaper.openFileWithApp(paper.filePath);
  }
  if (!result.ok) {
    if (!result.canceled) setStatus(`选择软件打开失败：${result.error}`, true);
    return;
  }
  setStatus(`已用指定软件打开：${paper.fileName || paper.filePath}`);
}

async function exportLibraryFile() {
  const payload = {
    app: "DeepPaper",
    version: 2,
    exportedAt: new Date().toISOString(),
    papers,
    corpus,
    collections,
    libraryAi: window.deepPaperLibraryAi?.exportState?.() || null
  };
  const result = await window.deepPaper.exportLibrary(payload);
  if (!result.ok) {
    if (!result.canceled) setStatus(`导出库失败：${result.error}`, true);
    return;
  }
  setStatus(`文献库已导出：${result.filePath}，包含 ${papers.length} 篇论文、${corpus.length} 条语料、${collections.length} 个合集。`);
}

function renderChatPanel(paper) {
  const query = String(state.chatQuery || "").trim().toLowerCase();
  const messages = (paper.chat || []).map((item, index) => ({ ...item, index }));
  const visibleMessages = query
    ? messages.filter((item) => String(item.content || "").toLowerCase().includes(query))
    : messages;
  const content = visibleMessages.length
    ? visibleMessages.map((item) => `
        <div class="chat-message ${item.role === "assistant" ? "assistant" : "user"} ${item.error ? "error" : ""}">
          <div class="chat-message-head">
            <div class="chat-role">${item.role === "assistant" ? "DeepSeek" : "我"}</div>
            <button class="chat-delete" data-chat-delete="${item.index}" title="删除这条对话">删除</button>
          </div>
          <div class="chat-content">${escapeHtml(item.content)}</div>
        </div>
      `).join("")
    : `<div class="empty compact">${query ? "没有匹配的对话内容。" : "可以直接问这篇论文的动机、贡献、方法、实验设置或写作启发。"}</div>`;

  return `
    <section class="chat-panel">
      <div class="chat-toolbar">
        <div class="chat-title">论文对话</div>
        <input id="chatSearchInput" class="chat-search" type="search" value="${escapeHtml(state.chatQuery)}" placeholder="搜索对话" />
        <button id="clearChatBtn" class="secondary small-btn" type="button">清空</button>
      </div>
      <div class="chat-messages" id="chatMessages">${content}</div>
      <textarea id="chatInput" rows="4" placeholder="输入问题，Enter 发送，Shift + Enter 换行"></textarea>
      <button id="sendChatBtn" class="primary">发送问题</button>
    </section>
  `;
}

function handleDetailSelection() {
  setTimeout(() => {
    const selection = window.getSelection();
    const text = String(selection?.toString() || "").trim();
    if (!text || text.length < 2 || !els.detailPanel.contains(selection.anchorNode)) {
      hideSelectionButton();
      return;
    }
    const paper = papers.find((item) => item.id === state.selectedId);
    if (!paper) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const sourceNode = selection.anchorNode?.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection.anchorNode;
    const fieldNode = sourceNode?.closest?.(".field");
    const sourceLabel = fieldNode?.dataset?.sourceLabel || "详情摘录";
    state.pendingSelection = {
      text,
      paperId: paper.id,
      sourceLabel,
      type: inferCorpusType(sourceLabel),
      tags: paperKeywords(paper)
    };
    els.selectionAddBtn.style.left = `${Math.min(window.innerWidth - 130, rect.right + 8)}px`;
    els.selectionAddBtn.style.top = `${Math.max(10, rect.top - 4)}px`;
    els.selectionAddBtn.classList.remove("hidden");
  }, 0);
}

function hideSelectionButton() {
  state.pendingSelection = null;
  els.selectionAddBtn.classList.add("hidden");
}

function addPendingSelectionToCorpus() {
  const pending = state.pendingSelection;
  if (!pending) return;
  const paper = papers.find((item) => item.id === pending.paperId);
  corpus.unshift({
    id: crypto.randomUUID(),
    paperId: pending.paperId,
    paperTitleZh: paper?.titleZh || paper?.analysis?.title_zh || paper?.title || "",
    paperTitleEn: paper?.titleEn || paper?.analysis?.title_en || "",
    paperVenue: paper?.venue || "",
    paperYear: paper?.year || "",
    sourceLabel: pending.sourceLabel,
    type: pending.type,
    text: pending.text,
    tags: [...(pending.tags || [])],
    note: "",
    createdAt: new Date().toISOString()
  });
  saveCorpus();
  hideSelectionButton();
  renderDetail(paper);
  setStatus("已加入语料库。");
  renderCorpus();
}

function inferCorpusType(label) {
  if (/gap|空白/i.test(label)) return "Gap";
  if (/动机|背景|重要/.test(label)) return "动机";
  if (/方法|模块|流程/.test(label)) return "方法";
  if (/贡献/.test(label)) return "贡献";
  if (/结果|指标/.test(label)) return "结果";
  if (/写作/.test(label)) return "写作用句";
  return "其他";
}

function renderCorpus() {
  els.corpusPanel.classList.toggle("hidden", !state.corpusOpen);
  if (!state.corpusOpen) return;
  const items = getFilteredCorpus();
  els.corpusTitle.textContent = `${items.length} / ${corpus.length} 条语料`;
  if (!items.length) {
    els.corpusList.innerHTML = `<div class="empty compact">还没有匹配语料。可以在右侧解析内容中选中文字，点“加入语料库”。</div>`;
    return;
  }
  els.corpusList.innerHTML = items.map((item) => corpusCard(item)).join("");
  bindCorpusCards();
}

function getFilteredCorpus() {
  const terms = parseSearchTerms(state.corpusQuery);
  return corpus.filter((item) => {
    if (state.corpusType && item.type !== state.corpusType) return false;
    if (!terms.length) return true;
    const text = [
      item.text,
      item.paperTitleZh,
      item.paperTitleEn,
      item.paperVenue,
      item.sourceLabel,
      item.type,
      item.note,
      ...(item.tags || [])
    ].filter(Boolean).join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function corpusCard(item) {
  const title = item.paperTitleZh || item.paperTitleEn || "未知论文";
  return `
    <article class="corpus-card" data-corpus-id="${item.id}">
      <div class="corpus-card-head">
        <select class="corpus-type" data-corpus-type="${item.id}">
          ${["动机", "Gap", "方法", "贡献", "结果", "写作用句", "其他"].map((type) => `<option value="${type}" ${item.type === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
        <button class="secondary danger small-btn" data-corpus-delete="${item.id}">删除</button>
      </div>
      <textarea class="corpus-text" data-corpus-text="${item.id}">${escapeHtml(item.text)}</textarea>
      <div class="corpus-source">${escapeHtml(title)}${item.sourceLabel ? ` · ${escapeHtml(item.sourceLabel)}` : ""}</div>
      <input class="corpus-tags-input" data-corpus-tags="${item.id}" value="${escapeHtml((item.tags || []).join("，"))}" placeholder="标签，用逗号分隔" />
      <input class="corpus-note-input" data-corpus-note="${item.id}" value="${escapeHtml(item.note || "")}" placeholder="备注，可选" />
    </article>
  `;
}

function bindCorpusCards() {
  document.querySelectorAll("[data-corpus-type]").forEach((input) => {
    input.addEventListener("change", () => updateCorpusItem(input.dataset.corpusType, { type: input.value }));
  });
  document.querySelectorAll("[data-corpus-text]").forEach((input) => {
    input.addEventListener("change", () => updateCorpusItem(input.dataset.corpusText, { text: input.value }));
  });
  document.querySelectorAll("[data-corpus-tags]").forEach((input) => {
    input.addEventListener("change", () => updateCorpusItem(input.dataset.corpusTags, { tags: parseKeywords(input.value) }));
  });
  document.querySelectorAll("[data-corpus-note]").forEach((input) => {
    input.addEventListener("change", () => updateCorpusItem(input.dataset.corpusNote, { note: input.value }));
  });
  document.querySelectorAll("[data-corpus-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteCorpusItem(button.dataset.corpusDelete));
  });
  document.querySelectorAll("[data-corpus-jump]").forEach((button) => {
    button.addEventListener("click", () => jumpToCorpusSource(button.dataset.corpusJump));
  });
}

function updateCorpusItem(id, patch) {
  const item = corpus.find((entry) => entry.id === id);
  if (!item) return;
  Object.assign(item, patch);
  saveCorpus();
  setStatus("语料库已更新。");
}

function deleteCorpusItem(id) {
  corpus = corpus.filter((item) => item.id !== id);
  saveCorpus();
  renderCorpus();
  setStatus("已删除语料。");
}

function jumpToCorpusSource(id) {
  const item = corpus.find((entry) => entry.id === id);
  if (!item) return;
  if (papers.some((paper) => paper.id === item.paperId)) {
    state.selectedId = item.paperId;
    render();
    setStatus("已跳转到来源论文。");
  } else {
    setStatus("来源论文不在当前文献库中。", true);
  }
}

function field(label, value, open = false) {
  if (!hasValue(value)) return "";
  const content = Array.isArray(value)
    ? value.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join("")
    : highlightCorpusText(value, state.selectedId);
  return `
    <details class="field" data-source-label="${escapeHtml(label)}" ${open ? "open" : ""}>
      <summary class="field-label">${label}</summary>
      <div class="field-value ${Array.isArray(value) ? "tags" : ""}">${content}</div>
    </details>
  `;
}

function abstractField(paper, analysis) {
  const value = displayAbstract(paper, analysis);
  if (!hasValue(value)) return "";
  const label = paper.abstractLang === "en" ? "摘要（英文原文）" : "摘要（中文直译）";
  return `
    <details class="field" id="abstractDetails" data-source-label="${escapeHtml(label)}" ${paper.abstractOpen ? "open" : ""}>
      <summary class="field-label field-label-row">
        <span>${label}</span>
        <button class="mini-toggle" id="abstractLangBtn" type="button">${paper.abstractLang === "en" ? "EN" : "中"}</button>
      </summary>
      <div class="field-value">${highlightCorpusText(value, paper.id)}</div>
    </details>
  `;
}

function highlightCorpusText(value, paperId) {
  let html = escapeHtml(value);
  const snippets = corpus
    .filter((item) => item.paperId === paperId && String(item.text || "").trim().length >= 4)
    .map((item) => String(item.text || "").trim())
    .sort((a, b) => b.length - a.length);
  snippets.forEach((snippet) => {
    const escaped = escapeHtml(snippet);
    if (!escaped || !html.includes(escaped)) return;
    html = html.split(escaped).join(`<mark class="corpus-highlight">${escaped}</mark>`);
  });
  return html;
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(String(value || "").trim());
}

function displayAbstract(paper, analysis = {}) {
  if (paper.abstractLang === "en") {
    return analysis.abstract_en || analysis.abstract || "";
  }
  return analysis.abstract_zh || analysis.abstract || "";
}

function displayTitle(paper) {
  const analysis = paper.analysis || {};
  if (paper.titleLang === "en") {
    return paper.titleEn || analysis.title_en || paper.title || analysis.title || "未命名论文";
  }
  return paper.titleZh || analysis.title_zh || paper.title || analysis.title || paper.titleEn || analysis.title_en || "未命名论文";
}

function displayAlternateTitle(paper) {
  const analysis = paper.analysis || {};
  if (paper.titleLang === "en") {
    return paper.titleZh || analysis.title_zh || "";
  }
  return paper.titleEn || analysis.title_en || "";
}

function venueRankLabel(paper) {
  const rank = paper.venueRank || paper.analysis?.venue_rank;
  if (!rank) return "";
  if (typeof rank === "string") return rank;
  return rank.label || "";
}

function venueRankDetail(paper) {
  const rank = paper.venueRank || paper.analysis?.venue_rank;
  if (!rank) return "";
  if (typeof rank === "string") return rank;
  const typeMap = {
    journal: "期刊",
    conference: "会议",
    unknown: "未知"
  };
  return [
    rank.label,
    rank.type ? `类型：${typeMap[rank.type] || rank.type}` : "",
    rank.confidence ? `置信度：${rank.confidence}` : "",
    rank.source ? `来源：${rank.source}` : ""
  ].filter(Boolean).join("\n");
}

function cleanTitleFromFile(fileName) {
  return String(fileName || "未命名论文").replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
}

async function openPaperFile(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper?.filePath) {
    setStatus("没有可打开的本地文件路径。", true);
    return;
  }

  let result = await window.deepPaper.openExistingFile(paper.filePath);
  if (result.missing) {
    const repaired = await repairMovedPaperPath(paper);
    if (!repaired) return;
    result = await window.deepPaper.openExistingFile(paper.filePath);
  }
  if (!result.ok) {
    setStatus(`打开文章失败：${result.error}`, true);
    return;
  }
  setStatus(`已打开：${paper.fileName || paper.filePath}`);
}

async function openPaperAddress(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return;
  if (!paper.filePath) {
    setStatus("这篇论文没有可定位的本地文件路径。", true);
    return;
  }

  let result = await window.deepPaper.openExistingFileLocation(paper.filePath);
  if (result.missing) {
    const repaired = await repairMovedPaperPath(paper);
    if (!repaired) return;
    result = await window.deepPaper.openExistingFileLocation(paper.filePath);
  }
  if (!result.ok) {
    setStatus(`打开本地地址失败：${result.error}`, true);
    return;
  }
  setStatus(`已定位本地文件：${paper.fileName || paper.filePath}`);
}

async function repairMovedPaperPath(paper) {
  const name = paper.fileName || "这个文件";
  const shouldLocate = confirm(`原来的文件路径已经失效：\n${paper.filePath || ""}\n\n如果文件只是换了文件夹、文件名没变，可以现在重新选择“${name}”，软件会自动更新这篇论文的本地地址。`);
  if (!shouldLocate) {
    setStatus("原文件路径已失效，尚未重新定位。", true);
    return false;
  }

  const result = await window.deepPaper.locateMovedFile({
    fileName: paper.fileName || "",
    oldPath: paper.filePath || "",
    kind: paper.kind || "pdf"
  });
  if (!result.ok) {
    if (!result.canceled) setStatus(`重新定位失败：${result.error}`, true);
    return false;
  }

  if (!result.sameName) {
    const ok = confirm(`你选择的文件名是：\n${result.fileName}\n\n原记录文件名是：\n${paper.fileName || "未知"}\n\n文件名不一致，仍然要绑定到这篇论文吗？`);
    if (!ok) return false;
  }

  paper.filePath = result.filePath;
  paper.fileName = result.fileName || paper.fileName;
  saveLibrary();
  setStatus(`已更新本地文件地址：${paper.fileName || paper.filePath}`);
  render();
  return true;
}

function providerDisplayName(provider) {
  return provider === "doubao" ? "豆包/火山方舟" : "DeepSeek";
}

async function attachChatImages() {
  const filePaths = await window.deepPaper.chooseImage();
  if (!filePaths?.length) return;
  for (const filePath of filePaths.filter(isImagePath)) {
    const result = await window.deepPaper.extractImage(filePath);
    if (!result.ok) {
      setStatus(`图片上传失败：${result.error}`, true);
      continue;
    }
    state.chatAttachments.push({
      fileName: result.fileName,
      imageDataUrl: result.imageDataUrl,
      mimeType: result.mimeType
    });
  }
  setStatus(`已添加 ${state.chatAttachments.length} 张待发送图片。`);
  render();
}

async function sendChatMessage(id) {
  const paper = papers.find((item) => item.id === id);
  const input = document.querySelector("#chatInput");
  if (!paper || !input) return;

  const attachments = [...(state.chatAttachments || [])];
  const message = input.value.trim();
  if (!message && !attachments.length) return;
  const config = currentConfig();
  saveConfig(config);

  if (attachments.length && config.provider !== "doubao") {
    setStatus("图片对话需要把 AI 服务商切换为豆包/火山方舟，并使用支持视觉的接入点。", true);
    return;
  }

  paper.chat = paper.chat || [];
  paper.chat.push({
    role: "user",
    content: message || "请分析我上传的图片。",
    attachmentNames: attachments.map((item) => item.fileName).filter(Boolean),
    at: new Date().toISOString()
  });
  input.value = "";
  state.chatAttachments = [];
  saveLibrary();
  render();
  scrollChatToBottom();
  setStatus(`${providerDisplayName(config.provider)} 正在回答论文问题...`);

  const result = await window.deepPaper.chatWithDeepSeek({
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    paper: compactPaperForChat(paper),
    history: paper.chat.slice(0, -1),
    message: message || "请分析我上传的图片。",
    attachments
  });

  paper.chat = paper.chat || [];
  if (!result.ok) {
    paper.chat.push({
      role: "assistant",
      content: `请求失败：${result.error}`,
      at: new Date().toISOString(),
      error: true
    });
    setStatus(result.error, true);
  } else {
    paper.chat.push({
      role: "assistant",
      content: result.message,
      at: new Date().toISOString()
    });
    setStatus("论文对话已更新。");
  }
  saveLibrary();
  render();
  scrollChatToBottom();
}

function compactPaperForChat(paper) {
  return {
    kind: paper.kind || "pdf",
    fileName: paper.fileName,
    title: paper.title,
    year: paper.year,
    venue: paper.venue,
    authors: paper.authors,
    pageCount: paper.pageCount,
    analysis: paper.analysis,
    text: paper.text,
    imageDataUrl: paper.imageDataUrl || ""
  };
}

function renderChatPanel(paper) {
  const query = String(state.chatQuery || "").trim().toLowerCase();
  const messages = (paper.chat || []).map((item, index) => ({ ...item, index }));
  const visibleMessages = query
    ? messages.filter((item) => String(item.content || "").toLowerCase().includes(query))
    : messages;
  const assistantName = providerDisplayName(currentConfig().provider);
  const attachmentPreview = (state.chatAttachments || []).length
    ? `<div class="chat-attachments">
        ${state.chatAttachments.map((item, index) => `
          <div class="chat-attachment">
            <span>${escapeHtml(item.fileName || `图片 ${index + 1}`)}</span>
            <button type="button" data-remove-chat-attachment="${index}" title="移除图片">×</button>
          </div>
        `).join("")}
      </div>`
    : "";
  const content = visibleMessages.length
    ? visibleMessages.map((item) => {
        const names = Array.isArray(item.attachmentNames) && item.attachmentNames.length
          ? `<div class="chat-attachment-names">图片：${escapeHtml(item.attachmentNames.join("，"))}</div>`
          : "";
        return `
          <div class="chat-message ${item.role === "assistant" ? "assistant" : "user"} ${item.error ? "error" : ""}">
            <div class="chat-message-head">
              <div class="chat-role">${item.role === "assistant" ? assistantName : "我"}</div>
              <button class="chat-delete" data-chat-delete="${item.index}" title="删除这条对话">删除</button>
            </div>
            ${names}
            <div class="chat-content">${escapeHtml(item.content)}</div>
          </div>
        `;
      }).join("")
    : `<div class="empty compact">${query ? "没有匹配的对话内容。" : "可以直接问这篇论文的动机、贡献、方法、实验设置，也可以上传图片让豆包一起分析。"}</div>`;

  return `
    <section class="chat-panel">
      <div class="chat-toolbar">
        <div class="chat-title">论文对话</div>
        <input id="chatSearchInput" class="chat-search" type="search" value="${escapeHtml(state.chatQuery)}" placeholder="搜索对话" />
        <button id="clearChatBtn" class="secondary small-btn" type="button">清空</button>
      </div>
      <div class="chat-messages" id="chatMessages">${content}</div>
      ${attachmentPreview}
      <div class="chat-input-actions">
        <button id="attachChatImageBtn" class="secondary small-btn" type="button">上传图片</button>
        <span class="chat-provider-hint">当前服务商：${escapeHtml(assistantName)}</span>
      </div>
      <textarea id="chatInput" rows="4" placeholder="输入问题，Enter 发送，Shift + Enter 换行"></textarea>
      <button id="sendChatBtn" class="primary">发送问题</button>
    </section>
  `;
}

function guessTitleFromText(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8 && line.length <= 180);
  const ignored = /^(abstract|keywords|introduction|references|doi\b|arxiv\b|ieee\b|springer\b|elsevier\b)/i;
  return lines.find((line) => !ignored.test(line)) || "";
}

function setStatus(message, isError = false) {
  clearTimeout(statusTimer);
  els.statusBar.textContent = message;
  els.statusBar.className = `status ${isError ? "error" : "info"}`;
  statusTimer = setTimeout(resetStatus, isError ? 4200 : 6500);
}

function resetStatus() {
  const index = Math.floor(Math.random() * DEFAULT_STATUS_MESSAGES.length);
  els.statusBar.textContent = DEFAULT_STATUS_MESSAGES[index];
  els.statusBar.className = "status";
}

function exportLibrary() {
  const blob = new Blob([JSON.stringify(papers, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `deeppaper-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function formatBalance(data) {
  if (!data || typeof data !== "object") return "已查询余额，但返回格式无法识别。";
  const available = typeof data.is_available === "boolean" ? (data.is_available ? "可用" : "不可用") : "未知";
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  if (!infos.length) return `账户状态：${available}`;
  const lines = infos.map((item) => {
    const currency = item.currency || "CNY";
    const total = item.total_balance ?? item.topped_up_balance ?? item.granted_balance ?? "未知";
    const granted = item.granted_balance;
    const topped = item.topped_up_balance;
    const parts = [`${currency} ${total}`];
    if (granted != null) parts.push(`赠金 ${granted}`);
    if (topped != null) parts.push(`充值 ${topped}`);
    return parts.join("，");
  });
  return `账户状态：${available}\n余额：${lines.join("\n")}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "source" ? "" : `
    <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
    <h2>${escapeHtml(displayTitle(paper))}</h2>
    <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
  `;

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-detail-inner" : ""}">
      ${header}
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
}

// Final search and source-reading annotation overrides.
function parseSearchTerms(value) {
  return String(value || "")
    .split(/[，,]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function joinSearchTerms(terms) {
  return uniqueTextItems(terms).join("，");
}

function toggleKeywordTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  const key = String(keyword || "").trim().toLowerCase();
  const nextTerms = terms.includes(key)
    ? terms.filter((term) => term !== key)
    : [...terms, keyword];
  state.keywordQuery = joinSearchTerms(nextTerms);
  els.keywordSearchInput.value = state.keywordQuery;
}

function addKeywordSearchTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  const key = String(keyword || "").trim().toLowerCase();
  if (!terms.includes(key)) {
    state.keywordQuery = joinSearchTerms([...terms, keyword]);
  }
  state.keywordMode = "or";
  els.keywordSearchInput.value = state.keywordQuery;
  els.keywordSearchMode.value = "or";
  render();
}

function normalizeSearchPlaceholders() {
  if (els.fullTextSearchInput) els.fullTextSearchInput.placeholder = "如：不平衡，长尾";
  if (els.keywordSearchInput) els.keywordSearchInput.placeholder = "如：对比学习，面部动作单元";
  if (els.corpusTypeFilter && ![...els.corpusTypeFilter.options].some((option) => option.value === "高亮")) {
    els.corpusTypeFilter.insertAdjacentHTML("beforeend", `
      <option value="高亮">高亮</option>
      <option value="批注">批注</option>
    `);
  }
}

function sourceReaderText(paper) {
  const text = String(paper?.text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "";
  return text.length > 140000
    ? `${text.slice(0, 90000)}\n\n[中间过长，已折叠部分文本]\n\n${text.slice(-40000)}`
    : text;
}

function renderSourceReader(paper) {
  const text = sourceReaderText(paper);
  if (!text) {
    return `<section class="source-reader empty compact">这篇论文没有可用的提取文本，暂时不能在软件内选中摘录。</section>`;
  }
  return `
    <details class="source-reader" open>
      <summary>提取文本 / 批注</summary>
      <div class="source-reader-tools">
        <button class="secondary small-btn" data-source-corpus-action="corpus">加入语料库</button>
        <button class="secondary small-btn" data-source-corpus-action="highlight">高亮</button>
        <button class="secondary small-btn" data-source-corpus-action="note">批注</button>
        <span>在下方文本中选中句子后使用。PDF 预览区内部选区暂时无法直接读取。</span>
      </div>
      <div class="source-text-content" data-source-label="原文摘录">${highlightCorpusText(text, paper.id)}</div>
    </details>
  `;
}

function renderSourcePreview(paper) {
  if (paper.kind === "image") {
    return paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>${renderSourceReader(paper)}`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`;
  }

  if (!paper.previewUrl) {
    return `
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
      ${renderSourceReader(paper)}
    `;
  }

  return `
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">如果内置 PDF 预览为空白或功能不够，可以点论文词条里的“打开地址”用外部阅读器打开。批注和高亮请在下方“提取文本 / 批注”中选中文字操作。</div>
    </section>
    ${renderSourceReader(paper)}
  `;
}

function selectedSourceTextForCorpus(paper, fallbackType = "其他", fallbackLabel = "原文摘录") {
  const selection = window.getSelection();
  const selected = String(selection?.toString() || "").trim();
  const inDetail = selected && selection.anchorNode && els.detailPanel.contains(selection.anchorNode);
  if (inDetail) {
    const sourceNode = selection.anchorNode.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection.anchorNode;
    const labeledNode = sourceNode?.closest?.("[data-source-label]");
    return {
      text: selected,
      paperId: paper.id,
      sourceLabel: labeledNode?.dataset?.sourceLabel || fallbackLabel,
      type: fallbackType,
      tags: paperKeywords(paper)
    };
  }
  if (state.pendingSelection?.paperId === paper.id) {
    return {
      ...state.pendingSelection,
      sourceLabel: state.pendingSelection.sourceLabel || fallbackLabel,
      type: fallbackType || state.pendingSelection.type || "其他"
    };
  }
  return null;
}

function addCorpusItemFromSource(paper, action) {
  const typeMap = {
    corpus: "其他",
    highlight: "高亮",
    note: "批注"
  };
  const pending = selectedSourceTextForCorpus(paper, typeMap[action] || "其他");
  if (!pending?.text) {
    setStatus("请先在下方提取文本中选中一段内容。", true);
    return;
  }
  const note = action === "note" ? prompt("给这段摘录写批注：", "") : "";
  if (action === "note" && note === null) return;
  corpus.unshift({
    id: crypto.randomUUID(),
    paperId: pending.paperId,
    paperTitleZh: paper?.titleZh || paper?.analysis?.title_zh || paper?.title || "",
    paperTitleEn: paper?.titleEn || paper?.analysis?.title_en || "",
    paperVenue: paper?.venue || "",
    paperYear: paper?.year || "",
    sourceLabel: pending.sourceLabel,
    type: pending.type,
    text: pending.text,
    tags: [...(pending.tags || [])],
    note: note || "",
    createdAt: new Date().toISOString()
  });
  saveCorpus();
  hideSelectionButton();
  renderDetail(paper);
  renderCorpus();
  setStatus(action === "highlight" ? "已高亮并加入语料库。" : action === "note" ? "已保存批注。" : "已加入语料库。");
}

function bindSourceReader(paper) {
  document.querySelectorAll("[data-source-corpus-action]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => addCorpusItemFromSource(paper, button.dataset.sourceCorpusAction));
  });
}

function corpusTypeOptions(selected) {
  return ["动机", "Gap", "方法", "贡献", "结果", "写作用句", "高亮", "批注", "其他"]
    .map((type) => `<option value="${type}" ${selected === type ? "selected" : ""}>${type}</option>`)
    .join("");
}

function corpusCard(item) {
  const title = item.paperTitleZh || item.paperTitleEn || "未知论文";
  return `
    <article class="corpus-card" data-corpus-id="${item.id}">
      <div class="corpus-card-head">
        <select class="corpus-type" data-corpus-type="${item.id}">
          ${corpusTypeOptions(item.type)}
        </select>
        <button class="secondary danger small-btn" data-corpus-delete="${item.id}">删除</button>
      </div>
      <textarea class="corpus-text" data-corpus-text="${item.id}">${escapeHtml(item.text)}</textarea>
      <div class="corpus-source">${escapeHtml(title)}${item.sourceLabel ? ` · ${escapeHtml(item.sourceLabel)}` : ""}</div>
      <input class="corpus-tags-input" data-corpus-tags="${item.id}" value="${escapeHtml((item.tags || []).join("，"))}" placeholder="标签，用逗号分隔" />
      <input class="corpus-note-input" data-corpus-note="${item.id}" value="${escapeHtml(item.note || "")}" placeholder="批注或备注，可选" />
    </article>
  `;
}

function renderDetail(paper) {
  normalizeSearchPlaceholders();
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "analysis"
    ? `
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
    `
    : "";

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-only" : ""}">
      ${header}
      ${renderDetailTabs(tab)}
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
  if (tab === "source") bindSourceReader(paper);
}

normalizeSearchPlaceholders();

function renderSourcePreview(paper) {
  if (paper.kind === "image") {
    return paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`;
  }

  if (!paper.previewUrl) {
    return `
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
    `;
  }

  return `
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">如果内置 PDF 预览为空白或功能不够，可以点论文词条里的“打开地址”用外部阅读器打开。</div>
    </section>
  `;
}

// Absolute final source-reader override. Must remain at EOF because this file has older duplicate render functions.
function parseSearchTerms(value) {
  return String(value || "")
    .split(/[，,]+/)
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
}

function joinSearchTerms(terms) {
  return uniqueTextItems(terms).join("，");
}

function toggleKeywordTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  const key = String(keyword || "").trim().toLowerCase();
  const nextTerms = terms.includes(key)
    ? terms.filter((term) => term !== key)
    : [...terms, keyword];
  state.keywordQuery = joinSearchTerms(nextTerms);
  els.keywordSearchInput.value = state.keywordQuery;
}

function addKeywordSearchTerm(keyword) {
  const terms = parseSearchTerms(state.keywordQuery);
  const key = String(keyword || "").trim().toLowerCase();
  if (!terms.includes(key)) state.keywordQuery = joinSearchTerms([...terms, keyword]);
  state.keywordMode = "or";
  els.keywordSearchInput.value = state.keywordQuery;
  els.keywordSearchMode.value = "or";
  render();
}

function normalizeSearchPlaceholders() {
  if (els.fullTextSearchInput) els.fullTextSearchInput.placeholder = "如：不平衡，长尾";
  if (els.keywordSearchInput) els.keywordSearchInput.placeholder = "如：对比学习，面部动作单元";
  if (els.corpusTypeFilter && ![...els.corpusTypeFilter.options].some((option) => option.value === "高亮")) {
    els.corpusTypeFilter.insertAdjacentHTML("beforeend", `
      <option value="高亮">高亮</option>
      <option value="批注">批注</option>
    `);
  }
}

function sourceReaderText(paper) {
  const text = String(paper?.text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "";
  return text.length > 140000
    ? `${text.slice(0, 90000)}\n\n[中间过长，已折叠部分文本]\n\n${text.slice(-40000)}`
    : text;
}

function selectedSourceTextForCorpus(paper, fallbackType = "其他", fallbackLabel = "原文摘录") {
  const selection = window.getSelection();
  const selected = String(selection?.toString() || "").trim();
  const inDetail = selected && selection.anchorNode && els.detailPanel.contains(selection.anchorNode);
  if (inDetail) {
    const sourceNode = selection.anchorNode.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection.anchorNode;
    const labeledNode = sourceNode?.closest?.("[data-source-label]");
    return {
      text: selected,
      paperId: paper.id,
      sourceLabel: labeledNode?.dataset?.sourceLabel || fallbackLabel,
      type: fallbackType,
      tags: paperKeywords(paper)
    };
  }
  if (state.pendingSelection?.paperId === paper.id) {
    return {
      ...state.pendingSelection,
      sourceLabel: state.pendingSelection.sourceLabel || fallbackLabel,
      type: fallbackType || state.pendingSelection.type || "其他"
    };
  }
  return null;
}

function addCorpusItemFromSource(paper, action) {
  const typeMap = { corpus: "其他", highlight: "高亮", note: "批注" };
  const pending = selectedSourceTextForCorpus(paper, typeMap[action] || "其他");
  if (!pending?.text) {
    setStatus("请先在“提取文本”里选中一段文字，再点加入语料库/高亮/批注。", true);
    return;
  }
  const note = action === "note" ? prompt("给这段摘录写批注：", "") : "";
  if (action === "note" && note === null) return;
  corpus.unshift({
    id: crypto.randomUUID(),
    paperId: pending.paperId,
    paperTitleZh: paper?.titleZh || paper?.analysis?.title_zh || paper?.title || "",
    paperTitleEn: paper?.titleEn || paper?.analysis?.title_en || "",
    paperVenue: paper?.venue || "",
    paperYear: paper?.year || "",
    sourceLabel: pending.sourceLabel,
    type: pending.type,
    text: pending.text,
    tags: [...(pending.tags || [])],
    note: note || "",
    createdAt: new Date().toISOString()
  });
  saveCorpus();
  hideSelectionButton();
  renderDetail(paper);
  renderCorpus();
  setStatus(action === "highlight" ? "已高亮并加入语料库。" : action === "note" ? "已保存批注。" : "已加入语料库。");
}

function renderSourceReader(paper) {
  const text = sourceReaderText(paper);
  const textBlock = text
    ? `<div class="source-text-content" data-source-label="原文摘录">${highlightCorpusText(text, paper.id)}</div>`
    : `<div class="empty compact">这篇论文没有可用的提取文本，暂时不能在软件内选中摘录。</div>`;
  return `
    <section class="source-reader source-reader-top">
      <div class="source-reader-head">
        <strong>阅读摘录</strong>
        <span>先在下方提取文本中选中文字，再点操作按钮。</span>
      </div>
      <div class="source-reader-tools">
        <button class="secondary small-btn" data-source-corpus-action="corpus">加入语料库</button>
        <button class="secondary small-btn" data-source-corpus-action="highlight">高亮</button>
        <button class="secondary small-btn" data-source-corpus-action="note">写批注</button>
      </div>
      <details class="source-text-details">
        <summary>展开提取文本</summary>
        ${textBlock}
      </details>
    </section>
  `;
}

function bindSourceReader(paper) {
  document.querySelectorAll("[data-source-corpus-action]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => addCorpusItemFromSource(paper, button.dataset.sourceCorpusAction));
  });
}

function corpusTypeOptions(selected) {
  return ["动机", "Gap", "方法", "贡献", "结果", "写作用句", "高亮", "批注", "其他"]
    .map((type) => `<option value="${type}" ${selected === type ? "selected" : ""}>${type}</option>`)
    .join("");
}

function corpusCard(item) {
  const title = item.paperTitleZh || item.paperTitleEn || "未知论文";
  return `
    <article class="corpus-card" data-corpus-id="${item.id}">
      <div class="corpus-card-head">
        <select class="corpus-type" data-corpus-type="${item.id}">
          ${corpusTypeOptions(item.type)}
        </select>
        <button class="secondary danger small-btn" data-corpus-delete="${item.id}">删除</button>
      </div>
      <textarea class="corpus-text" data-corpus-text="${item.id}">${escapeHtml(item.text)}</textarea>
      <div class="corpus-source">${escapeHtml(title)}${item.sourceLabel ? ` · ${escapeHtml(item.sourceLabel)}` : ""}</div>
      <input class="corpus-tags-input" data-corpus-tags="${item.id}" value="${escapeHtml((item.tags || []).join("，"))}" placeholder="标签，用逗号分隔" />
      <input class="corpus-note-input" data-corpus-note="${item.id}" value="${escapeHtml(item.note || "")}" placeholder="批注或备注，可选" />
    </article>
  `;
}

function renderSourcePreview(paper) {
  const reader = renderSourceReader(paper);
  if (paper.kind === "image") {
    return `${reader}${paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`}`;
  }

  if (!paper.previewUrl) {
    return `
      ${reader}
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
    `;
  }

  return `
    ${reader}
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">PDF 预览区用于看版面；加入语料库、写批注和高亮请在上方“阅读摘录”的提取文本中选中文字。</div>
    </section>
  `;
}

function renderDetail(paper) {
  normalizeSearchPlaceholders();
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "analysis"
    ? `
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
    `
    : "";

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-only" : ""}">
      ${header}
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
  if (tab === "source") bindSourceReader(paper);
}

normalizeSearchPlaceholders();

// Final display overrides for source view and Chinese-first keywords.
function hasChineseText(value) {
  return /[\u4e00-\u9fff]/.test(String(value || ""));
}

function isEnglishPhraseKeyword(value) {
  const text = String(value || "").trim();
  if (!text || hasChineseText(text)) return false;
  const compact = text.replace(/[\s-]+/g, "");
  const isShortCode = /^[A-Z0-9][A-Z0-9.+_-]{1,14}$/i.test(text) && !/\s/.test(text);
  const isDatasetLike = /^[A-Z0-9][A-Z0-9.+_-]{1,12}\s?\d{0,4}$/i.test(text) && text.length <= 16;
  if (isShortCode || isDatasetLike) return false;
  return /\s/.test(text) || /-/.test(text) || compact.length > 14;
}

function parseKeywords(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n\r,，、;；|/]+/);
  return uniqueTextItems(
    rawItems
      .flatMap((item) => String(item || "").split(/[\n\r,，、;；|/]+/))
      .map(cleanKeywordTerm)
      .filter(isKeywordLike)
      .filter((item) => !isEnglishPhraseKeyword(item))
  );
}

function paperKeywords(paper) {
  const analysis = paper?.analysis || {};
  const method = analysis.method || {};
  const candidates = uniqueTextItems([
    ...parseKeywords(paper?.keywords || []),
    ...parseKeywords(analysis.keywords || []),
    ...parseKeywords(analysis.keyword || []),
    ...parseKeywords(analysis.key_words || []),
    ...parseKeywords(analysis.tags || []),
    ...parseKeywords(analysis.task || []),
    ...parseKeywords(analysis.domain || []),
    ...parseKeywords(analysis.modality || []),
    ...parseKeywords(method.method_name || []),
    ...parseKeywords(method.modules || [])
  ]);
  const chinese = candidates.filter(hasChineseText);
  return (chinese.length ? chinese : candidates).slice(0, 12);
}

function renderDetailTabs(tab) {
  return `
    <div class="detail-tabs">
      <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
      <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
    </div>
  `;
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "analysis"
    ? `
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
    `
    : "";

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-only" : ""}">
      ${header}
      ${renderDetailTabs(tab)}
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
}

// Final keyword handling override.
// AI providers sometimes return explanatory phrases in keyword-like fields; keep sidebar/list tags short and user-editable.
function cleanKeywordTerm(value) {
  let text = String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  text = text.replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）。.,，;；:：]+$/g, "");

  const colonIndex = text.search(/[：:]/);
  if (colonIndex > 0) text = text.slice(0, colonIndex).trim();

  text = text.replace(/\s*\(([^)]{3,80})\)\s*/g, (match, inner, offset) => {
    const before = text.slice(0, offset).trim();
    return before && before.length <= 24 ? "" : match;
  }).trim();

  const sentenceBreak = text.search(/[。！？!?；;]/);
  if (sentenceBreak > 0) text = text.slice(0, sentenceBreak).trim();

  return text.replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）。.,，;；:：]+$/g, "").trim();
}

function isKeywordLike(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text.length > 36) return false;
  if ((text.match(/\s+/g) || []).length > 6) return false;
  if (/[。！？!?；;\n\r]/.test(text)) return false;
  if (/(通过|利用|采用|提出|引入|结合|从而|用于|进行|包含|包括|解决|提升|降低|适应|导致|可以|实现|本文|该方法)/.test(text) && text.length > 14) return false;
  return true;
}

function parseKeywords(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n\r,，、;；|/]+/);
  return uniqueTextItems(
    rawItems
      .flatMap((item) => String(item || "").split(/[\n\r,，、;；|/]+/))
      .map(cleanKeywordTerm)
      .filter(isKeywordLike)
  );
}

function mergeKeywords(...groups) {
  return uniqueTextItems(groups.flatMap((group) => parseKeywords(group)));
}

function paperKeywords(paper) {
  const analysis = paper?.analysis || {};
  const method = analysis.method || {};
  return uniqueTextItems([
    ...parseKeywords(paper?.keywords || []),
    ...parseKeywords(analysis.keywords || []),
    ...parseKeywords(analysis.keyword || []),
    ...parseKeywords(analysis.key_words || []),
    ...parseKeywords(analysis.tags || []),
    ...parseKeywords(analysis.task || []),
    ...parseKeywords(analysis.domain || []),
    ...parseKeywords(analysis.modality || []),
    ...parseKeywords(method.method_name || []),
    ...parseKeywords(method.modules || [])
  ]).slice(0, 12);
}

function syncDerivedKeywords(paper) {
  const keywords = paperKeywords(paper);
  paper.keywords = keywords;
  if (paper.analysis) paper.analysis.keywords = keywords;
  return keywords;
}

function compactAllPaperKeywords() {
  let changed = false;
  papers.forEach((paper) => {
    const before = JSON.stringify(paper.keywords || []);
    const next = paperKeywords(paper);
    if (JSON.stringify(next) !== before) {
      paper.keywords = next;
      if (paper.analysis) paper.analysis.keywords = next;
      changed = true;
    }
  });
  if (changed) saveLibrary();
}

function replaceKeywordInList(list, oldKeyword, nextKeyword) {
  const oldKey = oldKeyword.toLowerCase();
  const replaced = parseKeywords(list).flatMap((keyword) => {
    if (keyword.toLowerCase() !== oldKey) return [keyword];
    return nextKeyword ? [nextKeyword] : [];
  });
  return uniqueTextItems(replaced);
}

function editGlobalKeyword(oldKeyword) {
  const current = String(oldKeyword || "").trim();
  if (!current) return;
  const input = prompt("编辑关键词；留空则从所有论文中删除这个关键词。", current);
  if (input === null) return;
  const nextKeyword = cleanKeywordTerm(input);
  if (nextKeyword && !isKeywordLike(nextKeyword)) {
    alert("关键词太长或像一句说明文字，请改成较短的词组。");
    return;
  }

  papers.forEach((paper) => {
    paper.keywords = replaceKeywordInList(paper.keywords || [], current, nextKeyword);
    if (paper.analysis) paper.analysis.keywords = replaceKeywordInList(paper.analysis.keywords || [], current, nextKeyword);
  });
  saveLibrary();
  setStatus(nextKeyword ? `已将关键词“${current}”改为“${nextKeyword}”。` : `已删除关键词“${current}”。`);
  render();
}

function addKeywordToSelectedPaper() {
  const paper = papers.find((item) => item.id === state.selectedId);
  if (!paper) {
    alert("请先选中一篇论文，再添加关键词。");
    return;
  }
  const input = prompt("给当前选中论文添加关键词：");
  if (input === null) return;
  const keywords = parseKeywords(input);
  if (!keywords.length) {
    alert("没有识别到有效关键词。");
    return;
  }
  paper.keywords = mergeKeywords(paper.keywords || [], keywords);
  syncAnalysisKeywords(paper);
  saveLibrary();
  setStatus(`已给“${displayTitle(paper)}”添加 ${keywords.length} 个关键词。`);
  render();
}

function renderKeywords() {
  compactAllPaperKeywords();
  const keywords = [...new Set(papers.flatMap((paper) => paperKeywords(paper)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const activeTerms = parseSearchTerms(state.keywordQuery);
  els.keywordList.innerHTML = "";
  keywords.forEach((keyword) => {
    const button = document.createElement("button");
    button.className = `chip keyword-sidebar-chip ${activeTerms.includes(keyword.toLowerCase()) ? "active" : ""}`;
    button.textContent = keyword;
    button.title = "左键加入关键词检索；右键编辑或删除";
    button.addEventListener("click", () => {
      toggleKeywordTerm(keyword);
      render();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      editGlobalKeyword(keyword);
    });
    els.keywordList.appendChild(button);
  });

  const addButton = document.createElement("button");
  addButton.className = "chip keyword-sidebar-add";
  addButton.textContent = "+";
  addButton.title = "给当前选中论文添加关键词";
  addButton.addEventListener("click", addKeywordToSelectedPaper);
  els.keywordList.appendChild(addButton);
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "source" ? "" : `
    <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
    <h2>${escapeHtml(displayTitle(paper))}</h2>
    <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
  `;

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-detail-inner" : ""}">
      ${header}
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
}

function renderSourcePreview(paper) {
  if (paper.kind === "image") {
    return paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`;
  }

  if (!paper.previewUrl) {
    return `
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
    `;
  }

  return `
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">如果内置 PDF 预览为空白或功能不够，可以点论文词条里的“打开地址”用外部阅读器打开。</div>
    </section>
  `;
}

function initConfig() {
  const config = loadConfig();
  state.globalLanguage = config.globalLanguage || "zh";
  state.theme = config.theme || "standard";
  state.configOpen = Boolean(config.configOpen);
  state.layout = normalizeLayout(config.layout);

  state.apiProfiles = normalizeApiProfiles(config);
  state.activeApiProfileId = config.activeApiProfileId || state.apiProfiles[0]?.id || "";
  applyActiveApiProfile();
  ensureApiProfileUi();
  renderApiProfileUi();

  els.globalLanguageSelect.value = state.globalLanguage;
  els.themeSelect.value = state.theme;
  applyConfigPanel();
  applyTheme();
  applyLayout();
}

function currentConfig() {
  const profile = getActiveApiProfile();
  return {
    provider: profile?.provider || els.providerSelect.value,
    apiKey: profile?.apiKey || els.apiKeyInput.value.trim(),
    model: profile?.model || els.modelSelect.value,
    apiProfiles: state.apiProfiles || [],
    activeApiProfileId: state.activeApiProfileId || "",
    globalLanguage: state.globalLanguage,
    theme: state.theme,
    configOpen: state.configOpen,
    layout: state.layout
  };
}

function normalizeApiProfiles(config) {
  const fromConfig = Array.isArray(config.apiProfiles) ? config.apiProfiles : [];
  const profiles = fromConfig
    .map((profile) => ({
      id: profile.id || crypto.randomUUID(),
      name: String(profile.name || "").trim() || defaultProfileName(profile.provider, profile.model),
      provider: profile.provider === "doubao" ? "doubao" : "deepseek",
      apiKey: String(profile.apiKey || ""),
      model: String(profile.model || "")
    }))
    .filter((profile) => profile.model || profile.apiKey);

  if (profiles.length) return profiles;

  const provider = config.provider === "doubao" ? "doubao" : "deepseek";
  return [{
    id: crypto.randomUUID(),
    name: defaultProfileName(provider, config.model),
    provider,
    apiKey: String(config.apiKey || ""),
    model: String(config.model || (provider === "doubao" ? "" : "deepseek-chat"))
  }];
}

function defaultProfileName(provider, model) {
  const label = provider === "doubao" ? "豆包" : "DeepSeek";
  return model ? `${label}：${model}` : label;
}

function getActiveApiProfile() {
  return (state.apiProfiles || []).find((profile) => profile.id === state.activeApiProfileId) || state.apiProfiles?.[0] || null;
}

function applyActiveApiProfile() {
  const profile = getActiveApiProfile();
  if (!profile) return;
  state.activeApiProfileId = profile.id;
  els.providerSelect.value = profile.provider;
  els.apiKeyInput.value = profile.apiKey || "";
  els.modelSelect.value = profile.model || "";
}

function ensureApiProfileUi() {
  if (document.querySelector("#apiProfileBox")) return;
  const box = document.createElement("section");
  box.id = "apiProfileBox";
  box.className = "api-profile-box";
  box.innerHTML = `
    <label>接口</label>
    <select id="apiProfileSelect"></select>
    <div class="button-row api-profile-actions">
      <button id="newApiProfileBtn" class="secondary" type="button">新增接口</button>
      <button id="editApiProfileBtn" class="secondary" type="button">编辑</button>
    </div>
    <section id="apiProfileEditor" class="api-profile-editor hidden">
      <label>名称</label>
      <input id="apiProfileNameInput" type="text" placeholder="如：豆包视觉 / DeepSeek Pro" />
      <label>服务商</label>
      <select id="apiProfileProviderInput">
        <option value="deepseek">DeepSeek</option>
        <option value="doubao">豆包 / 火山方舟</option>
      </select>
      <label>API Key</label>
      <input id="apiProfileKeyInput" type="password" placeholder="sk-... / 火山方舟 API Key" />
      <label>模型 / Endpoint</label>
      <input id="apiProfileModelInput" type="text" placeholder="deepseek-v4-pro 或 ep-..." />
      <div class="button-row">
        <button id="saveApiProfileBtn" class="secondary" type="button">保存接口</button>
        <button id="deleteApiProfileBtn" class="secondary danger" type="button">删除</button>
      </div>
    </section>
  `;
  els.configPanel.insertBefore(box, els.configPanel.querySelector(".library-actions")?.nextSibling || els.configPanel.firstChild);
  hideLegacyApiConfigControls();
  bindApiProfileUi();
}

function hideLegacyApiConfigControls() {
  [
    els.providerSelect.previousElementSibling,
    els.providerSelect,
    els.apiKeyInput.previousElementSibling,
    els.apiKeyInput,
    els.modelSelect.previousElementSibling,
    els.modelSelect,
    els.modelSelect.nextElementSibling,
    els.saveKeyBtn.closest(".button-row"),
    els.balanceInfo
  ].filter(Boolean).forEach((node) => node.classList.add("profile-hidden"));
}

function bindApiProfileUi() {
  document.querySelector("#apiProfileSelect").addEventListener("change", (event) => {
    state.activeApiProfileId = event.target.value;
    applyActiveApiProfile();
    saveConfig(currentConfig());
    renderApiProfileUi();
    setStatus(`已切换接口：${getActiveApiProfile()?.name || ""}`);
  });
  document.querySelector("#newApiProfileBtn").addEventListener("click", () => openApiProfileEditor(null));
  document.querySelector("#editApiProfileBtn").addEventListener("click", () => openApiProfileEditor(getActiveApiProfile()));
  document.querySelector("#saveApiProfileBtn").addEventListener("click", saveApiProfileFromEditor);
  document.querySelector("#deleteApiProfileBtn").addEventListener("click", deleteActiveApiProfile);
}

function renderApiProfileUi() {
  const select = document.querySelector("#apiProfileSelect");
  if (!select) return;
  select.innerHTML = (state.apiProfiles || []).map((profile, index) => `
    <option value="${profile.id}" ${profile.id === state.activeApiProfileId ? "selected" : ""}>
      ${escapeHtml(profile.name || `接口 ${index + 1}`)}
    </option>
  `).join("");
  document.querySelector("#editApiProfileBtn").disabled = !(state.apiProfiles || []).length;
}

function openApiProfileEditor(profile) {
  const editor = document.querySelector("#apiProfileEditor");
  editor.classList.remove("hidden");
  editor.dataset.editingProfileId = profile?.id || "";
  document.querySelector("#apiProfileNameInput").value = profile?.name || "";
  document.querySelector("#apiProfileProviderInput").value = profile?.provider || "deepseek";
  document.querySelector("#apiProfileKeyInput").value = profile?.apiKey || "";
  document.querySelector("#apiProfileModelInput").value = profile?.model || "";
  document.querySelector("#apiProfileNameInput").focus();
}

function saveApiProfileFromEditor() {
  const editor = document.querySelector("#apiProfileEditor");
  const id = editor.dataset.editingProfileId || crypto.randomUUID();
  const provider = document.querySelector("#apiProfileProviderInput").value === "doubao" ? "doubao" : "deepseek";
  const model = document.querySelector("#apiProfileModelInput").value.trim();
  const profile = {
    id,
    name: document.querySelector("#apiProfileNameInput").value.trim() || defaultProfileName(provider, model),
    provider,
    apiKey: document.querySelector("#apiProfileKeyInput").value.trim(),
    model
  };
  const index = (state.apiProfiles || []).findIndex((item) => item.id === id);
  if (index >= 0) state.apiProfiles[index] = profile;
  else state.apiProfiles = [...(state.apiProfiles || []), profile];
  state.activeApiProfileId = profile.id;
  applyActiveApiProfile();
  editor.classList.add("hidden");
  saveConfig(currentConfig());
  renderApiProfileUi();
  setStatus(`接口已保存：${profile.name}`);
}

function deleteActiveApiProfile() {
  const profile = getActiveApiProfile();
  if (!profile) return;
  if ((state.apiProfiles || []).length <= 1) {
    setStatus("至少保留一个接口。", true);
    return;
  }
  if (!confirm(`删除接口“${profile.name}”？`)) return;
  state.apiProfiles = state.apiProfiles.filter((item) => item.id !== profile.id);
  state.activeApiProfileId = state.apiProfiles[0]?.id || "";
  applyActiveApiProfile();
  document.querySelector("#apiProfileEditor").classList.add("hidden");
  saveConfig(currentConfig());
  renderApiProfileUi();
}

function withPdfViewerParams(url) {
  if (!url) return "";
  return `${url}#toolbar=1&navpanes=0&view=FitH`;
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "source" ? "" : `
    <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
    <h2>${escapeHtml(displayTitle(paper))}</h2>
    <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
  `;

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-detail-inner" : ""}">
      ${header}
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
}

function renderSourcePreview(paper) {
  if (paper.kind === "image") {
    return paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`;
  }

  if (!paper.previewUrl) {
    return `
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
    `;
  }

  return `
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">如果内置 PDF 预览为空白或功能不够，可以点论文词条里的“打开地址”用外部阅读器打开。</div>
    </section>
  `;
}

async function exportLibraryFile() {
  papers.forEach(syncDerivedKeywords);
  saveLibrary();
  const payload = {
    app: "DeepPaper",
    version: 2,
    exportedAt: new Date().toISOString(),
    papers,
    corpus,
    collections,
    libraryAi: window.deepPaperLibraryAi?.exportState?.() || null
  };
  const result = await window.deepPaper.exportLibrary(payload);
  if (!result.ok) {
    if (!result.canceled) setStatus(`导出库失败：${result.error}`, true);
    return;
  }
  setStatus(`文献库已导出：${result.filePath}，包含 ${papers.length} 篇论文、${corpus.length} 条语料、${collections.length} 个合集。`);
}

async function openPaperFile(id) {
  await showPaperSource(id);
}

async function showPaperSource(id) {
  const paper = papers.find((item) => item.id === id);
  if (!paper) return false;
  state.selectedId = paper.id;

  if (paper.kind === "image") {
    state.detailTab = "source";
    render();
    return true;
  }

  if (!paper.filePath) {
    setStatus("没有可预览的本地文件路径。", true);
    return false;
  }

  let result = await window.deepPaper.fileUrlForPath(paper.filePath);
  if (result.missing) {
    const repaired = await repairMovedPaperPath(paper);
    if (!repaired) return false;
    result = await window.deepPaper.fileUrlForPath(paper.filePath);
  }
  if (!result.ok) {
    setStatus(`原文预览失败：${result.error}`, true);
    return false;
  }

  paper.previewUrl = result.url;
  state.detailTab = "source";
  saveLibrary();
  render();
  setStatus(`已在软件内打开：${paper.fileName || paper.filePath}`);
  return true;
}

function switchDetailTab(tab, paperId) {
  if (tab === "source") {
    showPaperSource(paperId);
    return;
  }
  state.detailTab = "analysis";
  render();
}

function renderDetail(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  els.detailPanel.innerHTML = `
    <div class="detail-inner">
      <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
      <h2>${escapeHtml(displayTitle(paper))}</h2>
      <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreview(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });

  if (tab === "analysis") bindAnalysisDetail(paper);
}

function renderAnalysisDetail(paper) {
  const analysis = paper.analysis || {};
  return `
    <div class="detail-actions">
      <button class="secondary detail-action-btn" id="analyzeBtn">${paper.analysis ? "重新 AI 解析" : "AI 解析"}</button>
    </div>
    ${renderImagePreview(paper)}
    ${paper.analysisRepaired ? `<div class="analysis-repaired">这篇论文的 AI 返回格式曾自动修复，结果已保存。</div>` : ""}
    ${renderAnalysisError(paper)}
    ${renderKeywordEditor(paper)}
    ${abstractField(paper, analysis)}
    ${field("来源等级", venueRankDetail(paper))}
    ${field("动机：问题背景", analysis.motivation?.problem_background)}
    ${field("动机：研究空白", analysis.motivation?.research_gap)}
    ${field("动机：为什么重要", analysis.motivation?.why_it_matters)}
    ${field("贡献", analysis.contributions)}
    ${field("方法名称", analysis.method?.method_name)}
    ${field("方法核心", analysis.method?.core_idea)}
    ${field("方法模块", analysis.method?.modules)}
    ${field("方法流程", analysis.method?.pipeline)}
    ${field("数据集", analysis.datasets)}
    ${field("指标", analysis.metrics)}
    ${field("主要结果", analysis.main_results)}
    ${field("局限性", analysis.limitations)}
    ${field("关键词", analysis.keywords)}
    ${field("任务", analysis.task)}
    ${field("领域", analysis.domain)}
    ${field("模态", analysis.modality)}
    ${field("写作用途", analysis.writing_uses)}
    ${field("可信度备注", analysis.confidence_notes)}
    ${renderChatPanel(paper)}
  `;
}

function bindAnalysisDetail(paper) {
  document.querySelector("#analyzeBtn")?.addEventListener("click", () => analyzePaper(paper.id));
  document.querySelector("#abstractDetails")?.addEventListener("toggle", (event) => {
    paper.abstractOpen = event.target.open;
    saveLibrary();
  });
  document.querySelector("#abstractLangBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePaperAbstractLanguage(paper.id);
  });
  bindKeywordEditor(paper.id);
  document.querySelector("#sendChatBtn")?.addEventListener("click", () => sendChatMessage(paper.id));
  document.querySelector("#chatInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage(paper.id);
    }
  });
  document.querySelector("#chatSearchInput")?.addEventListener("input", (event) => {
    state.chatQuery = event.target.value;
    render();
  });
  document.querySelector("#clearChatBtn")?.addEventListener("click", () => clearPaperChat(paper.id));
  document.querySelector("#attachChatImageBtn")?.addEventListener("click", () => attachChatImages());
  document.querySelectorAll("[data-remove-chat-attachment]").forEach((button) => {
    button.addEventListener("click", () => {
      state.chatAttachments.splice(Number(button.dataset.removeChatAttachment), 1);
      render();
    });
  });
  document.querySelectorAll("[data-chat-delete]").forEach((button) => {
    button.addEventListener("click", () => deleteChatMessage(paper.id, Number(button.dataset.chatDelete)));
  });
  if (!state.chatQuery) scrollChatToBottom();
}

function renderSourcePreview(paper) {
  if (paper.kind === "image") {
    return paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "image")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览数据，可以重新导入图片。</section>`;
  }

  if (!paper.previewUrl) {
    return `
      <section class="source-preview source-placeholder">
        <div>点击下方按钮在软件内加载原文。</div>
        <button class="secondary detail-action-btn" data-detail-tab="source">加载原文</button>
      </section>
    `;
  }

  return `
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(paper.previewUrl)}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">如果内置 PDF 预览为空白或功能不够，可以点论文词条里的“打开地址”用外部阅读器打开。</div>
    </section>
  `;
}

// Final source quote feature. Keep these assignments at EOF so older duplicate
// render declarations above cannot replace the active implementation.
function sourceQuoteText(paper) {
  const text = String(paper?.text || "").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= 120000) return text;
  return `${text.slice(0, 80000)}\n\n[正文较长，中间部分已省略]\n\n${text.slice(-30000)}`;
}

function renderSourceQuoteTool(paper) {
  const text = sourceQuoteText(paper);
  if (!text) {
    return `
      <section class="source-quote-tool source-quote-empty">
        <strong>选句加入语料库</strong>
        <span>这篇论文没有可选择的提取文本。</span>
      </section>
    `;
  }

  return `
    <section class="source-quote-tool">
      <div class="source-quote-toolbar">
        <div>
          <strong>选句加入语料库</strong>
          <span>在下方文字中选中一句话，然后点击右侧按钮。</span>
        </div>
        <button id="addSourceQuoteBtn" class="primary small-btn" type="button" disabled>加入语料库</button>
      </div>
      <div id="sourceQuoteText" class="source-quote-text" data-source-label="原文摘录">${escapeHtml(text)}</div>
      <div id="sourceQuoteFeedback" class="source-quote-feedback">尚未选中文字</div>
    </section>
  `;
}

function captureSourceQuoteSelection(paper) {
  const container = document.querySelector("#sourceQuoteText");
  const button = document.querySelector("#addSourceQuoteBtn");
  const feedback = document.querySelector("#sourceQuoteFeedback");
  const selection = window.getSelection();
  const text = String(selection?.toString() || "").trim();
  const isInside = Boolean(
    text &&
    selection?.anchorNode &&
    selection?.focusNode &&
    container?.contains(selection.anchorNode) &&
    container?.contains(selection.focusNode)
  );

  if (!isInside) {
    state.pendingSourceQuote = null;
    if (button) button.disabled = true;
    if (feedback) feedback.textContent = "尚未选中文字";
    return;
  }

  state.pendingSourceQuote = {
    paperId: paper.id,
    text,
    sourceLabel: "原文摘录",
    type: "其他",
    tags: paperKeywords(paper)
  };
  if (button) button.disabled = false;
  if (feedback) feedback.textContent = `已选中 ${text.length} 个字符：${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`;
}

function addSelectedSourceQuote(paper) {
  const pending = state.pendingSourceQuote;
  const feedback = document.querySelector("#sourceQuoteFeedback");
  const button = document.querySelector("#addSourceQuoteBtn");
  if (!pending?.text || pending.paperId !== paper.id) {
    if (feedback) feedback.textContent = "请先在上方提取文本中选中一句话。";
    setStatus("请先在提取文本中选中一句话。", true);
    return;
  }

  corpus.unshift({
    id: crypto.randomUUID(),
    paperId: paper.id,
    paperTitleZh: paper.titleZh || paper.analysis?.title_zh || paper.title || "",
    paperTitleEn: paper.titleEn || paper.analysis?.title_en || "",
    paperVenue: paper.venue || "",
    paperYear: paper.year || "",
    sourceLabel: "原文摘录",
    type: "其他",
    text: pending.text,
    tags: [...(pending.tags || [])],
    note: "",
    createdAt: new Date().toISOString()
  });
  saveCorpus();
  state.pendingSourceQuote = null;
  window.getSelection()?.removeAllRanges();
  if (button) {
    button.disabled = true;
    button.textContent = "已加入";
  }
  if (feedback) feedback.textContent = `已加入语料库：${pending.text.slice(0, 80)}${pending.text.length > 80 ? "..." : ""}`;
  els.openCorpusBtn.textContent = `语料库 (${corpus.length})`;
  renderCorpus();
  setStatus("选中的句子已加入语料库。打开语料库即可查看。 ");
}

function bindSourceQuoteTool(paper) {
  const text = document.querySelector("#sourceQuoteText");
  const button = document.querySelector("#addSourceQuoteBtn");
  if (!text || !button) return;
  text.addEventListener("mouseup", () => captureSourceQuoteSelection(paper));
  text.addEventListener("keyup", () => captureSourceQuoteSelection(paper));
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => addSelectedSourceQuote(paper));
}

function renderSourcePreviewWithQuoteTool(paper) {
  const quoteTool = renderSourceQuoteTool(paper);
  if (paper.kind === "image") {
    const image = paper.imageDataUrl
      ? `<section class="source-preview source-image-preview"><img src="${paper.imageDataUrl}" alt="${escapeHtml(paper.fileName || "图片")}" /></section>`
      : `<section class="source-preview empty compact">这张图片没有可预览的数据。</section>`;
    return `${quoteTool}${image}`;
  }

  if (!paper.previewUrl) {
    return `${quoteTool}<section class="source-preview source-placeholder">没有可预览的本地 PDF。</section>`;
  }

  return `
    ${quoteTool}
    <section class="source-preview">
      <iframe class="pdf-preview-frame" src="${escapeHtml(withPdfViewerParams(paper.previewUrl))}" title="${escapeHtml(paper.fileName || "PDF 原文")}"></iframe>
      <div class="source-preview-hint">PDF 用于阅读版面；选句请使用上方的提取文本框。</div>
    </section>
  `;
}

function renderDetailWithSourceQuote(paper) {
  if (!paper) {
    els.detailPanel.innerHTML = `<div class="empty">选择一篇论文查看解析结果。</div>`;
    return;
  }

  const tab = state.detailTab === "source" ? "source" : "analysis";
  const header = tab === "analysis" ? `
    <p class="eyebrow">${escapeHtml(displayAlternateTitle(paper) || paper.venue || "")}</p>
    <h2>${escapeHtml(displayTitle(paper))}</h2>
    <div class="meta">${escapeHtml([paper.kind === "image" ? "图片" : "", paper.year, paper.venue, venueRankLabel(paper), paper.kind === "image" ? "" : `${paper.pageCount || 0} 页`, paper.status].filter(Boolean).join(" | "))}</div>
  ` : "";

  els.detailPanel.innerHTML = `
    <div class="detail-inner ${tab === "source" ? "source-only" : ""}">
      ${header}
      <div class="detail-tabs">
        <button class="detail-tab ${tab === "analysis" ? "active" : ""}" data-detail-tab="analysis">解析</button>
        <button class="detail-tab ${tab === "source" ? "active" : ""}" data-detail-tab="source">原文</button>
      </div>
      ${tab === "source" ? renderSourcePreviewWithQuoteTool(paper) : renderAnalysisDetail(paper)}
    </div>
  `;

  document.querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => switchDetailTab(button.dataset.detailTab, paper.id));
  });
  if (tab === "analysis") bindAnalysisDetail(paper);
  if (tab === "source") bindSourceQuoteTool(paper);
}

renderSourcePreview = renderSourcePreviewWithQuoteTool;
renderDetail = renderDetailWithSourceQuote;
