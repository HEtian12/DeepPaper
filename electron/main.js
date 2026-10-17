const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { validateToolCall, normalizeReadPaperIds } = require("../agent-tools.js");
const { transcribeWithWhisper } = require("./asr.js");

let pdfJsModulePromise = null;
const agentRunControllers = new Map();

const API_BASES = {
  deepseek: "https://api.deepseek.com",
  doubao: "https://ark.cn-beijing.volces.com/api/v3"
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    title: "DeepPaper",
    backgroundColor: "#f4f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, "..", "index.html"));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isAppWindow = BrowserWindow.getAllWindows().some((win) => win.webContents === webContents);
    const isLocalAudioRequest = permission === "media"
      && details?.mediaTypes?.includes("audio")
      && String(details?.requestingUrl || "").startsWith("file://");
    callback(Boolean(isAppWindow && isLocalAudioRequest));
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("papers:choosePdf", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择论文 PDF",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("papers:chooseImage", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择图片",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("papers:extractPdf", async (_event, filePath) => {
  try {
    const buffer = await fs.readFile(filePath);
    const parsed = await extractPdfTextWithPages(buffer);
    return {
      ok: true,
      kind: "pdf",
      filePath,
      fileName: path.basename(filePath),
      fileHash: crypto.createHash("sha256").update(buffer).digest("hex"),
      fileSize: buffer.length,
      pageCount: parsed.pageCount,
      text: parsed.text,
      pageTextOffsets: parsed.pageTextOffsets
    };
  } catch (error) {
    return { ok: false, filePath, error: error.message };
  }
});

ipcMain.handle("papers:extractPdfPages", async (_event, filePath) => {
  if (!filePath || path.extname(filePath).toLowerCase() !== ".pdf") {
    return { ok: false, error: "没有可建立段落索引的 PDF 文件。" };
  }
  try {
    if (!(await pathExists(filePath))) return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    const buffer = await fs.readFile(filePath);
    const parsed = await extractPdfTextWithPages(buffer);
    return { ok: true, ...parsed };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:extractImage", async (_event, filePath) => {
  try {
    const buffer = await fs.readFile(filePath);
    const mimeType = imageMimeType(filePath);
    return {
      ok: true,
      kind: "image",
      filePath,
      fileName: path.basename(filePath),
      fileHash: crypto.createHash("sha256").update(buffer).digest("hex"),
      fileSize: buffer.length,
      mimeType,
      imageDataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
      text: ""
    };
  } catch (error) {
    return { ok: false, filePath, error: error.message };
  }
});

ipcMain.handle("papers:openFile", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可打开的文件路径。" };
  try {
    const error = await shell.openPath(filePath);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:openFileLocation", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可定位的文件路径。" };
  try {
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:openExistingFile", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可打开的文件路径。" };
  try {
    if (!(await pathExists(filePath))) return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    const error = await shell.openPath(filePath);
    if (error) return { ok: false, error };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:openExistingFileLocation", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可定位的文件路径。" };
  try {
    if (!(await pathExists(filePath))) return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:fileUrl", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可预览的文件路径。" };
  try {
    if (!(await pathExists(filePath))) return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    return { ok: true, url: pathToFileURL(filePath).toString() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:readPdf", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可读取的 PDF 文件路径。" };
  if (path.extname(filePath).toLowerCase() !== ".pdf") {
    return { ok: false, error: "只允许读取 PDF 文件。" };
  }
  try {
    if (!(await pathExists(filePath))) {
      return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    }
    const buffer = await fs.readFile(filePath);
    const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:openFileWithApp", async (_event, filePath) => {
  if (!filePath) return { ok: false, error: "没有可打开的文件路径。" };
  try {
    if (!(await pathExists(filePath))) return { ok: false, missing: true, error: `文件不存在：${filePath}` };
    const result = await dialog.showOpenDialog({
      title: "选择用于打开文章的软件",
      properties: ["openFile"],
      filters: [
        { name: "Windows 程序", extensions: ["exe"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const appPath = result.filePaths[0];
    const child = spawn(appPath, [filePath], {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return { ok: true, appPath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("papers:locateMovedFile", async (_event, payload) => {
  const fileName = String(payload?.fileName || "").trim();
  const oldPath = String(payload?.oldPath || "").trim();
  const kind = String(payload?.kind || "").toLowerCase();
  const extensions = kind === "image" ? ["png", "jpg", "jpeg", "webp", "bmp"] : ["pdf"];
  const result = await dialog.showOpenDialog({
    title: fileName ? `重新定位：${fileName}` : "重新定位文件",
    defaultPath: oldPath ? path.dirname(oldPath) : undefined,
    properties: ["openFile"],
    filters: [{ name: kind === "image" ? "Image" : "PDF", extensions }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const nextPath = result.filePaths[0];
  return {
    ok: true,
    filePath: nextPath,
    fileName: path.basename(nextPath),
    sameName: fileName ? path.basename(nextPath).toLowerCase() === fileName.toLowerCase() : true
  };
});

ipcMain.handle("papers:openExternal", async (_event, url) => {
  const value = String(url || "").trim();
  if (!value) return { ok: false, error: "没有可打开的地址。" };
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, error: "只支持打开 http 或 https 地址。" };
    await shell.openExternal(parsed.toString());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("library:import", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "导入 DeepPaper 文献库",
      properties: ["openFile"],
      filters: [{ name: "DeepPaper Library", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const content = await fs.readFile(result.filePaths[0], "utf8");
    return { ok: true, filePath: result.filePaths[0], content };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("library:export", async (_event, payload) => {
  try {
    const result = await dialog.showSaveDialog({
      title: "导出 DeepPaper 文献库",
      defaultPath: `deeppaper-library-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "DeepPaper Library", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), "utf8");
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("deepseek:analyze", async (_event, payload) => {
  const { apiKey, provider = "deepseek", model, paperText, fileName, imageDataUrl } = payload || {};
  if (!apiKey) return { ok: false, error: `请先填写 ${providerLabel(provider)} API Key。`, phase: "config" };
  if (imageDataUrl && provider !== "doubao") {
    return { ok: false, error: "图片分析需要选择豆包/火山方舟，并使用视觉模型。", phase: "config" };
  }
  if (!imageDataUrl && (!paperText || paperText.trim().length < 200)) {
    return { ok: false, error: "论文文本太短，无法可靠解析。", phase: "pdf-text" };
  }

  const messages = imageDataUrl
    ? buildImageAnalysisMessages(fileName, imageDataUrl)
    : buildPaperAnalysisMessages(fileName, trimForAnalysis(paperText));

  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0.15,
    responseFormat: { type: "json_object" },
    messages
  });

  if (!result.ok) return { ...result, phase: `${provider}-request` };
  const parsed = parseJsonObject(result.content);
  if (parsed.ok) return { ok: true, result: parsed.value, raw: result.content, repaired: false };

  const repaired = await repairJsonResponse({ provider, apiKey, model, rawContent: result.content });
  if (repaired.ok) return { ok: true, result: repaired.result, raw: result.content, repaired: true, repairedRaw: repaired.raw };

  return {
    ok: false,
    error: `${providerLabel(provider)} 返回内容不是合法 JSON，自动修复也失败：${repaired.error || parsed.error}`,
    raw: result.content,
    phase: "json-parse"
  };
});

ipcMain.handle("deepseek:chat", async (_event, payload) => {
  const { apiKey, provider = "deepseek", model, paper, message, history, attachments } = payload || {};
  if (!apiKey) return { ok: false, error: `请先填写 ${providerLabel(provider)} API Key。` };
  if (!message || !String(message).trim()) return { ok: false, error: "请输入问题。" };
  if (!paper) return { ok: false, error: "请先选择一篇论文。" };
  if (paper.kind === "image" && provider !== "doubao") {
    return { ok: false, error: "图片对话需要选择豆包/火山方舟，并使用视觉模型。" };
  }
  const imageAttachments = Array.isArray(attachments) ? attachments.filter((item) => item?.imageDataUrl) : [];
  if (imageAttachments.length && provider !== "doubao") {
    return { ok: false, error: "图片附件需要选择豆包/火山方舟，并使用支持视觉的接入点。" };
  }

  const chatHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = paper.kind === "image"
    ? buildImageChatMessages(paper, chatHistory, message, imageAttachments)
    : buildTextChatMessages(paper, chatHistory, message, imageAttachments);

  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0.3,
    messages
  });
  if (!result.ok) return result;
  return { ok: true, message: result.content };
});

ipcMain.handle("library:ai-chat", async (_event, payload) => {
  const { apiKey, provider = "deepseek", model, message, history, candidates } = payload || {};
  if (!apiKey) return { ok: false, error: `请先配置 ${providerLabel(provider)} API Key。` };
  if (!String(message || "").trim()) return { ok: false, error: "请输入要检索或分析的问题。" };

  const safeCandidates = (Array.isArray(candidates) ? candidates : [])
    .slice(0, 30)
    .map((item) => ({
      id: String(item.id || ""),
      title_zh: clipLibraryAiText(item.titleZh, 220),
      title_en: clipLibraryAiText(item.titleEn, 220),
      year: clipLibraryAiText(item.year, 20),
      venue: clipLibraryAiText(item.venue, 180),
      rank: clipLibraryAiText(item.rank, 80),
      keywords: (Array.isArray(item.keywords) ? item.keywords : []).slice(0, 16).map((value) => clipLibraryAiText(value, 80)),
      abstract: clipLibraryAiText(item.abstract, 900),
      motivation: clipLibraryAiText(item.motivation, 650),
      method: clipLibraryAiText(item.method, 650),
      contributions: clipLibraryAiText(item.contributions, 650),
      task: clipLibraryAiText(item.task, 260),
      domain: clipLibraryAiText(item.domain, 220),
      datasets: clipLibraryAiText(item.datasets, 260),
      results: clipLibraryAiText(item.results, 420),
      local_matched_terms: (Array.isArray(item.matchedTerms) ? item.matchedTerms : []).slice(0, 12)
    }))
    .filter((item) => item.id);

  if (!safeCandidates.length) {
    return { ok: false, error: "本地文献库没有召回可供 AI 判断的候选论文。" };
  }

  const recentHistory = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: clipLibraryAiText(item.content, 1800)
    }));

  const messages = [
    {
      role: "system",
      content: [
        "你是私人文献库的中文检索与研究助理。",
        "你只能依据用户问题和提供的候选论文信息回答，禁止编造候选列表之外的论文或论文事实。",
        "先判断哪些候选论文真正相关，再给出简洁的综合回答。",
        "如果证据不足，要明确说明；论文没有提供的信息不要推测。",
        "输出必须是严格 JSON，不要使用 Markdown。",
        "JSON 格式：",
        '{"answer":"中文综合回答","matches":[{"paper_id":"候选论文 id","reason":"中文匹配原因","relevance":"高|中|低"}],"follow_ups":["可继续追问的问题"]}',
        "matches 最多返回 10 篇，必须使用候选论文中原样的 id，并按相关性从高到低排列。"
      ].join("\n")
    },
    ...recentHistory,
    {
      role: "user",
      content: [
        `用户问题：${String(message).trim()}`,
        `本地已扫描全部文献，召回以下 ${safeCandidates.length} 篇候选论文：`,
        JSON.stringify(safeCandidates)
      ].join("\n\n")
    }
  ];

  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0.15,
    responseFormat: { type: "json_object" },
    messages
  });
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.content);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return {
      ok: true,
      result: {
        answer: result.content,
        matches: [],
        follow_ups: []
      },
      unstructured: true
    };
  }

  const allowedIds = new Set(safeCandidates.map((item) => item.id));
  const matches = (Array.isArray(parsed.value.matches) ? parsed.value.matches : [])
    .filter((item) => allowedIds.has(String(item?.paper_id || "")))
    .slice(0, 10)
    .map((item) => ({
      paperId: String(item.paper_id),
      reason: clipLibraryAiText(item.reason, 360),
      relevance: ["高", "中", "低"].includes(item.relevance) ? item.relevance : "中"
    }));

  return {
    ok: true,
    result: {
      answer: clipLibraryAiText(parsed.value.answer || result.content, 6000),
      matches,
      followUps: (Array.isArray(parsed.value.follow_ups) ? parsed.value.follow_ups : [])
        .slice(0, 4)
        .map((item) => clipLibraryAiText(item, 180))
        .filter(Boolean)
    }
  };
});

ipcMain.handle("embeddings:create", async (_event, payload) => {
  const { embeddingProvider, embeddingBaseUrl, embeddingApiKey, apiKey, embeddingModel, input } = payload || {};
  const provider = embeddingProvider === "ollama" ? "ollama" : "api";
  const key = String(embeddingApiKey || apiKey || "").trim();
  const model = String(embeddingModel || "").trim();
  const values = (Array.isArray(input) ? input : [input])
    .map((item) => String(item || "").trim().slice(0, 8000))
    .filter(Boolean)
    .slice(0, 32);
  if (!model || !embeddingBaseUrl || (provider !== "ollama" && !key)) return { ok: false, error: "Embedding 配置不完整。" };
  if (!values.length) return { ok: false, error: "没有可向量化的文本。" };

  if (provider === "ollama") {
    let endpoint;
    try {
      const url = new URL(String(embeddingBaseUrl).trim());
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
        throw new Error("本地 Ollama 地址必须是 localhost 或 127.0.0.1 的 HTTP 地址。");
      }
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/embed`;
      endpoint = url.toString();
    } catch (error) {
      return { ok: false, error: error.message || "Ollama 地址无效。" };
    }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: values })
      });
      const bodyText = await response.text();
      if (!response.ok) return { ok: false, error: `本地 Ollama Embedding 请求失败：${response.status} ${bodyText.slice(0, 1200)}`, endpoint, model };
      const data = safeJsonParse(bodyText);
      const vectors = Array.isArray(data?.embeddings) ? data.embeddings : [];
      if (vectors.length !== values.length || vectors.some((vector) => !Array.isArray(vector) || !vector.length)) {
        return { ok: false, error: "本地 Ollama 返回的向量数量或格式无效。", endpoint, model };
      }
      return { ok: true, vectors, model: data?.model || model, usage: null };
    } catch (error) {
      return { ok: false, error: `无法连接本地 Ollama：${error.message}。请确认 Ollama 正在运行且模型已下载。`, endpoint, model };
    }
  }

  let endpoint;
  try {
    endpoint = normalizeEmbeddingEndpoint(embeddingBaseUrl);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  if (isMultimodalEmbeddingEndpoint(endpoint)) {
    const result = await createMultimodalEmbeddingVectors({ endpoint, key, model, values });
    if (result.ok) return result;
    return {
      ...result,
      error: `${result.error || "Embedding 请求失败。"}\n调用地址：${endpoint}\n模型：${model}`,
      endpoint,
      model
    };
  }

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const requestInput = values.length === 1 ? values[0] : values;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: requestInput, encoding_format: "float" })
      });
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `Embedding 请求失败：${response.status} ${bodyText.slice(0, 1200)}`;
      } else {
        const data = safeJsonParse(bodyText);
        const entries = Array.isArray(data?.data) ? [...data.data].sort((a, b) => Number(a.index) - Number(b.index)) : [];
        const vectors = entries.map((item) => item?.embedding).filter((vector) => Array.isArray(vector) && vector.length);
        if (vectors.length === values.length) {
          return { ok: true, vectors, model: data?.model || model, usage: data?.usage || null };
        }
        lastError = "Embedding 接口返回了无法识别的向量数据。";
      }
    } catch (error) {
      lastError = `Embedding 请求失败：${error.message}`;
    }
    if (attempt < 3 && isRetryableError(lastError)) await sleep(700 * attempt);
    else break;
  }
  return {
    ok: false,
    error: `${lastError || "Embedding 请求失败。"}\n调用地址：${endpoint}\n模型：${model}`,
    endpoint,
    model
  };
});

ipcMain.handle("agent:step", async (_event, payload) => {
  const { apiKey, provider = "deepseek", model, goal, transcript, runId } = payload || {};
  if (!apiKey) return { ok: false, error: `请先配置 ${providerLabel(provider)} API Key。` };
  if (!String(goal || "").trim()) return { ok: false, error: "请输入 Agent 任务。" };

  const safeTranscript = (Array.isArray(transcript) ? transcript : [])
    .slice(-10)
    .map((entry) => ({
      type: entry?.type === "tool_result" ? "tool_result" : "agent_action",
      tool: clipLibraryAiText(entry?.tool, 80),
      summary: clipLibraryAiText(entry?.summary, 500),
      arguments: entry?.arguments && typeof entry.arguments === "object" ? entry.arguments : {},
      result: clipLibraryAiText(entry?.result, 24000)
    }));

  const messages = [
    {
      role: "system",
      content: [
        "你是 DeepPaper 本地文献库 Agent。你要通过调用本地工具完成用户目标，而不是凭空回答。",
        "每次只能返回一个工具调用，或在证据充分时结束。不要输出思维链，只提供简短的 decision_summary。",
        "可用工具：",
        "1. search_library：在全库检索论文。参数 {query:string, limit:number}。任务开始时通常先调用它。",
        "2. search_passages：从 PDF 正文段落中进行关键词与语义混合检索并重排证据。参数 {query:string, limit:number}。回答论文内容、方法或结果问题时优先调用。",
        "3. read_passages：读取段落及相邻上下文。参数 {passage_ids:string[]}。需要核实上下文时调用。",
        "4. read_papers：读取指定论文的结构化解析。参数 {paper_ids:string[], sections:string[]}。paper_ids 必须逐字复制最近 search_library 结果里的 paper_id，单次最多 6 篇；不要传标题。sections 可包含 abstract、motivation、method、contributions、results、keywords、metadata。",
        "5. compare_papers：为多篇论文获取对比材料。参数 {paper_ids:string[], focus:string}。",
        "6. propose_collection：提出合集写入方案，但必须由用户确认后才执行。参数 {name:string, paper_ids:string[], rationale:string}。",
        "7. build_evidence_map：读取多篇论文的问题、方法、数据集、结果和局限，构建可比较的证据图谱。参数 {paper_ids:string[]}。研究空白、方法关系和跨论文综合任务应调用。",
        "规则：只能引用工具结果中真实存在的 paper_id 和 passage_id；证据不足时明确说明；不要虚构论文、页码、原文、结果或排名。",
        "如果用户要求找论文，至少调用一次 search_library 或 search_passages；如果要求比较或总结，应继续 read_passages、read_papers 或 compare_papers。正文工具返回了 passage_id 时，最终引用优先带 passage_id。",
        "输出必须是严格 JSON，二选一：",
        '{"status":"tool","decision_summary":"简短说明下一步","tool":{"name":"search_library|search_passages|read_passages|read_papers|compare_papers|build_evidence_map|propose_collection","arguments":{}}}',
        '{"status":"final","decision_summary":"简短结论","final":{"answer":"中文回答","citations":[{"paper_id":"真实 id","passage_id":"可选的真实段落 id","reason":"引用理由"}],"follow_ups":["后续问题"]}}'
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `用户目标：${String(goal).trim()}`,
        `已经执行的步骤：${JSON.stringify(safeTranscript)}`,
        "请决定下一步。"
      ].join("\n\n")
    }
  ];

  const controller = new AbortController();
  const requestId = String(runId || "");
  if (requestId) agentRunControllers.set(requestId, controller);
  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0.1,
    responseFormat: { type: "json_object" },
    messages,
    signal: controller.signal
  });
  if (requestId && agentRunControllers.get(requestId) === controller) agentRunControllers.delete(requestId);
  if (!result.ok) return result;

  const parsed = parseJsonObject(result.content);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return { ok: false, error: `${providerLabel(provider)} 没有返回合法的 Agent 指令。` };
  }

  const value = parsed.value;
  const summary = clipLibraryAiText(value.decision_summary, 500);
  if (value.status === "tool") {
    value.tool = normalizeReadPaperIds(value.tool, safeTranscript);
    const validation = validateToolCall(value.tool);
    if (!validation.ok) return { ok: false, error: `Agent tool arguments invalid: ${validation.error}` };
    return {
      ok: true,
      step: {
        status: "tool",
        decisionSummary: summary,
        tool: validation.tool
      }
    };
  }

  if (value.status !== "final") return { ok: false, error: "Agent 返回了无法识别的状态。" };
  return {
    ok: true,
    step: {
      status: "final",
      decisionSummary: summary,
      final: {
        answer: clipLibraryAiText(value.final?.answer, 8000),
        citations: (Array.isArray(value.final?.citations) ? value.final.citations : []).slice(0, 16).map((item) => ({
          paperId: clipLibraryAiText(item?.paper_id, 100),
          passageId: clipLibraryAiText(item?.passage_id, 180),
          reason: clipLibraryAiText(item?.reason, 400)
        })).filter((item) => item.paperId),
        followUps: (Array.isArray(value.final?.follow_ups) ? value.final.follow_ups : []).slice(0, 4).map((item) => clipLibraryAiText(item, 180)).filter(Boolean)
      }
    }
  };
});

ipcMain.handle("agent:cancel", async (_event, runId) => {
  const requestId = String(runId || "");
  const controller = agentRunControllers.get(requestId);
  if (!controller) return { ok: true, cancelled: false };
  controller.abort();
  agentRunControllers.delete(requestId);
  return { ok: true, cancelled: true };
});

ipcMain.handle("audio:transcribe", async (_event, payload = {}) => transcribeWithWhisper(payload));

ipcMain.handle("agent:verify", async (_event, payload) => {
  const { apiKey, provider = "deepseek", model, goal, answer, citations, runId } = payload || {};
  const evidence = (Array.isArray(citations) ? citations : []).slice(0, 16).map((item) => ({
    passage_id: clipLibraryAiText(item?.passageId, 180),
    paper_title: clipLibraryAiText(item?.paperTitle, 300),
    page: Number(item?.pageNumber) || null,
    quote: clipLibraryAiText(item?.quote, 900),
    claimed_reason: clipLibraryAiText(item?.reason, 500)
  })).filter((item) => item.passage_id && item.quote);
  if (!evidence.length) {
    return {
      ok: true,
      verification: { verdict: "insufficient", score: 0, summary: "回答没有可核验的正文证据。", issues: ["没有有效段落引用。"], supportedPassageIds: [] }
    };
  }

  const controller = new AbortController();
  const requestId = String(runId || "");
  if (requestId) agentRunControllers.set(requestId, controller);
  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0,
    responseFormat: { type: "json_object" },
    signal: controller.signal,
    messages: [
      {
        role: "system",
        content: [
          "你是科研回答证据校验器，只能依据提供的本地论文原文证据进行检查。",
          "检查回答中的主要结论是否被证据直接支持，是否存在过度推断、张冠李戴或证据缺口。",
          "不要补充外部知识。输出严格 JSON，不要 Markdown。",
          'schema: {"verdict":"supported|partial|insufficient","score":0-100,"summary":"中文简述","issues":["中文问题"],"supported_passage_ids":["真实 passage_id"]}'
        ].join("\n")
      },
      {
        role: "user",
        content: `用户目标：${clipLibraryAiText(goal, 1200)}\n\n待校验回答：${clipLibraryAiText(answer, 8000)}\n\n本地证据：${JSON.stringify(evidence)}`
      }
    ]
  });
  if (requestId && agentRunControllers.get(requestId) === controller) agentRunControllers.delete(requestId);
  if (!result.ok) return result;
  const parsed = parseJsonObject(result.content);
  if (!parsed.ok) return { ok: false, error: `证据校验结果解析失败：${parsed.error}` };
  const value = parsed.value || {};
  const allowedIds = new Set(evidence.map((item) => item.passage_id));
  const verdict = ["supported", "partial", "insufficient"].includes(value.verdict) ? value.verdict : "partial";
  return {
    ok: true,
    verification: {
      verdict,
      score: Math.max(0, Math.min(100, Number(value.score) || 0)),
      summary: clipLibraryAiText(value.summary, 600),
      issues: (Array.isArray(value.issues) ? value.issues : []).slice(0, 6).map((item) => clipLibraryAiText(item, 400)).filter(Boolean),
      supportedPassageIds: (Array.isArray(value.supported_passage_ids) ? value.supported_passage_ids : []).map(String).filter((id) => allowedIds.has(id))
    }
  };
});

ipcMain.handle("deepseek:balance", async (_event, apiKey) => {
  if (!apiKey) return { ok: false, error: "请先填写 DeepSeek API Key。" };
  try {
    const response = await fetch(`${API_BASES.deepseek}/user/balance`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` }
    });
    const text = await response.text();
    const data = safeJsonParse(text);
    if (!response.ok) return { ok: false, error: `余额查询失败：${response.status} ${text}` };
    return { ok: true, result: data };
  } catch (error) {
    return { ok: false, error: `余额查询失败：${error.message}` };
  }
});

function clipLibraryAiText(value, limit) {
  const text = Array.isArray(value)
    ? value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join("；")
    : value && typeof value === "object"
      ? JSON.stringify(value)
      : String(value || "");
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function callChatWithRetry(options) {
  const maxAttempts = 3;
  let lastResult = null;
  let attemptsUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) return { ok: false, error: "请求已取消。", cancelled: true };
    attemptsUsed = attempt;
    const result = await callChat(options);
    if (result.ok) return attempt > 1 ? { ...result, retried: attempt - 1 } : result;
    lastResult = result;
    if (!isRetryableError(result.error) || attempt >= maxAttempts) break;
    await sleep(900 * attempt + Math.floor(Math.random() * 400));
    if (options.signal?.aborted) return { ok: false, error: "请求已取消。", cancelled: true };
  }
  return {
    ...lastResult,
    error: attemptsUsed > 1 ? `${lastResult?.error || "请求失败。"}（已自动重试 ${attemptsUsed - 1} 次）` : lastResult?.error || "请求失败。",
    retried: Math.max(0, attemptsUsed - 1)
  };
}

async function callChat({ provider = "deepseek", apiKey, model, messages, temperature, responseFormat, signal }) {
  const baseUrl = API_BASES[provider] || API_BASES.deepseek;
  const body = { model: model || defaultModel(provider), temperature, messages };
  if (responseFormat) body.response_format = responseFormat;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      const message = await response.text();
      return { ok: false, error: `${providerLabel(provider)} 请求失败：${response.status} ${message}` };
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    if (!content) return { ok: false, error: `${providerLabel(provider)} 没有返回内容。` };
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: `${providerLabel(provider)} 请求失败：${error.message}` };
  }
}

function buildPaperAnalysisMessages(fileName, text) {
  return [
    {
      role: "system",
      content: [
        "你是严谨的学术论文信息抽取助手。",
        "只能根据用户提供的论文文本抽取信息，不要编造。",
        "如果文本没有明确说明，字段填 null 或空数组。",
        "输出必须是严格 JSON，不要 Markdown，不要解释性文字。",
        "输出语言必须是简体中文。"
      ].join("\n")
    },
    { role: "user", content: buildExtractionPrompt(fileName, text) }
  ];
}

function buildImageAnalysisMessages(fileName, imageDataUrl) {
  return [
    {
      role: "system",
      content: "你是科研图片理解助手。根据图片内容输出严格 JSON，不要 Markdown，不要解释性文字。"
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: buildImageExtractionPrompt(fileName)
        },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    }
  ];
}

function buildTextChatMessages(paper, chatHistory, message, attachments = []) {
  const imageParts = attachments
    .filter((item) => item?.imageDataUrl)
    .map((item) => ({ type: "image_url", image_url: { url: item.imageDataUrl } }));
  const userContent = imageParts.length
    ? [
        { type: "text", text: `${String(message)}\n\n请结合我上传的图片一起回答。` },
        ...imageParts
      ]
    : String(message);
  return [
    {
      role: "system",
      content: [
        "你是论文阅读助手，回答必须使用中文。",
        "优先依据当前论文文本和已解析卡片回答；证据不足时明确说明不确定。",
        "不要编造论文中没有的信息。"
      ].join("\n")
    },
    { role: "user", content: buildPaperChatContext(paper) },
    ...chatHistory.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content || "") })),
    { role: "user", content: userContent }
  ];
}

function buildImageChatMessages(paper, chatHistory, message, attachments = []) {
  const imageParts = attachments
    .filter((item) => item?.imageDataUrl)
    .map((item) => ({ type: "image_url", image_url: { url: item.imageDataUrl } }));
  return [
    { role: "system", content: "你是科研图片理解助手，回答必须使用中文。优先依据当前图片和已解析卡片回答，不要编造。" },
    {
      role: "user",
      content: [
        { type: "text", text: buildPaperChatContext(paper) },
        { type: "image_url", image_url: { url: paper.imageDataUrl } }
      ]
    },
    ...chatHistory.map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content || "") })),
    {
      role: "user",
      content: imageParts.length
        ? [{ type: "text", text: `${String(message)}\n\n请结合我额外上传的图片一起回答。` }, ...imageParts]
        : String(message)
    }
  ];
}

async function repairJsonResponse({ provider, apiKey, model, rawContent }) {
  const result = await callChatWithRetry({
    provider,
    apiKey,
    model,
    temperature: 0,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: "你是 JSON 修复器。只输出一个合法 JSON 对象，不要解释，不要 Markdown。不要新增原文没有的信息，只修复语法、引号、逗号、转义和截断导致的格式问题。" },
      { role: "user", content: `请把下面内容修复为合法 JSON 对象：\n${String(rawContent || "").slice(0, 24000)}` }
    ]
  });
  if (!result.ok) return { ok: false, error: result.error };
  const parsed = parseJsonObject(result.content);
  if (!parsed.ok) return { ok: false, error: parsed.error, raw: result.content };
  return { ok: true, result: parsed.value, raw: result.content };
}

function parseJsonObject(content) {
  const raw = String(content || "").trim();
  const candidates = [raw, extractJsonObject(raw)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      if (candidate === candidates[candidates.length - 1]) return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: "没有找到 JSON 对象。" };
}

function extractJsonObject(text) {
  const value = String(text || "");
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return "";
  return value.slice(start, end + 1);
}

function normalizeEmbeddingEndpoint(value) {
  const url = new URL(String(value || "").trim());
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) {
    throw new Error("Embedding API 必须使用 HTTPS；本机服务可使用 HTTP。" );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/embeddings(?:\/multimodal)?$/i.test(url.pathname)) url.pathname += "/embeddings";
  return url.toString();
}

function isMultimodalEmbeddingEndpoint(endpoint) {
  try {
    return /\/embeddings\/multimodal\/?$/i.test(new URL(endpoint).pathname);
  } catch {
    return false;
  }
}

async function callMultimodalEmbedding({ endpoint, key, model, text }) {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          input: [{ type: "text", text }],
          encoding_format: "float"
        })
      });
      const bodyText = await response.text();
      if (!response.ok) {
        lastError = `Embedding 请求失败：${response.status} ${bodyText.slice(0, 1200)}`;
      } else {
        const data = safeJsonParse(bodyText);
        const vector = data?.data?.embedding;
        if (Array.isArray(vector) && vector.length) {
          return { ok: true, vector, model: data?.model || model, usage: data?.usage || null };
        }
        lastError = "Embedding 接口返回了无法识别的多模态向量数据。";
      }
    } catch (error) {
      lastError = `Embedding 请求失败：${error.message}`;
    }
    if (attempt < 3 && isRetryableError(lastError)) await sleep(700 * attempt);
    else break;
  }
  return { ok: false, error: lastError || "Embedding 请求失败。" };
}

async function createMultimodalEmbeddingVectors({ endpoint, key, model, values }) {
  const vectors = [];
  let responseModel = model;
  let promptTokens = 0;
  let totalTokens = 0;
  const concurrency = 4;
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const results = await Promise.all(values.slice(offset, offset + concurrency).map((text) => (
      callMultimodalEmbedding({ endpoint, key, model, text })
    )));
    const failure = results.find((result) => !result.ok);
    if (failure) return failure;
    results.forEach((result) => {
      vectors.push(result.vector);
      responseModel = result.model || responseModel;
      promptTokens += Number(result.usage?.prompt_tokens) || 0;
      totalTokens += Number(result.usage?.total_tokens) || 0;
    });
  }
  return {
    ok: true,
    vectors,
    model: responseModel,
    usage: promptTokens || totalTokens ? { prompt_tokens: promptTokens, total_tokens: totalTokens } : null
  };
}

function normalizePaperText(text) {
  return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractPdfTextWithPages(buffer) {
  if (!pdfJsModulePromise) pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsLib = await pdfJsModulePromise;
  const pageTexts = [];
  const standardFontDataUrl = pathToFileURL(path.join(__dirname, "..", "node_modules", "pdfjs-dist", "standard_fonts") + path.sep).href;
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    standardFontDataUrl
  });
  const document = await loadingTask.promise;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      let text = "";
      try {
        const pageData = await document.getPage(pageNumber);
        const content = await pageData.getTextContent();
        let lastY;
        for (const item of content.items || []) {
          const y = item?.transform?.[5];
          text += lastY === undefined || lastY === y ? String(item?.str || "") : `\n${String(item?.str || "")}`;
          if (item?.hasEOL) text += "\n";
          lastY = y;
        }
      } catch {
        text = "";
      }
      pageTexts.push(normalizePaperText(text));
    }
  } finally {
    await document.destroy();
  }

  let text = "";
  const pageTextOffsets = [];
  const pageCount = pageTexts.length;
  for (let index = 0; index < pageCount; index += 1) {
    const pageText = pageTexts[index] || "";
    if (text && pageText) text += "\n\n";
    const start = text.length;
    text += pageText;
    pageTextOffsets.push({ pageNumber: index + 1, start, end: text.length });
  }
  return { text: normalizePaperText(text), pageCount, pageTextOffsets };
}

function trimForAnalysis(text) {
  const normalized = normalizePaperText(text);
  const sections = extractUsefulSections(normalized);
  const source = sections.length >= 8000 ? sections : normalized;
  const maxChars = 52000;
  if (source.length <= maxChars) return source;
  return `${source.slice(0, 38000)}\n\n[...中间部分已截断...]\n\n${source.slice(-10000)}`;
}

function extractUsefulSections(text) {
  const value = String(text || "");
  const indexes = [
    searchIndex(value, /\babstract\b/i),
    searchIndex(value, /\b(1\.?\s*)?introduction\b/i),
    searchIndex(value, /\b(method|methodology|approach|proposed)\b/i),
    searchIndex(value, /\b(experiment|evaluation|results?)\b/i),
    searchIndex(value, /\b(conclusion|discussion)\b/i)
  ];
  const parts = [value.slice(0, 12000), ...indexes.map((index) => sliceAround(value, index, 10000))].filter(Boolean);
  return [...new Set(parts)].join("\n\n");
}

function buildPaperChatContext(paper) {
  const analysis = paper.analysis ? JSON.stringify(paper.analysis, null, 2) : "尚未完成 AI 解析。";
  const text = paper.kind === "image" ? "当前条目是图片，没有 PDF 原文。" : trimForChat(paper.text || "");
  return [
    `文件名：${paper.fileName || "unknown"}`,
    `标题：${paper.title || "unknown"}`,
    `类型：${paper.kind === "image" ? "图片" : "PDF"}`,
    `年份：${paper.year || "unknown"}`,
    `来源：${paper.venue || "unknown"}`,
    "",
    "已解析卡片：",
    analysis,
    "",
    "原文/说明：",
    text
  ].join("\n");
}

function trimForChat(text) {
  if (!text) return "无论文原文。";
  if (text.length <= 36000) return text;
  return `${text.slice(0, 26000)}\n\n[...中间部分已截断...]\n\n${text.slice(-8000)}`;
}

function buildExtractionPrompt(fileName, text) {
  return `
请从下面论文文本中抽取结构化信息。文件名：${fileName || "unknown"}

输出 JSON schema：
${commonSchemaText()}

要求：
1. 只输出合法 JSON 对象，不要 Markdown，不要代码块，不要解释性文字。
2. JSON key 保持英文，但内容值默认必须用简体中文表达。
3. title_en 必须是论文原始英文标题；title_zh 必须是中文译名；title 字段填 title_zh。
4. abstract_en 必须直接提取论文原文 Abstract，不要总结、不要改写；abstract_zh 是 abstract_en 的中文直译，不要扩写。
5. 没有明确证据的字段填 null 或空数组，不要编造。

论文文本：
${text}
`;
}

function buildImageExtractionPrompt(fileName) {
  return `
请分析这张科研图片或论文截图。文件名：${fileName || "unknown"}

输出 JSON schema：
${commonSchemaText()}

要求：
1. 只输出合法 JSON 对象，不要 Markdown。
2. 如果图片是论文页面/图表/截图，请提取标题、可见文字、图表表达的任务、方法、数据集、指标、主要结果、关键词。
3. 如果图片不是论文内容，也要用中文说明图片中可见的信息，无法判断的字段填 null 或空数组。
4. keywords 输出中文关键词。
`;
}

function commonSchemaText() {
  return `{
  "title": string | null,
  "title_zh": string | null,
  "title_en": string | null,
  "authors": string[],
  "year": number | null,
  "venue": string | null,
  "doi": string | null,
  "url": string | null,
  "abstract": string | null,
  "abstract_zh": string | null,
  "abstract_en": string | null,
  "venue_rank": {"type": "journal" | "conference" | "unknown", "label": string | null, "source": string | null, "confidence": "high" | "medium" | "low" | null},
  "motivation": {"problem_background": string | null, "research_gap": string | null, "why_it_matters": string | null},
  "contributions": string[],
  "method": {"method_name": string | null, "core_idea": string | null, "modules": string[], "pipeline": string | null},
  "datasets": string[],
  "metrics": string[],
  "main_results": string[],
  "limitations": string[],
  "keywords": string[],
  "task": string | null,
  "domain": string | null,
  "modality": string[],
  "writing_uses": string[],
  "confidence_notes": string[]
}`;
}

function imageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function defaultModel(provider) {
  return provider === "doubao" ? "doubao-1-5-vision-pro-32k" : "deepseek-chat";
}

function providerLabel(provider) {
  return provider === "doubao" ? "豆包/火山方舟" : "DeepSeek";
}

function isRetryableError(error) {
  const message = String(error || "");
  return /\b(429|500|502|503|504)\b/.test(message) || /Internal Server Error|timeout|ECONNRESET|network|fetch failed|没有返回内容/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function searchIndex(text, pattern) {
  const match = pattern.exec(text);
  return match ? match.index : -1;
}

function sliceAround(text, index, size) {
  if (index < 0) return "";
  const start = Math.max(0, index - Math.floor(size * 0.18));
  return text.slice(start, start + size);
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Final prompt overrides. Keep JSON keys stable, but force Chinese card content and short Chinese keywords.
function buildPaperAnalysisMessages(fileName, text) {
  return [
    {
      role: "system",
      content: [
        "You are a rigorous academic paper information extraction assistant.",
        "Use only the supplied paper text. Do not invent missing information.",
        "Return one strict JSON object only. Do not use Markdown or explanatory prose.",
        "All user-facing values must be Simplified Chinese unless the schema explicitly asks for original English.",
        "The keywords field must contain 5 to 10 short Simplified Chinese keyword phrases.",
        "Do not put English method names, full English phrases, sentences, explanations, or module descriptions in keywords.",
        "Acronyms may appear only inside a Chinese keyword when necessary, for example: 信任校准协同学习 (TCL).",
        "Every keyword must be complete and canonical: use balanced brackets, never add list numbers, and write L1 正则化 instead of 1正则化."
      ].join("\n")
    },
    { role: "user", content: buildExtractionPrompt(fileName, text) }
  ];
}

function buildImageAnalysisMessages(fileName, imageDataUrl) {
  return [
    {
      role: "system",
      content: [
        "You are a research image understanding assistant.",
        "Return one strict JSON object only. Do not use Markdown or explanatory prose.",
        "All user-facing values must be Simplified Chinese.",
        "The keywords field must contain short Simplified Chinese keyword phrases, not English sentences."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        { type: "text", text: buildImageExtractionPrompt(fileName) },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    }
  ];
}

function buildExtractionPrompt(fileName, text) {
  return `
Extract structured information from the paper text below.
File name: ${fileName || "unknown"}

Output JSON schema:
${commonSchemaText()}

Rules:
1. Output only a valid JSON object. No Markdown, no code fence, no commentary.
2. Keep JSON keys in English.
3. title_en must be the original English paper title.
4. title_zh must be a Simplified Chinese translation of the paper title.
5. title must equal title_zh.
6. abstract_en must be the original Abstract extracted from the paper. Do not summarize or rewrite it.
7. abstract_zh must be a faithful Simplified Chinese translation of abstract_en. Do not expand it.
8. Motivation, contribution, method, task, domain, writing_uses, confidence_notes and other readable card fields must be Simplified Chinese.
9. keywords must be 5 to 10 short Simplified Chinese keyword phrases. Each keyword should normally be 2 to 10 Chinese characters. Do not output English-only keywords. Do not output full sentences, explanations, numbered prefixes or incomplete brackets. Use canonical notation such as "L1 正则化", never "1正则化". If an acronym is necessary, put it after Chinese, for example "长尾识别", "信任校准协同学习 (TCL)", "知识蒸馏".
10. If there is no evidence for a field, use null or an empty array. Do not invent.

Paper text:
${text}
`;
}

function buildImageExtractionPrompt(fileName) {
  return `
Analyze this research image or paper screenshot.
File name: ${fileName || "unknown"}

Output JSON schema:
${commonSchemaText()}

Rules:
1. Output only a valid JSON object. No Markdown, no commentary.
2. Extract visible paper title, visible text, task, method, dataset, metric, result and keywords when possible.
3. All readable card fields must be Simplified Chinese.
4. keywords must be short Simplified Chinese keyword phrases. Do not output English-only keywords, full sentences, or explanations.
5. Unknown fields must be null or empty arrays.
`;
}
