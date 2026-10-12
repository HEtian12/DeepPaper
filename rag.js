(function initDeepPaperRag(root) {
  const INDEX_VERSION = 3;
  const CLEANING_VERSION = 1;
  const DEFAULT_TARGET = 820;
  const DEFAULT_OVERLAP = 120;
  const EDGE_LINE_COUNT = 3;
  const PRESERVE_HYPHEN_RIGHT = new Set([
    "audio", "aware", "based", "centric", "class", "decoder", "dependent", "domain", "driven",
    "encoder", "free", "frequency", "generation", "guided", "image", "language", "learning", "level",
    "modal", "network", "quality", "related", "scale", "shot", "source", "specific", "stage", "step",
    "student", "supervised", "tail", "tailed", "target", "teacher", "term", "text", "time", "trained",
    "visual", "wise", "world"
  ]);
  const SECTION_PATTERNS = [
    ["摘要", /^(?:abstract|摘要)$/iu],
    ["引言", /^(?:introduction|引言|绪论)$/iu],
    ["相关工作", /^(?:related work|literature review|相关工作|文献综述)$/iu],
    ["背景", /^(?:background|preliminaries|preliminary|背景|预备知识)$/iu],
    ["方法", /^(?:method|methods|methodology|proposed method|proposed approach|approach|framework|方法|方法论)$/iu],
    ["实验", /^(?:experiment|experiments|experimental setup|experimental results|evaluation|evaluations|实验|实验结果|评估)$/iu],
    ["结果", /^(?:result|results|结果)$/iu],
    ["讨论", /^(?:discussion|discussions|讨论)$/iu],
    ["局限", /^(?:limitation|limitations|局限|局限性)$/iu],
    ["结论", /^(?:conclusion|conclusions|结论|总结)$/iu],
    ["参考文献", /^(?:references|bibliography|参考文献)$/iu],
    ["附录", /^(?:appendix|appendices|supplementary material|附录)$/iu],
    ["致谢", /^(?:acknowledgment|acknowledgments|acknowledgement|acknowledgements|致谢)$/iu]
  ];

  function normalizeTypography(value) {
    return String(value || "")
      .replace(/\u00ad/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/ﬀ/g, "ff")
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .replace(/ﬃ/g, "ffi")
      .replace(/ﬄ/g, "ffl");
  }

  function normalizeText(value) {
    return normalizeTypography(value)
      .replace(/\r/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function hashText(value, seed = 2166136261) {
    let hash = seed >>> 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function contentHash(value) {
    const text = String(value || "");
    return `${text.length}:${hashText(text)}${hashText(text, 3339675911)}`;
  }

  function edgeLineKey(value) {
    const line = normalizeTypography(value)
      .toLowerCase()
      .replace(/^\s*\d+\s+|\s+\d+\s*$/g, "")
      .replace(/[\s\p{P}\p{S}]+/gu, "")
      .trim();
    return line.length >= 4 && line.length <= 180 ? line : "";
  }

  function isStandalonePageNumber(value) {
    return /^(?:page\s*)?(?:\d{1,5}|[ivxlcdm]{1,8})(?:\s*(?:\/|of)\s*\d{1,5})?$/iu.test(String(value || "").trim());
  }

  function edgeLineEntries(lines, fromStart) {
    const entries = lines
      .map((line, index) => ({ line, index }))
      .filter((item) => item.line.trim());
    return fromStart ? entries.slice(0, EDGE_LINE_COUNT) : entries.slice(-EDGE_LINE_COUNT);
  }

  function repairEnglishLineBreaks(value) {
    let repairedHyphenations = 0;
    const text = normalizeTypography(value).replace(/\b([A-Za-z]{5,})-\s*\n\s*([a-z]{3,})\b/g, (match, left, right) => {
      if (PRESERVE_HYPHEN_RIGHT.has(right.toLowerCase())) return match;
      repairedHyphenations += 1;
      return `${left}${right}`;
    });
    return { text, repairedHyphenations };
  }

  function cleanPdfPages(pageList) {
    const pages = (Array.isArray(pageList) ? pageList : []).map((page) => ({
      ...page,
      lines: normalizeTypography(page?.text).replace(/\r/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    }));
    const headerCounts = new Map();
    const footerCounts = new Map();
    const countKeys = (entries, counts) => {
      new Set(entries.map((item) => edgeLineKey(item.line)).filter(Boolean)).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
    };
    pages.forEach((page) => {
      countKeys(edgeLineEntries(page.lines, true), headerCounts);
      countKeys(edgeLineEntries(page.lines, false), footerCounts);
    });
    const repeatThreshold = Math.max(3, Math.ceil(pages.length * 0.5));
    const repeatedHeaders = new Set([...headerCounts].filter(([, count]) => count >= repeatThreshold).map(([key]) => key));
    const repeatedFooters = new Set([...footerCounts].filter(([, count]) => count >= repeatThreshold).map(([key]) => key));
    const stats = {
      version: CLEANING_VERSION,
      pages: pages.length,
      removedHeaderFooterLines: 0,
      removedPageNumberLines: 0,
      repairedHyphenations: 0
    };
    const cleanedPages = pages.map((page) => {
      const headerIndexes = new Set(edgeLineEntries(page.lines, true).map((item) => item.index));
      const footerIndexes = new Set(edgeLineEntries(page.lines, false).map((item) => item.index));
      const kept = page.lines.filter((line, index) => {
        const atHeader = headerIndexes.has(index);
        const atFooter = footerIndexes.has(index);
        if ((atHeader || atFooter) && isStandalonePageNumber(line)) {
          stats.removedPageNumberLines += 1;
          return false;
        }
        const key = edgeLineKey(line);
        if ((atHeader && repeatedHeaders.has(key)) || (atFooter && repeatedFooters.has(key))) {
          stats.removedHeaderFooterLines += 1;
          return false;
        }
        return true;
      });
      const repaired = repairEnglishLineBreaks(kept.join("\n"));
      stats.repairedHyphenations += repaired.repairedHyphenations;
      return { ...page, text: normalizeText(repaired.text), lines: undefined };
    });
    return { pages: cleanedPages, stats };
  }

  function detectSectionHeading(value) {
    let line = normalizeText(value).replace(/[:：]\s*$/u, "");
    if (!line || line.length > 80 || line.includes("\n")) return "";
    line = line
      .replace(/^\s*(?:section\s+)?(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)：:]?\s+/iu, "")
      .trim();
    return SECTION_PATTERNS.find(([, pattern]) => pattern.test(line))?.[0] || "";
  }

  function sectionMarkers(value) {
    const text = String(value || "");
    const markers = [];
    let offset = 0;
    text.split("\n").forEach((line) => {
      const section = detectSectionHeading(line);
      if (section) markers.push({ offset, section });
      offset += line.length + 1;
    });
    return markers;
  }

  function normalizeSearchText(value) {
    return normalizeText(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function paperTitle(paper) {
    const analysis = paper?.analysis || {};
    return paper?.titleZh || analysis.title_zh || paper?.title || analysis.title || paper?.titleEn || analysis.title_en || "未命名论文";
  }

  function findBoundary(text, start, idealEnd) {
    if (idealEnd >= text.length) return text.length;
    const minimum = Math.min(idealEnd, start + Math.floor((idealEnd - start) * 0.62));
    const window = text.slice(minimum, idealEnd + 1);
    const boundaries = ["\n\n", "\n", "。", "！", "？", ". ", "; ", "；"];
    let best = -1;
    let width = 0;
    boundaries.forEach((boundary) => {
      const index = window.lastIndexOf(boundary);
      if (index > best) {
        best = index;
        width = boundary.length;
      }
    });
    return best >= 0 ? minimum + best + width : idealEnd;
  }

  function splitTextIntoChunks(value, options = {}) {
    const text = normalizeText(value);
    if (!text) return [];
    const target = Math.max(320, Number(options.target) || DEFAULT_TARGET);
    const overlap = Math.min(Math.floor(target / 3), Math.max(0, Number(options.overlap) || DEFAULT_OVERLAP));
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = findBoundary(text, start, Math.min(text.length, start + target));
      const chunkText = text.slice(start, end).trim();
      if (chunkText) chunks.push({ text: chunkText, start, end });
      if (end >= text.length) break;
      let nextStart = Math.max(start + 1, end - overlap);
      const leadingBoundary = text.slice(nextStart, Math.min(end, nextStart + overlap)).search(/[。！？.!?；;\n]\s*/u);
      if (leadingBoundary >= 0) nextStart += leadingBoundary + 1;
      start = Math.min(end, nextStart);
    }
    return chunks;
  }

  function validPageOffsets(paper) {
    const textLength = String(paper?.text || "").length;
    const offsets = Array.isArray(paper?.pageTextOffsets) ? paper.pageTextOffsets : [];
    if (!offsets.length) return [];
    const valid = offsets.every((item, index) => Number(item?.pageNumber) === index + 1
      && Number.isInteger(item?.start)
      && Number.isInteger(item?.end)
      && item.start >= 0
      && item.end >= item.start
      && item.end <= textLength);
    return valid ? offsets : [];
  }

  function buildPaperPassageData(paper, options = {}) {
    const text = normalizeText(paper?.text);
    if (!paper?.id || !text) return { passages: [], cleaningStats: { version: CLEANING_VERSION, pages: 0, removedHeaderFooterLines: 0, removedPageNumberLines: 0, repairedHyphenations: 0 } };
    const offsets = validPageOffsets(paper);
    const pageCount = Math.max(1, Number(paper.pageCount) || offsets.length || 1);
    const rawSegments = offsets.length
      ? offsets.map((item) => ({
        pageNumber: item.pageNumber,
        estimatedPage: false,
        sourceStart: item.start,
        text: String(paper.text).slice(item.start, item.end)
      }))
      : [{ pageNumber: null, estimatedPage: pageCount > 1, sourceStart: 0, text }];
    const cleaned = cleanPdfPages(rawSegments);
    const passages = [];
    let ordinal = 0;
    let currentSection = "";
    cleaned.pages.forEach((segment) => {
      const markers = sectionMarkers(segment.text);
      let markerIndex = 0;
      splitTextIntoChunks(segment.text, options).forEach((chunk) => {
        while (markerIndex < markers.length && markers[markerIndex].offset <= chunk.start + Math.min(80, chunk.text.length)) {
          currentSection = markers[markerIndex].section;
          markerIndex += 1;
        }
        const absoluteStart = segment.sourceStart + chunk.start;
        const pageNumber = segment.pageNumber || Math.min(pageCount, Math.max(1, Math.floor((absoluteStart / Math.max(1, text.length)) * pageCount) + 1));
        const chunkHash = contentHash(chunk.text);
        const keywords = [...new Set([...(paper.keywords || []), ...(paper.analysis?.keywords || [])])].slice(0, 16);
        const authors = (Array.isArray(paper.authors) ? paper.authors : String(paper.authors || "").split(/[,，;；]+/))
          .map((author) => String(author || "").trim()).filter(Boolean).slice(0, 20);
        passages.push({
          passageId: `${paper.id}:rag:${pageNumber}:${ordinal}`,
          paperId: String(paper.id),
          title: paperTitle(paper),
          year: paper.year || paper.analysis?.year || "",
          venue: paper.venue || paper.analysis?.venue || "",
          authors,
          section: currentSection,
          pageNumber,
          estimatedPage: segment.estimatedPage,
          ordinal,
          pageCharStart: chunk.start,
          pageCharEnd: chunk.end,
          cleaningVersion: CLEANING_VERSION,
          contentHash: chunkHash,
          text: chunk.text,
          keywords,
          metadata: {
            paperId: String(paper.id),
            title: paperTitle(paper),
            year: paper.year || paper.analysis?.year || "",
            venue: paper.venue || paper.analysis?.venue || "",
            authors,
            keywords,
            section: currentSection,
            pageNumber,
            estimatedPage: segment.estimatedPage,
            ordinal,
            pageCharStart: chunk.start,
            pageCharEnd: chunk.end,
            cleaningVersion: CLEANING_VERSION,
            contentHash: chunkHash
          }
        });
        ordinal += 1;
      });
      if (markers.length) currentSection = markers[markers.length - 1].section;
    });
    return { passages, cleaningStats: cleaned.stats };
  }

  function buildPaperPassages(paper, options = {}) {
    return buildPaperPassageData(paper, options).passages;
  }

  function buildPassageIndex(paperList, options = {}) {
    const cleaningStats = { version: CLEANING_VERSION, pages: 0, removedHeaderFooterLines: 0, removedPageNumberLines: 0, repairedHyphenations: 0, duplicatePassages: 0 };
    const passages = [];
    (Array.isArray(paperList) ? paperList : []).forEach((paper) => {
      const result = buildPaperPassageData(paper, options);
      passages.push(...result.passages);
      Object.keys(cleaningStats).forEach((key) => {
        if (key !== "version" && key !== "duplicatePassages") cleaningStats[key] += Number(result.cleaningStats?.[key]) || 0;
      });
    });
    cleaningStats.duplicatePassages = passages.length - new Set(passages.map((passage) => passage.contentHash)).size;
    return { version: INDEX_VERSION, cleaningVersion: CLEANING_VERSION, passages, cleaningStats };
  }

  function fallbackTerms(query) {
    return String(query || "")
      .split(/(?:\s+(?:and|or)\s+)|(?:以及|并且|同时|还有|或者|和|与|及|或)|[,，、;；/]+/iu)
      .map((item) => item.trim())
      .filter((item) => item.length > 1)
      .slice(0, 10);
  }

  function searchPassages(index, query, limit = 12, helpers = {}) {
    const passages = Array.isArray(index?.passages) ? index.passages : [];
    const extracted = typeof helpers.extractTerms === "function" ? helpers.extractTerms(query) : fallbackTerms(query);
    const terms = extracted.length ? extracted : fallbackTerms(query);
    if (!terms.length) return [];
    const normalizedQuery = normalizeSearchText(query);
    const scored = passages.map((passage) => {
      const passageText = normalizeSearchText(passage.text);
      const titleText = normalizeSearchText(passage.title);
      const keywordText = normalizeSearchText(passage.keywords.join(" "));
      const matchedTerms = [];
      let score = 0;
      terms.forEach((term) => {
        const aliases = typeof helpers.termAliases === "function" ? helpers.termAliases(term) : [term];
        let matched = false;
        aliases.forEach((alias) => {
          const needle = normalizeSearchText(alias);
          if (!needle) return;
          if (passageText.includes(needle)) {
            score += 12;
            matched = true;
          }
          if (keywordText.includes(needle)) score += 9;
          if (titleText.includes(needle)) score += 7;
        });
        if (matched) matchedTerms.push(term);
      });
      if (normalizedQuery && passageText.includes(normalizedQuery)) score += 18;
      if (matchedTerms.length === terms.length && terms.length > 1) score += 22;
      return { ...passage, score, matchedTerms: [...new Set(matchedTerms)] };
    });
    return scored
      .filter((passage) => passage.score > 0)
      .sort((a, b) => b.score - a.score || a.paperId.localeCompare(b.paperId) || a.ordinal - b.ordinal)
      .slice(0, Math.min(80, Math.max(1, Number(limit) || 12)));
  }

  function cosineSimilarity(left, right) {
    if (!left?.length || left.length !== right?.length) return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
      const a = Number(left[index]) || 0;
      const b = Number(right[index]) || 0;
      dot += a * b;
      leftNorm += a * a;
      rightNorm += b * b;
    }
    if (!leftNorm || !rightNorm) return -1;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  function diversifyPassages(items, limit) {
    const selected = [];
    const paperCounts = new Map();
    const maxPerPaper = Math.max(2, Math.ceil(limit / 4));
    for (const item of items) {
      const count = paperCounts.get(item.paperId) || 0;
      if (count >= maxPerPaper) continue;
      selected.push(item);
      paperCounts.set(item.paperId, count + 1);
      if (selected.length >= limit) break;
    }
    if (selected.length < limit) {
      for (const item of items) {
        if (selected.includes(item)) continue;
        selected.push(item);
        if (selected.length >= limit) break;
      }
    }
    return selected;
  }

  function searchPassagesHybrid(index, query, queryVector, vectorMap, limit = 12, helpers = {}) {
    const passages = Array.isArray(index?.passages) ? index.passages : [];
    const targetLimit = Math.min(24, Math.max(1, Number(limit) || 12));
    const lexical = searchPassages(index, query, 60, helpers);
    const vectors = vectorMap instanceof Map ? vectorMap : new Map(Object.entries(vectorMap || {}));
    const semantic = queryVector?.length
      ? passages.map((passage) => ({ passage, score: cosineSimilarity(queryVector, vectors.get(passage.passageId)) }))
        .filter((item) => Number.isFinite(item.score) && item.score > -1)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60)
      : [];

    if (!semantic.length) {
      return diversifyPassages(lexical.map((passage, index) => ({
        ...passage,
        retrievalMode: "keyword",
        lexicalRank: index + 1,
        semanticRank: null,
        semanticScore: null,
        hybridScore: Math.round((1 - index / Math.max(1, lexical.length)) * 100)
      })), targetLimit);
    }

    const combined = new Map();
    lexical.forEach((passage, index) => {
      combined.set(passage.passageId, {
        ...passage,
        lexicalRank: index + 1,
        semanticRank: null,
        semanticScore: null,
        fusedScore: 1 / (60 + index + 1)
      });
    });
    semantic.forEach((item, index) => {
      const current = combined.get(item.passage.passageId) || {
        ...item.passage,
        score: 0,
        matchedTerms: [],
        lexicalRank: null,
        fusedScore: 0
      };
      current.semanticRank = index + 1;
      current.semanticScore = item.score;
      current.fusedScore += 1.12 / (60 + index + 1);
      combined.set(item.passage.passageId, current);
    });

    const reranked = [...combined.values()].map((item) => {
      const agreementBonus = item.lexicalRank && item.semanticRank ? 0.004 : 0;
      const coverageBonus = Math.min(0.004, (item.matchedTerms?.length || 0) * 0.001);
      return { ...item, fusedScore: item.fusedScore + agreementBonus + coverageBonus };
    }).sort((a, b) => b.fusedScore - a.fusedScore || (b.semanticScore || -1) - (a.semanticScore || -1));
    const best = reranked[0]?.fusedScore || 1;
    return diversifyPassages(reranked.map((item) => ({
      ...item,
      retrievalMode: "hybrid",
      hybridScore: Math.max(1, Math.min(100, Math.round((item.fusedScore / best) * 100)))
    })), targetLimit);
  }

  function readPassages(index, passageIds, contextWindow = 1) {
    const passages = Array.isArray(index?.passages) ? index.passages : [];
    const ids = [...new Set((Array.isArray(passageIds) ? passageIds : []).map(String))].slice(0, 8);
    const windowSize = Math.min(1, Math.max(0, Number(contextWindow) || 0));
    return ids.map((passageId) => {
      const selected = passages.find((item) => item.passageId === passageId);
      if (!selected) return null;
      const neighbors = passages.filter((item) => item.paperId === selected.paperId && Math.abs(item.ordinal - selected.ordinal) <= windowSize);
      return { ...selected, context: neighbors.map((item) => item.text).join("\n\n") };
    }).filter(Boolean);
  }

  async function ensurePageMaps(paperList) {
    if (typeof root.deepPaper?.extractPdfPages !== "function") return { updated: 0, attempted: 0 };
    let updated = 0;
    let attempted = 0;
    for (const paper of Array.isArray(paperList) ? paperList : []) {
      if (paper?.kind === "image" || !paper?.filePath || validPageOffsets(paper).length) continue;
      const fingerprint = `${paper.fileHash || ""}:${paper.filePath}`;
      if (paper.ragPageMapAttempted === fingerprint) continue;
      attempted += 1;
      paper.ragPageMapAttempted = fingerprint;
      const result = await root.deepPaper.extractPdfPages(paper.filePath);
      if (!result?.ok || !Array.isArray(result.pageTextOffsets)) continue;
      paper.text = result.text;
      paper.pageCount = result.pageCount || paper.pageCount;
      paper.pageTextOffsets = result.pageTextOffsets;
      paper.ragIndexVersion = INDEX_VERSION;
      updated += 1;
    }
    return { updated, attempted };
  }

  const api = {
    INDEX_VERSION,
    CLEANING_VERSION,
    normalizeTypography,
    normalizeSearchText,
    contentHash,
    repairEnglishLineBreaks,
    cleanPdfPages,
    detectSectionHeading,
    splitTextIntoChunks,
    validPageOffsets,
    buildPaperPassages,
    buildPassageIndex,
    searchPassages,
    searchPassagesHybrid,
    cosineSimilarity,
    diversifyPassages,
    readPassages,
    ensurePageMaps
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.deepPaperRag = api;
})(globalThis);
