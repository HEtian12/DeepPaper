(function initLibraryAi(root) {
  const STORAGE_KEY = "deeppaper.library-ai.v1";
  const MAX_MESSAGES = 40;
  const MAX_CANDIDATES = 30;

  const TERM_EXPANSIONS = [
    ["不平衡", ["长尾", "类别不均衡", "样本不均衡", "imbalanced", "long-tailed", "long tail"]],
    ["长尾", ["不平衡", "类别不均衡", "long-tailed", "long tail"]],
    ["知识蒸馏", ["蒸馏", "knowledge distillation", "teacher student", "教师学生"]],
    ["对比学习", ["contrastive learning"]],
    ["多模态", ["multimodal", "multi-modal"]],
    ["可解释", ["explainable", "interpretable", "interpretability"]],
    ["图神经网络", ["gnn", "graph neural network", "图网络"]],
    ["视觉问答", ["vqa", "visual question answering"]],
    ["抑郁", ["depression", "depressive"]],
    ["人脸", ["face", "facial"]],
    ["动作单元", ["action unit", "fau", "au"]],
    ["时序", ["temporal", "sequence", "序列"]],
    ["弱监督", ["weakly supervised", "weak supervision"]],
    ["半监督", ["semi-supervised", "semi supervised"]]
  ];

  function flattenValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(flattenValue).filter(Boolean).join("；");
    if (typeof value === "object") return Object.values(value).map(flattenValue).filter(Boolean).join("；");
    return String(value).replace(/\s+/g, " ").trim();
  }

  function normalizeSearchText(value) {
    return flattenValue(value)
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function uniqueStrings(values) {
    const seen = new Set();
    return values
      .map((value) => String(value || "").trim())
      .filter((value) => {
        const key = normalizeSearchText(value);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function parseKeywordValues(value) {
    if (Array.isArray(value)) return uniqueStrings(value.flatMap(parseKeywordValues));
    if (!value) return [];
    return uniqueStrings(String(value).split(/[,，、;；\n|]+/));
  }

  function extractLibraryAiTerms(query) {
    let text = String(query || "")
      .replace(/[？?！!。]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return [];

    text = text
      .replace(/^(?:请|麻烦)?(?:帮我|帮忙|给我|我想|能否|可以)?\s*(?:查找|寻找|找到|搜索|检索|筛选|推荐|看看|分析)?\s*/u, "")
      .replace(/^(?:有关|关于|涉及|同时涉及|同时包含|包含)\s*/u, "")
      .replace(/(?:(?:相关|有关)的?)?的?(?:论文|文章|文献|研究)(?:有哪些|有哪些呢|是什么|吗|呢)?\s*$/u, "")
      .trim();

    const stopWords = new Set([
      "有关", "关于", "涉及", "同时", "包含", "相关", "论文", "文章", "文献", "研究",
      "哪些", "什么", "一下", "帮我", "给我", "找到", "查找", "搜索", "检索", "推荐"
    ]);
    let parts = text
      .split(/(?:\s+(?:and|or)\s+)|(?:以及|并且|同时|还有|或者|和|与|及|或)|[,，、;；/]+/iu)
      .map((part) => part
        .replace(/^(?:有关|关于|涉及|包含|相关于?)\s*/u, "")
        .replace(/(?:(?:相关|有关)的?)?的?(?:论文|文章|文献|研究)$/u, "")
        .replace(/的$/u, "")
        .trim())
      .filter((part) => part.length > 1 && !stopWords.has(part));

    if (!parts.length && text.length > 1) parts = [text];
    return uniqueStrings(parts).slice(0, 10);
  }

  function termAliases(term) {
    const normalizedTerm = normalizeSearchText(term);
    const aliases = [term];
    TERM_EXPANSIONS.forEach(([key, values]) => {
      const normalizedKey = normalizeSearchText(key);
      if (normalizedTerm.includes(normalizedKey) || normalizedKey.includes(normalizedTerm)) {
        aliases.push(key, ...values);
      }
    });
    return uniqueStrings(aliases);
  }

  function buildLibraryCandidate(paper) {
    const analysis = paper?.analysis || {};
    const titleZh = paper?.titleZh || analysis.title_zh || analysis.title || paper?.title || "";
    const titleEn = paper?.titleEn || analysis.title_en || "";
    const keywords = uniqueStrings([
      ...parseKeywordValues(paper?.keywords),
      ...parseKeywordValues(analysis.keywords)
    ]).slice(0, 24);
    const motivation = flattenValue(analysis.motivation);
    const method = flattenValue(analysis.method);
    const contributions = flattenValue(analysis.contributions);
    const abstract = flattenValue(analysis.abstract_zh || analysis.abstract || analysis.abstract_en);
    const task = flattenValue(analysis.task);
    const domain = flattenValue(analysis.domain);
    const datasets = flattenValue(analysis.datasets);
    const results = flattenValue(analysis.main_results);
    const rankValue = paper?.venueRank || analysis.venue_rank || "";
    const rank = typeof rankValue === "object" ? flattenValue(rankValue.label) : flattenValue(rankValue);

    const candidate = {
      id: String(paper?.id || ""),
      titleZh,
      titleEn,
      year: paper?.year || analysis.year || "",
      venue: paper?.venue || analysis.venue || "",
      rank,
      keywords,
      abstract,
      motivation,
      method,
      contributions,
      task,
      domain,
      datasets,
      results,
      analyzed: Boolean(paper?.analysis),
      importedAt: paper?.importedAt || paper?.createdAt || "",
      matchedTerms: [],
      matchedFields: [],
      score: 0
    };

    candidate._fields = [
      { name: "关键词", weight: 12, text: keywords.join(" ") },
      { name: "标题", weight: 10, text: `${titleZh} ${titleEn}` },
      { name: "任务/领域", weight: 8, text: `${task} ${domain}` },
      { name: "方法", weight: 7, text: method },
      { name: "数据集", weight: 7, text: datasets },
      { name: "摘要", weight: 6, text: abstract },
      { name: "动机/贡献", weight: 5, text: `${motivation} ${contributions}` },
      { name: "结果", weight: 4, text: results },
      { name: "全文", weight: 2, text: flattenValue(paper?.text) }
    ].map((field) => ({ ...field, normalized: normalizeSearchText(field.text) }));
    return candidate;
  }

  function retrieveLibraryCandidates(paperList, query, limit = MAX_CANDIDATES) {
    const terms = extractLibraryAiTerms(query);
    const candidates = (Array.isArray(paperList) ? paperList : [])
      .map(buildLibraryCandidate)
      .filter((candidate) => candidate.id);

    candidates.forEach((candidate) => {
      const matchedTerms = [];
      const matchedFields = new Set();
      let score = 0;

      terms.forEach((term) => {
        let bestField = null;
        termAliases(term).forEach((alias) => {
          const normalizedAlias = normalizeSearchText(alias);
          if (!normalizedAlias) return;
          candidate._fields.forEach((field) => {
            if (!field.normalized.includes(normalizedAlias)) return;
            if (!bestField || field.weight > bestField.weight) bestField = field;
          });
        });
        if (!bestField) return;
        matchedTerms.push(term);
        matchedFields.add(bestField.name);
        score += bestField.weight;
      });

      const coverage = terms.length ? matchedTerms.length / terms.length : 0;
      score += matchedTerms.length * 5;
      if (terms.length > 1 && matchedTerms.length === terms.length) score += 24;
      else if (coverage >= 0.5) score += 8;
      if (candidate.analyzed && matchedTerms.length) score += 1;
      candidate.score = score;
      candidate.matchedTerms = matchedTerms;
      candidate.matchedFields = [...matchedFields];
    });

    const scored = candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score
        || Number(b.year || 0) - Number(a.year || 0)
        || String(b.importedAt).localeCompare(String(a.importedAt)));
    const fallback = candidates
      .filter((candidate) => candidate.analyzed)
      .sort((a, b) => Number(b.year || 0) - Number(a.year || 0)
        || String(b.importedAt).localeCompare(String(a.importedAt)));
    const source = scored.length ? scored : fallback;
    return source.slice(0, Math.max(1, Number(limit) || MAX_CANDIDATES));
  }

  function toApiCandidate(candidate) {
    return {
      id: candidate.id,
      titleZh: candidate.titleZh,
      titleEn: candidate.titleEn,
      year: candidate.year,
      venue: candidate.venue,
      rank: candidate.rank,
      keywords: candidate.keywords,
      abstract: candidate.abstract,
      motivation: candidate.motivation,
      method: candidate.method,
      contributions: candidate.contributions,
      task: candidate.task,
      domain: candidate.domain,
      datasets: candidate.datasets,
      results: candidate.results,
      matchedTerms: candidate.matchedTerms
    };
  }

  function toLocalMatch(candidate) {
    return {
      paperId: candidate.id,
      relevance: candidate.matchedTerms.length ? "中" : "低",
      reason: candidate.matchedTerms.length
        ? `本地检索命中：${candidate.matchedTerms.join("、")}；主要命中字段：${candidate.matchedFields.join("、") || "全文"}。`
        : "本地召回的已解析候选，需结合论文内容进一步判断。"
    };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      extractLibraryAiTerms,
      buildLibraryCandidate,
      retrieveLibraryCandidates,
      toApiCandidate,
      toLocalMatch
    };
    return;
  }

  let panelState = loadPanelState();
  let isSending = false;

  function loadPanelState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_MESSAGES) : []
      };
    } catch (_error) {
      return { messages: [] };
    }
  }

  function savePanelState() {
    panelState.messages = panelState.messages.slice(-MAX_MESSAGES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(panelState));
  }

  function html(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function createUi() {
    if (document.querySelector("#libraryAiPanel")) return;
    const corpusButton = document.querySelector("#openCorpusBtn");
    const trigger = document.createElement("button");
    trigger.id = "openLibraryAiBtn";
    trigger.className = "secondary";
    trigger.type = "button";
    trigger.textContent = "全库 AI";
    corpusButton?.insertAdjacentElement("afterend", trigger);

    const panel = document.createElement("section");
    panel.id = "libraryAiPanel";
    panel.className = "library-ai-panel hidden";
    panel.innerHTML = `
      <header class="library-ai-header">
        <div>
          <p class="eyebrow">全部本地论文</p>
          <h2>全库 AI</h2>
        </div>
        <div class="library-ai-header-actions">
          <button id="clearLibraryAiBtn" class="secondary small-btn" type="button">清空</button>
          <button id="closeLibraryAiBtn" class="secondary small-btn" type="button">关闭</button>
        </div>
      </header>
      <div class="library-ai-scope">
        先在本地扫描全库，再由当前接口综合判断。不会上传整篇 PDF。
      </div>
      <div id="libraryAiMessages" class="library-ai-messages"></div>
      <div class="library-ai-composer">
        <div class="library-ai-examples">
          <button type="button" data-library-ai-example="帮我找到同时涉及长尾分布和知识蒸馏的论文">长尾分布 + 知识蒸馏</button>
          <button type="button" data-library-ai-example="哪些论文适合作为方法对比的基线？">寻找方法基线</button>
        </div>
        <textarea id="libraryAiInput" rows="4" placeholder="例如：帮我找到同时涉及长尾分布和知识蒸馏的论文。Enter 发送，Shift + Enter 换行"></textarea>
        <button id="sendLibraryAiBtn" class="primary" type="button">检索并询问 AI</button>
      </div>
    `;
    document.body.appendChild(panel);

    trigger.addEventListener("click", openPanel);
    panel.querySelector("#closeLibraryAiBtn").addEventListener("click", closePanel);
    panel.querySelector("#clearLibraryAiBtn").addEventListener("click", clearHistory);
    panel.querySelector("#sendLibraryAiBtn").addEventListener("click", sendQuestion);
    panel.querySelector("#libraryAiInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendQuestion();
      }
    });
    panel.addEventListener("click", handlePanelClick);
    renderMessages();
  }

  function openPanel() {
    document.querySelector("#libraryAiPanel")?.classList.remove("hidden");
    document.body.classList.add("library-ai-open");
    renderMessages();
    requestAnimationFrame(() => document.querySelector("#libraryAiInput")?.focus());
  }

  function closePanel() {
    document.querySelector("#libraryAiPanel")?.classList.add("hidden");
    document.body.classList.remove("library-ai-open");
  }

  function clearHistory() {
    if (panelState.messages.length && !confirm("确认清空全库 AI 的对话记录吗？")) return;
    panelState.messages = [];
    savePanelState();
    renderMessages();
  }

  function handlePanelClick(event) {
    const example = event.target.closest("[data-library-ai-example]");
    if (example) {
      const input = document.querySelector("#libraryAiInput");
      input.value = example.dataset.libraryAiExample;
      input.focus();
      return;
    }
    const followUp = event.target.closest("[data-library-ai-follow-up]");
    if (followUp) {
      const input = document.querySelector("#libraryAiInput");
      input.value = followUp.dataset.libraryAiFollowUp;
      input.focus();
      return;
    }
    const matchToggle = event.target.closest("[data-library-ai-toggle-matches]");
    if (matchToggle) {
      const message = panelState.messages.find((item) => item.id === matchToggle.dataset.libraryAiToggleMatches);
      if (message) {
        message.showAllMatches = !message.showAllMatches;
        savePanelState();
        renderMessages();
      }
      return;
    }
    const paperButton = event.target.closest("[data-library-ai-paper]");
    if (paperButton) openPaperFromResult(paperButton.dataset.libraryAiPaper);
  }

  function renderMessages() {
    const container = document.querySelector("#libraryAiMessages");
    if (!container) return;
    if (!panelState.messages.length) {
      container.innerHTML = `
        <div class="library-ai-empty">
          <strong>可以直接描述研究条件</strong>
          <p>例如“同时与不平衡学习、知识蒸馏相关”，系统会扫描全部论文，而不是只匹配当前词条。</p>
        </div>
      `;
      return;
    }
    container.innerHTML = panelState.messages.map(renderMessage).join("");
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function renderMessage(message) {
    if (message.role === "user") {
      return `<article class="library-ai-message user"><span>我</span><p>${html(message.content)}</p></article>`;
    }
    const aiMatches = Array.isArray(message.matches) ? message.matches : [];
    const localMatches = Array.isArray(message.localMatches) ? message.localMatches : [];
    const visibleMatches = message.showAllMatches && localMatches.length ? localMatches : aiMatches;
    const resultRows = visibleMatches.map((match) => {
      const paper = typeof papers !== "undefined" ? papers.find((item) => item.id === match.paperId) : null;
      if (!paper) return "";
      const title = typeof displayTitle === "function"
        ? displayTitle(paper)
        : paper.titleZh || paper.title || paper.titleEn || "未命名论文";
      const meta = [paper.year, paper.venue, match.relevance ? `${match.relevance}相关` : ""].filter(Boolean).join(" | ");
      const keywords = uniqueStrings([...(paper.keywords || []), ...(paper.analysis?.keywords || [])]).slice(0, 6);
      return `
        <div class="library-ai-result">
          <div class="library-ai-result-main">
            <strong>${html(title)}</strong>
            <span>${html(meta)}</span>
            ${keywords.length ? `<div class="library-ai-result-tags">${keywords.map((item) => `<i>${html(item)}</i>`).join("")}</div>` : ""}
            ${match.reason ? `<p>${html(match.reason)}</p>` : ""}
          </div>
          <button class="secondary small-btn" type="button" data-library-ai-paper="${html(paper.id)}">查看论文</button>
        </div>
      `;
    }).join("");
    const matchToggle = localMatches.length > aiMatches.length
      ? `<button class="secondary small-btn library-ai-match-toggle" type="button" data-library-ai-toggle-matches="${html(message.id)}">${message.showAllMatches ? `收起，仅看 AI 精选（${aiMatches.length}）` : `查看全部本地匹配（${localMatches.length}）`}</button>`
      : "";
    const followUps = (message.followUps || []).length
      ? `<div class="library-ai-follow-ups">${message.followUps.map((item) => `
          <button type="button" data-library-ai-follow-up="${html(item)}">${html(item)}</button>
        `).join("")}</div>`
      : "";
    const scanInfo = message.candidateCount
      ? `<div class="library-ai-scan-info">本地扫描 ${message.libraryCount || 0} 篇，匹配 ${message.localMatchCount ?? localMatches.length} 篇，交给 AI 判断前 ${message.candidateCount} 篇候选</div>`
      : "";
    return `
      <article class="library-ai-message assistant ${message.error ? "error" : ""}">
        <span>${html(message.provider || "AI")}</span>
        <div>
          <p>${html(message.content || "")}</p>
          ${scanInfo}
          ${resultRows ? `<div class="library-ai-results">${resultRows}</div>` : ""}
          ${matchToggle}
          ${followUps}
        </div>
      </article>
    `;
  }

  async function sendQuestion() {
    if (isSending) return;
    const input = document.querySelector("#libraryAiInput");
    const message = input?.value.trim();
    if (!message) return;

    const library = typeof papers !== "undefined" ? papers : [];
    if (!library.length) {
      if (typeof setStatus === "function") setStatus("文献库为空，先导入论文后再使用全库 AI。", true);
      return;
    }
    const config = typeof currentConfig === "function" ? currentConfig() : {};
    const allLocalCandidates = retrieveLibraryCandidates(library, message, library.length);
    const candidates = allLocalCandidates.slice(0, MAX_CANDIDATES);
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      at: new Date().toISOString()
    };
    panelState.messages.push(userMessage);
    input.value = "";
    isSending = true;
    setSendingUi(true);
    savePanelState();
    renderMessages();

    const history = panelState.messages
      .slice(0, -1)
      .filter((item) => item.role === "user" || item.role === "assistant")
      .slice(-6)
      .map((item) => ({ role: item.role, content: item.content }));

    let response;
    try {
      response = await root.deepPaper.chatWithLibrary({
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        message,
        history,
        candidates: candidates.map(toApiCandidate)
      });
    } catch (error) {
      response = { ok: false, error: error.message };
    }

    const localMatches = allLocalCandidates.map(toLocalMatch);
    const fallbackMatches = localMatches.slice(0, 10);
    const provider = typeof providerDisplayName === "function"
      ? providerDisplayName(config.provider)
      : config.provider === "doubao" ? "豆包/火山方舟" : "DeepSeek";

    if (response?.ok) {
      const aiMatches = Array.isArray(response.result?.matches) && response.result.matches.length
        ? response.result.matches
        : fallbackMatches;
      panelState.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        provider,
        content: response.result?.answer || "已完成全库检索。",
        matches: aiMatches,
        localMatches,
        localMatchCount: localMatches.length,
        showAllMatches: false,
        followUps: response.result?.followUps || [],
        candidateCount: candidates.length,
        libraryCount: library.length,
        at: new Date().toISOString()
      });
      if (typeof setStatus === "function") setStatus(`全库 AI 已扫描 ${library.length} 篇论文并返回结果。`);
    } else {
      panelState.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        provider: "本地检索",
        content: `AI 综合判断失败：${response?.error || "未知错误"}。下面先显示本地召回结果。`,
        matches: fallbackMatches,
        localMatches,
        localMatchCount: localMatches.length,
        showAllMatches: false,
        followUps: [],
        candidateCount: candidates.length,
        libraryCount: library.length,
        error: true,
        at: new Date().toISOString()
      });
      if (typeof setStatus === "function") setStatus(`全库 AI 请求失败，已保留本地候选：${response?.error || "未知错误"}`, true);
    }

    isSending = false;
    setSendingUi(false);
    savePanelState();
    renderMessages();
  }

  function setSendingUi(sending) {
    const button = document.querySelector("#sendLibraryAiBtn");
    const input = document.querySelector("#libraryAiInput");
    if (button) {
      button.disabled = sending;
      button.textContent = sending ? "正在扫描并分析..." : "检索并询问 AI";
    }
    if (input) input.disabled = sending;
  }

  function openPaperFromResult(paperId) {
    if (typeof papers === "undefined" || typeof state === "undefined" || typeof render !== "function") return;
    const paper = papers.find((item) => item.id === paperId);
    if (!paper) return;
    state.selectedId = paperId;
    state.detailTab = "analysis";
    state.activeCollectionId = "";
    state.fullTextQuery = "";
    state.keywordQuery = "";
    if (typeof els !== "undefined") {
      if (els.fullTextSearchInput) els.fullTextSearchInput.value = "";
      if (els.keywordSearchInput) els.keywordSearchInput.value = "";
    }
    closePanel();
    render();
    requestAnimationFrame(() => {
      document.querySelector(".paper-card.active")?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function exportState() {
    return JSON.parse(JSON.stringify(panelState));
  }

  function importState(value) {
    if (!value || !Array.isArray(value.messages)) return;
    panelState = { messages: value.messages.slice(-MAX_MESSAGES) };
    savePanelState();
    renderMessages();
  }

  root.deepPaperLibraryAi = {
    retrieveCandidates: retrieveLibraryCandidates,
    extractTerms: extractLibraryAiTerms,
    termAliases,
    open: openPanel,
    exportState,
    importState
  };
  createUi();
})(globalThis);
