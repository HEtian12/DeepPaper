(function initDeepPaperAgent(root) {
  const STORAGE_KEY = "deeppaper.agent.v1";
  const MAX_TASKS = 12;
  const MAX_STEPS = 6;
  const TOOL_LABELS = {
    search_library: "检索全库",
    search_passages: "检索正文段落",
    read_passages: "读取段落上下文",
    read_papers: "读取论文",
    compare_papers: "比较论文",
    build_evidence_map: "构建证据图谱",
    propose_collection: "准备合集方案"
  };

  function flattenValue(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(flattenValue).filter(Boolean).join("；");
    if (typeof value === "object") return Object.values(value).map(flattenValue).filter(Boolean).join("；");
    return String(value).replace(/\s+/g, " ").trim();
  }

  function uniqueIds(value, limit = 12) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
  }

  function clip(value, limit) {
    return flattenValue(value).slice(0, limit);
  }

  function paperTitle(paper) {
    const analysis = paper?.analysis || {};
    return paper?.titleZh || analysis.title_zh || paper?.title || analysis.title || paper?.titleEn || analysis.title_en || "未命名论文";
  }

  function compactPaperForAgent(paper, sections = []) {
    const analysis = paper?.analysis || {};
    const requested = new Set(Array.isArray(sections) && sections.length ? sections : [
      "metadata", "keywords", "abstract", "motivation", "method", "contributions", "results"
    ]);
    const result = {
      paper_id: String(paper?.id || ""),
      title: paperTitle(paper)
    };
    if (requested.has("metadata")) {
      result.title_en = clip(paper?.titleEn || analysis.title_en, 240);
      result.year = paper?.year || analysis.year || "";
      result.venue = clip(paper?.venue || analysis.venue, 180);
      result.venue_rank = clip(paper?.venueRank?.label || paper?.venueRank || analysis.venue_rank?.label || analysis.venue_rank, 100);
    }
    if (requested.has("keywords")) result.keywords = [...new Set([...(paper?.keywords || []), ...(analysis.keywords || [])])].slice(0, 18);
    if (requested.has("abstract")) result.abstract = clip(analysis.abstract_zh || analysis.abstract || analysis.abstract_en, 900);
    if (requested.has("motivation")) result.motivation = clip(analysis.motivation, 650);
    if (requested.has("method")) result.method = clip(analysis.method, 900);
    if (requested.has("contributions")) result.contributions = clip(analysis.contributions, 650);
    if (requested.has("results")) result.results = clip(analysis.main_results, 500);
    return result;
  }

  function evidenceMapEntry(paper) {
    const analysis = paper?.analysis || {};
    const motivation = analysis.motivation || {};
    const method = analysis.method || {};
    return {
      paper_id: String(paper?.id || ""),
      title: paperTitle(paper),
      problem: clip(motivation.problem_background || motivation.research_gap || motivation, 700),
      method_name: clip(method.method_name, 180),
      method: clip(method.core_idea || method.pipeline || method, 1000),
      datasets: (Array.isArray(analysis.datasets) ? analysis.datasets : []).slice(0, 12).map((item) => clip(item, 100)),
      metrics: (Array.isArray(analysis.metrics) ? analysis.metrics : []).slice(0, 12).map((item) => clip(item, 100)),
      results: (Array.isArray(analysis.main_results) ? analysis.main_results : [analysis.main_results]).filter(Boolean).slice(0, 8).map((item) => clip(item, 500)),
      limitations: (Array.isArray(analysis.limitations) ? analysis.limitations : [analysis.limitations]).filter(Boolean).slice(0, 8).map((item) => clip(item, 500)),
      keywords: [...new Set([...(paper?.keywords || []), ...(analysis.keywords || [])])].slice(0, 16)
    };
  }

  async function executeLocalTool(tool, paperList, retrieveCandidates, ragApi = null, retrievalContext = {}) {
    const name = String(tool?.name || "");
    const args = tool?.arguments && typeof tool.arguments === "object" ? tool.arguments : {};
    const library = Array.isArray(paperList) ? paperList : [];

    if (name === "search_library") {
      const query = String(args.query || "").trim();
      const limit = Math.min(30, Math.max(3, Number(args.limit) || 15));
      if (!query) return { ok: false, error: "检索词为空。" };
      const candidates = retrieveCandidates(library, query, limit);
      return {
        ok: true,
        summary: `扫描 ${library.length} 篇论文，召回 ${candidates.length} 篇候选。`,
        papers: candidates.map((candidate) => ({
          paper_id: candidate.id,
          title: candidate.titleZh || candidate.titleEn || "未命名论文",
          year: candidate.year,
          venue: candidate.venue,
          rank: candidate.rank,
          keywords: candidate.keywords.slice(0, 8),
          matched_terms: candidate.matchedTerms,
          matched_fields: candidate.matchedFields,
          abstract_hint: clip(candidate.abstract, 280)
        }))
      };
    }

    if (name === "read_papers") {
      const ids = uniqueIds(args.paper_ids, 6);
      const selected = ids.map((id) => library.find((paper) => String(paper.id) === id)).filter(Boolean);
      return {
        ok: true,
        summary: `读取 ${selected.length} 篇论文的结构化解析。`,
        papers: selected.map((paper) => compactPaperForAgent(paper, args.sections))
      };
    }

    if (name === "search_passages") {
      const query = String(args.query || "").trim();
      const limit = Math.min(20, Math.max(3, Number(args.limit) || 12));
      if (!query) return { ok: false, error: "段落检索词为空。" };
      if (!ragApi?.buildPassageIndex || !ragApi?.searchPassages) return { ok: false, error: "段落 RAG 模块未加载。" };
      const candidates = retrieveCandidates(library, query, 12);
      const candidateIds = new Set(candidates.map((candidate) => String(candidate.id)));
      const candidatePapers = library.filter((paper) => candidateIds.has(String(paper.id)));
      const hydration = typeof ragApi.ensurePageMaps === "function"
        ? await ragApi.ensurePageMaps(candidatePapers)
        : { updated: 0, attempted: 0 };
      const index = ragApi.buildPassageIndex(library);
      const helpers = {
        extractTerms: ragApi.extractTerms,
        termAliases: ragApi.termAliases
      };
      let passages = ragApi.searchPassages(index, query, limit, helpers);
      let retrievalMode = "keyword";
      let vectorCoverage = 0;
      let embeddingWarning = "";
      const embeddingConfig = retrievalContext.embeddingConfig || {};
      const vectorStore = retrievalContext.vectorStore;
      if (embeddingConfig.embeddingEnabled && vectorStore?.getVectorMap && ragApi.searchPassagesHybrid) {
        try {
          const vectorMap = await vectorStore.getVectorMap(index.passages, embeddingConfig);
          vectorCoverage = vectorMap.size;
          if (vectorMap.size && typeof retrievalContext.createEmbeddings === "function") {
            const queryResult = await retrievalContext.createEmbeddings([query]);
            if (!queryResult?.ok) throw new Error(queryResult?.error || "查询向量生成失败。" );
            passages = ragApi.searchPassagesHybrid(index, query, queryResult.vectors?.[0], vectorMap, limit, helpers);
            retrievalMode = passages.some((passage) => passage.retrievalMode === "hybrid") ? "hybrid" : "keyword";
          } else {
            embeddingWarning = "语义索引尚未建立，本次使用关键词检索。";
          }
        } catch (error) {
          embeddingWarning = `语义检索不可用，本次已回退关键词检索：${error.message}`;
        }
      }
      const modeLabel = retrievalMode === "hybrid" ? "关键词 + 向量混合检索并重排" : "关键词检索";
      return {
        ok: true,
        summary: `对全库 ${index.passages.length} 个段落执行${modeLabel}，召回 ${passages.length} 段${vectorCoverage ? `（向量覆盖 ${vectorCoverage} 段）` : ""}${hydration.updated ? `，并补全 ${hydration.updated} 篇的精确页码` : ""}。${embeddingWarning}`,
        pageMapsUpdated: hydration.updated,
        retrievalMode,
        vectorCoverage,
        embeddingWarning,
        passages: passages.map((passage) => ({
          passage_id: passage.passageId,
          paper_id: passage.paperId,
          title: passage.title,
          section: passage.section || "",
          page_number: passage.pageNumber,
          estimated_page: passage.estimatedPage,
          matched_terms: passage.matchedTerms,
          retrieval_mode: passage.retrievalMode || retrievalMode,
          lexical_rank: passage.lexicalRank || null,
          semantic_rank: passage.semanticRank || null,
          semantic_score: Number.isFinite(passage.semanticScore) ? Number(passage.semanticScore.toFixed(4)) : null,
          hybrid_score: Number.isFinite(passage.hybridScore) ? passage.hybridScore : null,
          text: clip(passage.text, 1000)
        }))
      };
    }

    if (name === "read_passages") {
      if (!ragApi?.buildPassageIndex || !ragApi?.readPassages) return { ok: false, error: "段落 RAG 模块未加载。" };
      const ids = uniqueIds(args.passage_ids, 8);
      const paperIds = new Set(ids.map((id) => id.split(":rag:")[0]));
      const selectedPapers = library.filter((paper) => paperIds.has(String(paper.id)));
      const index = ragApi.buildPassageIndex(selectedPapers);
      const passages = ragApi.readPassages(index, ids, 1);
      return {
        ok: true,
        summary: `读取 ${passages.length} 个段落及其相邻上下文。`,
        passages: passages.map((passage) => ({
          passage_id: passage.passageId,
          paper_id: passage.paperId,
          title: passage.title,
          section: passage.section || "",
          page_number: passage.pageNumber,
          estimated_page: passage.estimatedPage,
          text: clip(passage.text, 1000),
          context: clip(passage.context, 2400)
        }))
      };
    }

    if (name === "compare_papers") {
      const ids = uniqueIds(args.paper_ids, 6);
      const selected = ids.map((id) => library.find((paper) => String(paper.id) === id)).filter(Boolean);
      return {
        ok: true,
        summary: `准备 ${selected.length} 篇论文的对比材料，关注点：${clip(args.focus || "综合比较", 120)}。`,
        focus: clip(args.focus || "综合比较", 160),
        papers: selected.map((paper) => compactPaperForAgent(paper))
      };
    }

    if (name === "build_evidence_map") {
      const ids = uniqueIds(args.paper_ids, 12);
      const selected = ids.map((id) => library.find((paper) => String(paper.id) === id)).filter(Boolean);
      const entries = selected.map(evidenceMapEntry);
      const relations = [];
      for (let left = 0; left < entries.length; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          const sharedDatasets = entries[left].datasets.filter((item) => entries[right].datasets.includes(item));
          const sharedKeywords = entries[left].keywords.filter((item) => entries[right].keywords.includes(item)).slice(0, 6);
          if (sharedDatasets.length || sharedKeywords.length) {
            relations.push({
              source: entries[left].paper_id,
              target: entries[right].paper_id,
              shared_datasets: sharedDatasets,
              shared_topics: sharedKeywords
            });
          }
        }
      }
      return {
        ok: Boolean(entries.length),
        summary: entries.length ? `已构建 ${entries.length} 篇论文的证据图谱，识别 ${relations.length} 组显式关联。` : "没有找到可构建证据图谱的论文。",
        evidenceMap: { papers: entries, relations },
        papers: entries.map((entry) => ({ paper_id: entry.paper_id, title: entry.title }))
      };
    }

    if (name === "propose_collection") {
      const ids = uniqueIds(args.paper_ids, 30).filter((id) => library.some((paper) => String(paper.id) === id));
      const proposal = {
        name: clip(args.name || "Agent 整理", 60),
        paperIds: ids,
        rationale: clip(args.rationale, 600),
        status: "pending"
      };
      return {
        ok: Boolean(ids.length),
        summary: ids.length ? `已准备合集“${proposal.name}”，包含 ${ids.length} 篇论文，等待用户确认。` : "合集方案中没有有效论文。",
        proposal
      };
    }

    return { ok: false, error: `不支持的本地工具：${name}` };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { uniqueIds, compactPaperForAgent, executeLocalTool };
    return;
  }

  let agentState = loadState();
  let activeRunToken = 0;
  let semanticIndexToken = 0;
  let semanticIndexBusy = false;

  function loadState() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const tasks = (Array.isArray(value.tasks) ? value.tasks : []).slice(-MAX_TASKS).map((task) => task?.status === "running"
        ? { ...task, status: "stopped", transcript: [], evidence: [] }
        : task);
      const requestedActiveId = value.activeTaskId;
      return {
        tasks,
        activeTaskId: tasks.some((task) => task?.id === requestedActiveId) ? requestedActiveId : tasks.at(-1)?.id || null
      };
    } catch (_error) {
      return { tasks: [], activeTaskId: null };
    }
  }

  function saveState() {
    agentState.tasks = agentState.tasks.slice(-MAX_TASKS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(agentState));
  }

  function activeTask() {
    return agentState.tasks.find((task) => task.id === agentState.activeTaskId) || null;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function createUi() {
    if (document.querySelector("#deepPaperAgentPanel")) return;
    const anchor = document.querySelector("#openLibraryAiBtn") || document.querySelector("#openCorpusBtn");
    const trigger = document.createElement("button");
    trigger.id = "openDeepPaperAgentBtn";
    trigger.className = "secondary agent-trigger";
    trigger.type = "button";
    trigger.textContent = "文献 Agent";
    anchor?.insertAdjacentElement("afterend", trigger);

    const panel = document.createElement("section");
    panel.id = "deepPaperAgentPanel";
    panel.className = "agent-panel hidden";
    panel.innerHTML = `
      <header class="agent-header">
        <div><p class="eyebrow">可调用本地文献工具</p><h2>文献 Agent</h2></div>
        <div class="agent-header-actions">
          <button id="agentNewTaskBtn" class="secondary small-btn" type="button">新任务</button>
          <button id="agentClearBtn" class="secondary small-btn" type="button">清空</button>
          <button id="agentCloseBtn" class="secondary small-btn" type="button">关闭</button>
        </div>
      </header>
      <div class="agent-safety">
        <div><strong id="agentRetrievalMode">段落 RAG 已启用</strong><span id="agentSemanticStatus">正在检查语义索引...</span></div>
        <button id="agentBuildIndexBtn" class="secondary small-btn" type="button">更新语义索引</button>
      </div>
      <div class="agent-history-row"><label for="agentTaskSelect">任务记录</label><select id="agentTaskSelect"></select></div>
      <div id="agentContent" class="agent-content"></div>
      <div class="agent-composer">
        <div class="agent-examples">
          <button type="button" data-agent-example="找出同时涉及长尾识别和知识蒸馏的论文，比较方法差异">检索并比较</button>
          <button type="button" data-agent-example="找出适合作为我的长尾识别方法基线的论文，并说明理由">寻找 Baseline</button>
          <button type="button" data-agent-example="分析长尾识别论文的方法、数据集和局限，并基于原文证据寻找尚未充分研究的问题">发现研究空白</button>
          <button type="button" data-agent-example="整理与多模态抑郁识别相关的论文，并提出一个合集方案">整理为合集</button>
        </div>
        <textarea id="agentGoalInput" rows="4" placeholder="描述一个任务。Enter 执行，Shift + Enter 换行"></textarea>
        <div class="agent-composer-actions">
          <button id="agentStopBtn" class="secondary hidden" type="button">停止</button>
          <button id="agentRunBtn" class="primary" type="button">开始执行</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    trigger.addEventListener("click", openPanel);
    panel.querySelector("#agentCloseBtn").addEventListener("click", closePanel);
    panel.querySelector("#agentNewTaskBtn").addEventListener("click", newTask);
    panel.querySelector("#agentClearBtn").addEventListener("click", clearTasks);
    panel.querySelector("#agentRunBtn").addEventListener("click", startTask);
    panel.querySelector("#agentStopBtn").addEventListener("click", stopTask);
    panel.querySelector("#agentBuildIndexBtn").addEventListener("click", buildSemanticIndex);
    panel.querySelector("#agentGoalInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        startTask();
      }
    });
    panel.querySelector("#agentTaskSelect").addEventListener("change", (event) => {
      agentState.activeTaskId = event.target.value;
      saveState();
      renderAgent();
    });
    panel.addEventListener("click", handleClick);
    document.querySelector("#libraryAiPanel")?.classList.add("hidden");
    renderAgent();
    refreshSemanticIndexStatus();
  }

  function openPanel() {
    document.querySelector("#deepPaperAgentPanel")?.classList.remove("hidden");
    renderAgent();
    refreshSemanticIndexStatus();
    requestAnimationFrame(() => document.querySelector("#agentGoalInput")?.focus());
  }

  function closePanel() {
    document.querySelector("#deepPaperAgentPanel")?.classList.add("hidden");
  }

  function newTask() {
    agentState.activeTaskId = null;
    saveState();
    renderAgent();
    document.querySelector("#agentGoalInput")?.focus();
  }

  function clearTasks() {
    if (agentState.tasks.length && !confirm("确认清空文献 Agent 的任务记录吗？")) return;
    stopTask();
    agentState = { tasks: [], activeTaskId: null };
    saveState();
    renderAgent();
  }

  function stopTask() {
    activeRunToken += 1;
    const task = activeTask();
    if (task?.status === "running") {
      task.status = "stopped";
      task.transcript = [];
      task.evidence = [];
      task.events.push({ type: "notice", text: "任务已停止。" });
      saveState();
    }
    setRunning(false);
    renderAgent();
  }

  function handleClick(event) {
    const example = event.target.closest("[data-agent-example]");
    if (example) {
      const input = document.querySelector("#agentGoalInput");
      input.value = example.dataset.agentExample;
      input.focus();
      return;
    }
    const followUp = event.target.closest("[data-agent-follow-up]");
    if (followUp) {
      const input = document.querySelector("#agentGoalInput");
      input.value = followUp.dataset.agentFollowUp;
      input.focus();
      return;
    }
    const paperButton = event.target.closest("[data-agent-paper]");
    if (paperButton) openPaper(paperButton.dataset.agentPaper, Number(paperButton.dataset.agentPage) || 0);
    const confirmButton = event.target.closest("[data-agent-confirm-proposal]");
    if (confirmButton) applyProposal(confirmButton.dataset.agentConfirmProposal);
    const rejectButton = event.target.closest("[data-agent-reject-proposal]");
    if (rejectButton) rejectProposal(rejectButton.dataset.agentRejectProposal);
  }

  function activeEmbeddingConfig() {
    return typeof currentConfig === "function" ? currentConfig() : {};
  }

  function embeddingConfigured(config) {
    return Boolean(config?.embeddingEnabled
      && config?.embeddingBaseUrl
      && config?.embeddingModel
      && (config?.embeddingApiKey || config?.apiKey));
  }

  function cleaningSummary(index) {
    const stats = index?.cleaningStats || {};
    const parts = [];
    if (stats.repairedHyphenations) parts.push(`修复断词 ${stats.repairedHyphenations} 处`);
    if (stats.removedHeaderFooterLines) parts.push(`过滤页眉页脚 ${stats.removedHeaderFooterLines} 行`);
    if (stats.removedPageNumberLines) parts.push(`过滤页码 ${stats.removedPageNumberLines} 行`);
    if (stats.duplicatePassages) parts.push(`发现重复段落 ${stats.duplicatePassages} 个`);
    return parts.length ? `清洗 v${index.cleaningVersion || 1}：${parts.join("，")}` : `清洗 v${index?.cleaningVersion || 1}：未发现可自动清理的版面噪声`;
  }

  async function createEmbeddingVectors(texts, config = activeEmbeddingConfig()) {
    if (typeof root.deepPaper?.createEmbeddings !== "function") return { ok: false, error: "Embedding IPC 未加载。" };
    return root.deepPaper.createEmbeddings({
      embeddingBaseUrl: config.embeddingBaseUrl,
      embeddingApiKey: config.embeddingApiKey,
      apiKey: config.apiKey,
      embeddingModel: config.embeddingModel,
      input: texts
    });
  }

  async function refreshSemanticIndexStatus() {
    const strong = document.querySelector("#agentRetrievalMode");
    const status = document.querySelector("#agentSemanticStatus");
    const button = document.querySelector("#agentBuildIndexBtn");
    if (!strong || !status || !button || typeof papers === "undefined") return;
    const token = ++semanticIndexToken;
    const config = activeEmbeddingConfig();
    const ragApi = root.deepPaperRag;
    const vectorStore = root.deepPaperVectorStore;
    button.disabled = semanticIndexBusy;
    button.textContent = semanticIndexBusy ? "正在建立..." : "更新语义索引";
    if (!config.embeddingEnabled) {
      strong.textContent = "关键词段落 RAG";
      status.textContent = "可在当前接口的编辑页中启用 Embedding。";
      return;
    }
    if (!embeddingConfigured(config)) {
      strong.textContent = "Embedding 配置不完整";
      status.textContent = "请在当前接口中填写 API 地址、模型和 API Key。";
      return;
    }
    if (!ragApi?.buildPassageIndex || !vectorStore?.getStatus) {
      strong.textContent = "语义检索模块未加载";
      status.textContent = "请重启软件后重试。";
      return;
    }
    try {
      const index = ragApi.buildPassageIndex(papers);
      const result = await vectorStore.getStatus(index.passages, config);
      if (token !== semanticIndexToken || semanticIndexBusy) return;
      strong.textContent = result.indexed === result.total && result.total ? "混合 RAG 已就绪" : "混合 RAG 待更新";
      status.textContent = result.total
        ? `向量覆盖 ${result.indexed}/${result.total} 个段落${result.dimension ? `，${result.dimension} 维` : ""}。${cleaningSummary(index)}。`
        : "文献库中暂时没有可索引的正文。";
    } catch (error) {
      if (token !== semanticIndexToken) return;
      strong.textContent = "语义索引不可用";
      status.textContent = error.message;
    }
  }

  async function buildSemanticIndex() {
    if (semanticIndexBusy || typeof papers === "undefined") return;
    const config = activeEmbeddingConfig();
    if (!embeddingConfigured(config)) {
      if (typeof setStatus === "function") setStatus("请先编辑当前接口，完整填写并启用 Embedding 配置。", true);
      return;
    }
    const ragApi = root.deepPaperRag;
    const vectorStore = root.deepPaperVectorStore;
    if (!ragApi?.buildPassageIndex || !vectorStore?.indexPassages) return;
    const index = ragApi.buildPassageIndex(papers);
    const cleanStatus = cleaningSummary(index);
    if (!index.passages.length) {
      if (typeof setStatus === "function") setStatus("没有可建立语义索引的论文正文。", true);
      return;
    }

    semanticIndexBusy = true;
    const button = document.querySelector("#agentBuildIndexBtn");
    const status = document.querySelector("#agentSemanticStatus");
    if (button) {
      button.disabled = true;
      button.textContent = "正在建立...";
    }
    try {
      const result = await vectorStore.indexPassages(
        index.passages,
        config,
        async (texts) => {
          const response = await createEmbeddingVectors(texts, config);
          if (!response?.ok) throw new Error(response?.error || "Embedding 请求失败。" );
          return response.vectors;
        },
        (progress) => {
          const percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
          if (status) {
            status.textContent = progress.reducingBatch
              ? `服务端拒绝当前批次，已缩小至每批 ${progress.batchSize} 个段落重试（已完成 ${progress.completed}/${progress.total}）`
              : `正在向量化 ${progress.completed}/${progress.total} 个段落（${percent}%）${progress.reused ? `，已复用 ${progress.reused} 个重复向量` : ""}；${cleanStatus}`;
          }
        }
      );
      if (typeof setStatus === "function") setStatus(`语义索引已更新：${result.indexed} 个段落，本次新增 ${result.newlyIndexed} 个，实际生成 ${result.embedded} 个向量，复用 ${result.reused} 个。`);
    } catch (error) {
      if (typeof setStatus === "function") setStatus(`语义索引更新失败：${error.message}`, true);
      if (status) status.textContent = error.message;
    } finally {
      semanticIndexBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = "更新语义索引";
      }
      refreshSemanticIndexStatus();
    }
  }

  async function startTask() {
    const input = document.querySelector("#agentGoalInput");
    const goal = input?.value.trim();
    if (!goal) return;
    if (typeof papers === "undefined" || !papers.length) {
      if (typeof setStatus === "function") setStatus("文献库为空，无法执行 Agent 任务。", true);
      return;
    }
    const config = typeof currentConfig === "function" ? currentConfig() : {};
    if (!config.apiKey) {
      if (typeof setStatus === "function") setStatus("请先在左侧配置一个可用的 AI 接口。", true);
      return;
    }

    const task = {
      id: crypto.randomUUID(),
      goal,
      status: "running",
      createdAt: new Date().toISOString(),
      events: [{ type: "goal", text: goal }],
      transcript: [],
      evidence: [],
      final: null,
      proposal: null
    };
    agentState.tasks.push(task);
    agentState.activeTaskId = task.id;
    input.value = "";
    saveState();
    setRunning(true);
    renderAgent();
    const token = ++activeRunToken;

    for (let stepIndex = 0; stepIndex < MAX_STEPS; stepIndex += 1) {
      if (token !== activeRunToken) return;
      task.events.push({ type: "thinking", text: `正在决定第 ${stepIndex + 1} 步...` });
      renderAgent();

      let response;
      try {
        response = await root.deepPaper.runAgentStep({
          provider: config.provider,
          apiKey: config.apiKey,
          model: config.model,
          goal,
          transcript: task.transcript
        });
      } catch (error) {
        response = { ok: false, error: error.message };
      }
      task.events = task.events.filter((item) => item.type !== "thinking");
      if (token !== activeRunToken) return;
      if (!response?.ok) {
        task.status = "failed";
        task.events.push({ type: "error", text: response?.error || "Agent 请求失败。" });
        finishRun(task);
        return;
      }

      const step = response.step;
      if (step.status === "final") {
        const citations = validateCitations(step.final?.citations, task);
        task.final = {
          answer: step.final?.answer || step.decisionSummary || "任务已完成。",
          citations,
          followUps: step.final?.followUps || [],
          verification: null
        };
        task.events.push({ type: "thinking", text: "正在用本地原文证据校验最终回答..." });
        renderAgent();
        try {
          const verificationResult = typeof root.deepPaper?.verifyAgentAnswer === "function"
            ? await root.deepPaper.verifyAgentAnswer({
              provider: config.provider,
              apiKey: config.apiKey,
              model: config.model,
              goal,
              answer: task.final.answer,
              citations: citations.map((citation) => ({
                ...citation,
                paperTitle: paperTitle(papers.find((paper) => String(paper.id) === String(citation.paperId)))
              }))
            })
            : { ok: false, error: "证据校验模块未加载。" };
          task.final.verification = verificationResult?.ok
            ? verificationResult.verification
            : { verdict: "unchecked", score: null, summary: verificationResult?.error || "证据校验未完成。", issues: [], supportedPassageIds: [] };
        } catch (error) {
          task.final.verification = { verdict: "unchecked", score: null, summary: error.message, issues: [], supportedPassageIds: [] };
        }
        if (token !== activeRunToken) return;
        task.events = task.events.filter((item) => item.type !== "thinking");
        task.status = "completed";
        task.events.push({ type: "final", text: step.decisionSummary || "已形成结论。" });
        finishRun(task);
        return;
      }

      const tool = step.tool;
      task.events.push({
        type: "tool",
        tool: tool.name,
        text: step.decisionSummary || TOOL_LABELS[tool.name],
        arguments: tool.arguments
      });
      task.transcript.push({
        type: "agent_action",
        tool: tool.name,
        summary: step.decisionSummary,
        arguments: tool.arguments
      });

      const retrieval = root.deepPaperLibraryAi?.retrieveCandidates;
      if (typeof retrieval !== "function") {
        task.status = "failed";
        task.events.push({ type: "error", text: "全库检索模块未加载。" });
        finishRun(task);
        return;
      }
      const ragApi = root.deepPaperRag ? {
        ...root.deepPaperRag,
        extractTerms: root.deepPaperLibraryAi?.extractTerms,
        termAliases: root.deepPaperLibraryAi?.termAliases
      } : null;
      let toolResult;
      try {
        toolResult = await executeLocalTool(tool, papers, retrieval, ragApi, {
          embeddingConfig: config,
          vectorStore: root.deepPaperVectorStore,
          createEmbeddings: (texts) => createEmbeddingVectors(texts, config)
        });
      } catch (error) {
        toolResult = { ok: false, error: `工具执行失败：${error.message}` };
      }
      if (toolResult.pageMapsUpdated && typeof saveLibrary === "function") saveLibrary();
      task.events.push({
        type: toolResult.ok ? "tool-result" : "error",
        tool: tool.name,
        text: toolResult.summary || toolResult.error,
        paperIds: [...new Set([
          ...(toolResult.papers || []).map((paper) => paper.paper_id),
          ...(toolResult.passages || []).map((passage) => passage.paper_id)
        ])]
      });
      if (Array.isArray(toolResult.passages)) {
        const existingEvidence = new Map((task.evidence || []).map((item) => [item.passageId, item]));
        const evidence = [...(task.evidence || []), ...toolResult.passages.map((passage) => {
          const previous = existingEvidence.get(passage.passage_id) || {};
          return {
            passageId: passage.passage_id,
            paperId: passage.paper_id,
            section: passage.section || previous.section || "",
            pageNumber: passage.page_number,
            estimatedPage: Boolean(passage.estimated_page),
            quote: passage.text,
            retrievalMode: passage.retrieval_mode || previous.retrievalMode,
            lexicalRank: passage.lexical_rank || previous.lexicalRank,
            semanticRank: passage.semantic_rank || previous.semanticRank,
            semanticScore: passage.semantic_score ?? previous.semanticScore,
            hybridScore: passage.hybrid_score || previous.hybridScore
          };
        })];
        task.evidence = [...new Map(evidence.map((item) => [item.passageId, item])).values()].slice(-40);
      }
      task.transcript.push({
        type: "tool_result",
        tool: tool.name,
        summary: toolResult.summary || toolResult.error,
        result: toolResult
      });
      if (toolResult.proposal) task.proposal = toolResult.proposal;
      saveState();
      renderAgent();
    }

    task.status = "stopped";
    task.events.push({ type: "notice", text: `已达到 ${MAX_STEPS} 步上限。请缩小目标后继续。` });
    finishRun(task);
  }

  function finishRun(task) {
    task.transcript = [];
    task.evidence = [];
    saveState();
    setRunning(false);
    renderAgent();
    if (typeof setStatus === "function") {
      setStatus(task.status === "completed" ? "文献 Agent 已完成任务。" : `文献 Agent：${task.events.at(-1)?.text || "任务结束"}`, task.status === "failed");
    }
  }

  function validateCitations(citations, task) {
    const validIds = new Set((typeof papers !== "undefined" ? papers : []).map((paper) => String(paper.id)));
    const evidence = new Map((task?.evidence || []).map((item) => [String(item.passageId), item]));
    return (Array.isArray(citations) ? citations : []).map((item) => {
      const passage = evidence.get(String(item.passageId || ""));
      const paperId = String(passage?.paperId || item.paperId || "");
      if (!validIds.has(paperId)) return null;
      return {
        paperId,
        passageId: passage?.passageId || "",
        section: passage?.section || "",
        pageNumber: passage?.pageNumber || null,
        estimatedPage: passage?.estimatedPage || false,
        quote: clip(passage?.quote, 360),
        reason: clip(item.reason, 400),
        retrievalMode: passage?.retrievalMode || "keyword",
        lexicalRank: passage?.lexicalRank || null,
        semanticRank: passage?.semanticRank || null,
        semanticScore: Number.isFinite(passage?.semanticScore) ? passage.semanticScore : null,
        hybridScore: Number.isFinite(passage?.hybridScore) ? passage.hybridScore : null
      };
    }).filter(Boolean).slice(0, 16);
  }

  function setRunning(running) {
    const run = document.querySelector("#agentRunBtn");
    const stop = document.querySelector("#agentStopBtn");
    const input = document.querySelector("#agentGoalInput");
    if (run) {
      run.disabled = running;
      run.textContent = running ? "正在执行..." : "开始执行";
    }
    stop?.classList.toggle("hidden", !running);
    if (input) input.disabled = running;
  }

  function renderAgent() {
    const select = document.querySelector("#agentTaskSelect");
    const content = document.querySelector("#agentContent");
    if (!select || !content) return;
    const tasks = [...agentState.tasks].reverse();
    select.innerHTML = tasks.length
      ? tasks.map((task) => `<option value="${escapeHtml(task.id)}" ${task.id === activeTask()?.id ? "selected" : ""}>${escapeHtml(task.goal.slice(0, 46))}</option>`).join("")
      : '<option value="">暂无任务</option>';
    const task = activeTask();
    if (!task) {
      content.innerHTML = '<div class="agent-empty"><strong>给 Agent 一个完整目标</strong><p>它会调用检索、阅读、比较和合集方案工具，并展示每一步实际操作。</p></div>';
      setRunning(false);
      return;
    }
    content.innerHTML = `
      <article class="agent-task">
        <header><span class="agent-status ${escapeHtml(task.status)}">${statusLabel(task.status)}</span><time>${escapeHtml(new Date(task.createdAt).toLocaleString())}</time></header>
        <h3>${escapeHtml(task.goal)}</h3>
        <div class="agent-timeline">${task.events.map(renderEvent).join("")}</div>
        ${task.final ? renderFinal(task.final) : ""}
        ${task.proposal ? renderProposal(task.id, task.proposal) : ""}
      </article>
    `;
    setRunning(task.status === "running");
    requestAnimationFrame(() => { content.scrollTop = content.scrollHeight; });
  }

  function statusLabel(status) {
    return { running: "执行中", completed: "已完成", failed: "失败", stopped: "已停止" }[status] || status;
  }

  function renderEvent(event) {
    if (event.type === "goal") return "";
    const label = event.tool ? TOOL_LABELS[event.tool] || event.tool : event.type === "final" ? "形成结论" : "Agent";
    const paperLinks = (event.paperIds || []).slice(0, 8).map((id) => {
      const paper = typeof papers !== "undefined" ? papers.find((item) => String(item.id) === String(id)) : null;
      return paper ? `<button type="button" data-agent-paper="${escapeHtml(id)}">${escapeHtml(paperTitle(paper))}</button>` : "";
    }).join("");
    return `<div class="agent-event ${escapeHtml(event.type)}"><span>${escapeHtml(label)}</span><div><p>${escapeHtml(event.text || "")}</p>${paperLinks ? `<div class="agent-event-papers">${paperLinks}</div>` : ""}</div></div>`;
  }

  function renderFinal(final) {
    const supportedIds = new Set(final.verification?.supportedPassageIds || []);
    const citations = (final.citations || []).map((citation) => {
      const paper = typeof papers !== "undefined" ? papers.find((item) => String(item.id) === String(citation.paperId)) : null;
      if (!paper) return "";
      const pageLabel = [citation.section, citation.pageNumber ? `${citation.estimatedPage ? "约" : ""}第 ${citation.pageNumber} 页` : "论文解析"].filter(Boolean).join(" · ");
      const quote = citation.quote ? `<blockquote>${escapeHtml(citation.quote)}</blockquote>` : "";
      const retrievalLabel = citation.retrievalMode === "hybrid"
        ? `混合召回 ${citation.hybridScore || "-"}`
        : "关键词召回";
      const verified = supportedIds.has(citation.passageId) ? '<span class="evidence-verified">校验支持</span>' : "";
      return `<div class="agent-citation"><div><div class="agent-citation-source"><strong>${escapeHtml(paperTitle(paper))}</strong><span>${escapeHtml(pageLabel)}</span></div><div class="evidence-badges"><span>${escapeHtml(retrievalLabel)}</span>${citation.semanticRank ? `<span>语义 #${Number(citation.semanticRank)}</span>` : ""}${verified}</div>${quote}<p>${escapeHtml(citation.reason || "")}</p></div><button class="secondary small-btn" type="button" data-agent-paper="${escapeHtml(paper.id)}" ${citation.pageNumber ? `data-agent-page="${Number(citation.pageNumber)}"` : ""}>${citation.pageNumber ? "打开原文" : "查看论文"}</button></div>`;
    }).join("");
    const followUps = (final.followUps || []).map((item) => `<button type="button" data-agent-follow-up="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("");
    const verification = renderVerification(final.verification);
    return `<section class="agent-final"><h4>Agent 结论</h4><p>${escapeHtml(final.answer)}</p>${verification}${citations ? `<div class="agent-citations">${citations}</div>` : ""}${followUps ? `<div class="agent-follow-ups">${followUps}</div>` : ""}</section>`;
  }

  function renderVerification(verification) {
    if (!verification) return "";
    const labels = { supported: "证据支持", partial: "部分支持", insufficient: "证据不足", unchecked: "未完成校验" };
    const issues = (verification.issues || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    const score = Number.isFinite(verification.score) ? `<strong>${Number(verification.score)}/100</strong>` : "";
    return `<section class="agent-verification ${escapeHtml(verification.verdict)}"><div><span>${escapeHtml(labels[verification.verdict] || "证据校验")}</span>${score}</div><p>${escapeHtml(verification.summary || "")}</p>${issues ? `<ul>${issues}</ul>` : ""}</section>`;
  }

  function renderProposal(taskId, proposal) {
    const paperNames = proposal.paperIds.slice(0, 10).map((id) => {
      const paper = typeof papers !== "undefined" ? papers.find((item) => String(item.id) === String(id)) : null;
      return paper ? `<li>${escapeHtml(paperTitle(paper))}</li>` : "";
    }).join("");
    const pending = proposal.status === "pending";
    return `<section class="agent-proposal ${escapeHtml(proposal.status)}"><div class="agent-proposal-head"><div><span>待确认操作</span><h4>创建合集：${escapeHtml(proposal.name)}</h4></div><strong>${proposal.paperIds.length} 篇</strong></div>${proposal.rationale ? `<p>${escapeHtml(proposal.rationale)}</p>` : ""}<details><summary>查看论文列表</summary><ul>${paperNames}</ul></details>${pending ? `<div class="agent-proposal-actions"><button class="primary" type="button" data-agent-confirm-proposal="${escapeHtml(taskId)}">确认创建并加入</button><button class="secondary" type="button" data-agent-reject-proposal="${escapeHtml(taskId)}">取消</button></div>` : `<div class="agent-proposal-state">${proposal.status === "applied" ? "已执行" : "已取消"}</div>`}</section>`;
  }

  function applyProposal(taskId) {
    const task = agentState.tasks.find((item) => item.id === taskId);
    const proposal = task?.proposal;
    if (!proposal || proposal.status !== "pending" || typeof papers === "undefined") return;
    if (proposal.name === "收藏") {
      papers.forEach((paper) => { if (proposal.paperIds.includes(String(paper.id))) paper.favorite = true; });
    } else {
      let collection = collections.find((item) => item.name === proposal.name);
      if (!collection) {
        collection = { id: crypto.randomUUID(), name: proposal.name, createdAt: new Date().toISOString() };
        collections.unshift(collection);
      }
      papers.forEach((paper) => {
        if (!proposal.paperIds.includes(String(paper.id))) return;
        paper.collectionIds = Array.isArray(paper.collectionIds) ? paper.collectionIds : [];
        if (!paper.collectionIds.includes(collection.id)) paper.collectionIds.push(collection.id);
      });
      if (typeof saveCollections === "function") saveCollections();
    }
    if (typeof saveLibrary === "function") saveLibrary();
    proposal.status = "applied";
    saveState();
    root.deepPaperRefresh?.();
    if (typeof setStatus === "function") setStatus(`已执行 Agent 合集方案：${proposal.name}（${proposal.paperIds.length} 篇）`);
    renderAgent();
  }

  function rejectProposal(taskId) {
    const task = agentState.tasks.find((item) => item.id === taskId);
    if (!task?.proposal || task.proposal.status !== "pending") return;
    task.proposal.status = "rejected";
    saveState();
    renderAgent();
  }

  async function openPaper(paperId, pageNumber = 0) {
    if (typeof papers === "undefined" || typeof state === "undefined") return;
    const paper = papers.find((item) => String(item.id) === String(paperId));
    if (!paper) return;
    state.selectedId = paper.id;
    state.detailTab = pageNumber ? "source" : "analysis";
    if (pageNumber) state.pendingPdfPage = pageNumber;
    state.activeCollectionId = null;
    closePanel();
    if (pageNumber && typeof showPaperSource === "function") {
      await showPaperSource(paper.id);
      return;
    }
    root.deepPaperRefresh?.();
    requestAnimationFrame(() => document.querySelector(".paper-card.active")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  function exportState() {
    return JSON.parse(JSON.stringify(agentState));
  }

  function importState(value) {
    if (!value || !Array.isArray(value.tasks)) return;
    agentState = { tasks: value.tasks.slice(-MAX_TASKS), activeTaskId: value.activeTaskId || value.tasks.at(-1)?.id || null };
    saveState();
    renderAgent();
  }

  root.deepPaperAgent = { open: openPanel, exportState, importState, executeLocalTool };
  createUi();
})(globalThis);
