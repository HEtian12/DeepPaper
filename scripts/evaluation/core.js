const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const rag = require("../../rag.js");
const library = require("../../library-ai.js");
const { rankVectors } = require("../../vector-store.js");

const helpers = { extractTerms: library.extractLibraryAiTerms, termAliases: library.termAliases };
const MODES = ["keyword", "vector", "hybrid"];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeQuote(value) {
  return rag.repairEnglishLineBreaks(value).text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

function unique(items, label, key = (item) => item.id) {
  ensure(new Set(items.map(key)).size === items.length, `${label}: duplicate identifiers`);
}

function settings(options = {}) {
  const config = {
    k: options.k ?? 5,
    target: options.target ?? 820,
    overlap: options.overlap ?? 120,
    cleaning: options.cleaning ?? true,
    repeats: options.repeats ?? 5,
    split: options.split ?? "development",
    modes: options.modes ?? ["keyword"]
  };
  for (const [key, min, max] of [["k", 1, 24], ["target", 320, 10000], ["overlap", 0, Math.floor(config.target / 3)], ["repeats", 1, 100]]) {
    ensure(Number.isInteger(config[key]) && config[key] >= min && config[key] <= max, `${key} must be an integer in [${min}, ${max}]`);
  }
  ensure(typeof config.cleaning === "boolean", "cleaning must be boolean");
  ensure(["development", "test", "all"].includes(config.split), "Invalid split");
  ensure(Array.isArray(config.modes) && config.modes.length > 0 && config.modes.every((mode) => MODES.includes(mode)), "Invalid modes");
  unique(config.modes, "modes", (mode) => mode);
  return config;
}

function validateDataset(corpus, annotations) {
  for (const [name, document] of [["corpus", corpus], ["questions", annotations]]) {
    ensure(document?.schemaVersion === 1, `${name}: schemaVersion must be 1`);
    ensure(nonempty(document.id) && nonempty(document.version), `${name}: id and version required`);
    ensure(["synthetic", "real"].includes(document.kind), `${name}: kind must be synthetic or real`);
    ensure(nonempty(document.source), `${name}: source/provenance required`);
  }
  ensure(corpus.kind === annotations.kind, "Corpus/questions kind mismatch");
  ensure(annotations.kind === "synthetic" || ["draft", "verified"].includes(annotations.annotationStatus), "Real annotations require draft or verified annotationStatus");
  ensure(Array.isArray(corpus.papers) && corpus.papers.length > 0, "No papers");
  unique(corpus.papers, "papers");
  const pageTexts = new Map();
  for (const paper of corpus.papers) {
    ensure(nonempty(paper.id) && nonempty(paper.text), "Paper id/text required");
    ensure(nonempty(paper.source), `${paper.id}: source required`);
    ensure(Array.isArray(paper.keywords) && paper.keywords.every((word) => typeof word === "string"), `${paper.id}: keywords must be strings`);
    const offsets = rag.validPageOffsets(paper);
    ensure(offsets.length > 0, `${paper.id}: verified PDF page offsets required; do not invent page numbers`);
    offsets.forEach((page, i) => {
      ensure(i === 0 || page.start >= offsets[i - 1].end, `${paper.id}: overlapping page offsets`);
      pageTexts.set(JSON.stringify([paper.id, page.pageNumber]), paper.text.slice(page.start, page.end));
    });
  }
  ensure(Array.isArray(annotations.questions) && annotations.questions.length > 0, "No questions");
  unique(annotations.questions, "questions");
  for (const question of annotations.questions) {
    ensure(nonempty(question.id) && nonempty(question.query) && nonempty(question.type), "Question id/query/type required");
    ensure(["development", "test"].includes(question.split), `${question.id}: invalid split`);
    ensure(typeof question.answerable === "boolean", `${question.id}: answerable must be boolean`);
    ensure(nonempty(question.reviewedBy) && nonempty(question.notes), `${question.id}: reviewer and annotation notes required`);
    ensure(Array.isArray(question.evidence), `${question.id}: evidence must be an array`);
    ensure(question.answerable === (question.evidence.length > 0), `${question.id}: answerable/evidence mismatch`);
    unique(question.evidence, `${question.id} evidence`);
    unique(question.evidence, `${question.id} evidence anchors`, (e) => JSON.stringify([e.paperId, e.pageNumber, normalizeQuote(e.quote)]));
    for (const evidence of question.evidence) {
      ensure(nonempty(evidence.id) && nonempty(evidence.paperId) && nonempty(evidence.quote), `${question.id}: invalid evidence`);
      ensure(Number.isInteger(evidence.pageNumber) && evidence.pageNumber > 0, `${question.id}: invalid page`);
      ensure([1, 2].includes(evidence.relevance), `${question.id}: relevance must be 1 or 2`);
      const source = pageTexts.get(JSON.stringify([evidence.paperId, evidence.pageNumber]));
      ensure(source !== undefined && normalizeQuote(source).includes(normalizeQuote(evidence.quote)), `${question.id}/${evidence.id}: quote not found on annotated source page`);
    }
  }
  // A paraphrase may span splits, but an identical normalized query must not leak.
  const splits = new Map();
  for (const q of annotations.questions) {
    const key = normalizeQuote(q.query);
    ensure(!splits.has(key) || splits.get(key) === q.split, `${q.id}: identical query in development and test`);
    splits.set(key, q.split);
  }
}

function prepare(corpus, annotations, options = {}) {
  const config = settings(options);
  validateDataset(corpus, annotations);
  const questions = annotations.questions.filter((q) => config.split === "all" || q.split === config.split);
  ensure(questions.length > 0, `No questions for split ${config.split}`);
  const started = performance.now();
  const index = rag.buildPassageIndex(corpus.papers, config);
  ensure(index.passages.length > 0, "No indexable passages");
  return { config, index, questions, buildMs: performance.now() - started };
}

function embeddingInputs(prepared) {
  const entries = new Map();
  for (const text of [...prepared.index.passages.map((p) => p.text), ...prepared.questions.map((q) => q.query)]) {
    entries.set(sha256(text), { textHash: sha256(text), text });
  }
  return { schemaVersion: 1, hashing: "sha256-utf8-exact-text", entries: [...entries.values()] };
}

function validateVectors(cache, prepared, kind) {
  ensure(cache?.schemaVersion === 1 && cache.kind === kind, "Vector cache schema/kind mismatch");
  const model = cache.model;
  ensure(model && ["provider", "name", "revision", "preprocessing"].every((key) => nonempty(model[key])), "Vector model provenance required");
  ensure(Number.isInteger(model.dimensions) && model.dimensions > 0, "Invalid vector dimensions");
  ensure(Array.isArray(cache.entries), "Vector entries required");
  unique(cache.entries, "vectors", (e) => e.textHash);
  const byHash = new Map();
  for (const entry of cache.entries) {
    ensure(typeof entry.textHash === "string" && /^[a-f0-9]{64}$/.test(entry.textHash), "Invalid vector textHash");
    const vector = entry.vector;
    ensure(Array.isArray(vector) && vector.length === model.dimensions && vector.every((v) => typeof v === "number" && Number.isFinite(v)), "Invalid/non-finite/mismatched vector");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    ensure(Number.isFinite(norm) && norm > 0, "Invalid vector norm");
    byHash.set(entry.textHash, vector);
  }
  for (const entry of embeddingInputs(prepared).entries) {
    ensure(byHash.has(entry.textHash), `Missing/stale vector for text hash ${entry.textHash}; regenerate inputs for this configuration`);
  }
  return {
    passages: new Map(prepared.index.passages.map((p) => [p.passageId, byHash.get(sha256(p.text))])),
    queries: new Map(prepared.questions.map((q) => [q.id, byHash.get(sha256(q.query))]))
  };
}

function evidenceMatches(passage, evidence) {
  return passage.paperId === evidence.paperId
    && (passage.estimatedPage || passage.pageNumber === evidence.pageNumber)
    && normalizeQuote(passage.text).includes(normalizeQuote(evidence.quote));
}

function evidenceMatchesContext(passage, evidence, index, windowSize = 1) {
  if (!index?.passages || passage.paperId !== evidence.paperId) return false;
  const context = index.passages
    .filter((candidate) => candidate.paperId === passage.paperId
      && candidate.pageNumber === evidence.pageNumber
      && Boolean(candidate.estimatedPage) === Boolean(passage.estimatedPage)
      && Math.abs(candidate.ordinal - passage.ordinal) <= windowSize)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((candidate) => candidate.text)
    .join("\n");
  return normalizeQuote(context).includes(normalizeQuote(evidence.quote));
}

function scoreResults(question, results, k, indexData = null) {
  const top = results.slice(0, k);
  const hits = new Set();
  const contextHits = new Set();
  let firstRank = null;
  let contextFirstRank = null;
  top.forEach((passage, rankIndex) => {
    for (const e of question.evidence) {
      if (evidenceMatches(passage, e)) {
        hits.add(e.id);
        firstRank ??= rankIndex + 1;
      }
      if (evidenceMatchesContext(passage, e, indexData)) {
        contextHits.add(e.id);
        contextFirstRank ??= rankIndex + 1;
      }
    }
  });
  const pages = [...new Map(question.evidence.map((e) => [JSON.stringify([e.paperId, e.pageNumber]), e])).values()];
  const pageCount = (estimated) => pages.filter((e) => top.some((p) => Boolean(p.estimatedPage) === estimated && p.paperId === e.paperId && p.pageNumber === e.pageNumber)).length;
  return {
    recallAtK: question.answerable ? hits.size / question.evidence.length : null,
    reciprocalRankAtK: question.answerable ? (firstRank === null ? 0 : 1 / firstRank) : null,
    contextRecallAtK: question.answerable ? contextHits.size / question.evidence.length : null,
    contextReciprocalRankAtK: question.answerable ? (contextFirstRank === null ? 0 : 1 / contextFirstRank) : null,
    exactPageRecallAtK: question.answerable ? pageCount(false) / pages.length : null,
    estimatedPageRecallAtK: question.answerable ? pageCount(true) / pages.length : null,
    hitEvidenceIds: [...hits],
    missedEvidenceIds: question.evidence.filter((e) => !hits.has(e.id)).map((e) => e.id),
    contextHitEvidenceIds: [...contextHits],
    missedContextEvidenceIds: question.evidence.filter((e) => !contextHits.has(e.id)).map((e) => e.id),
    returnedCount: top.length
  };
}

function retrieve(mode, prepared, question, vectors) {
  const { config, index } = prepared;
  if (mode === "hybrid") return rag.searchPassagesHybrid(index, question.query, vectors.queries.get(question.id), vectors.passages, config.k, helpers);
  const candidates = mode === "keyword"
    ? rag.searchPassages(index, question.query, 60, helpers)
    : rankVectors(index.passages, vectors.passages, vectors.queries.get(question.id), 60)
      .map((item) => ({ ...item.passage, semanticScore: item.semanticScore }));
  // All baselines use the production hybrid reader's soft diversity policy.
  return rag.diversifyPassages(candidates, config.k);
}

function mean(values) {
  const finite = values.filter((v) => v !== null && Number.isFinite(v));
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : null;
}

function percentile(values, proportion) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(proportion * sorted.length) - 1)];
}

function runEvaluation(corpus, annotations, cache, options = {}) {
  const prepared = prepare(corpus, annotations, options);
  const needsVectors = prepared.config.modes.some((mode) => mode !== "keyword");
  const vectorStart = performance.now();
  const vectors = needsVectors ? validateVectors(cache, prepared, corpus.kind) : null;
  const vectorValidationMs = needsVectors ? performance.now() - vectorStart : 0;
  const runs = [];
  for (const mode of prepared.config.modes) {
    const samples = [];
    const rows = prepared.questions.map((question) => {
      retrieve(mode, prepared, question, vectors);
      let results;
      const latencyMs = [];
      for (let i = 0; i < prepared.config.repeats; i += 1) {
        const start = performance.now();
        results = retrieve(mode, prepared, question, vectors);
        latencyMs.push(performance.now() - start);
      }
      samples.push(...latencyMs);
      return {
        questionId: question.id, query: question.query, type: question.type, answerable: question.answerable,
        ...scoreResults(question, results, prepared.config.k, prepared.index), latencyMs,
        results: results.map((p) => ({
          passageId: p.passageId, paperId: p.paperId, pageNumber: p.pageNumber,
          estimatedPage: p.estimatedPage, text: p.text, lexicalScore: p.score ?? null,
          semanticScore: p.semanticScore ?? null, fusedScore: p.fusedScore ?? null
        }))
      };
    });
    const unanswerable = rows.filter((row) => !row.answerable);
    const metrics = {
      recallAtK: mean(rows.map((r) => r.recallAtK)),
      mrrAtK: mean(rows.map((r) => r.reciprocalRankAtK)),
      contextRecallAtK: mean(rows.map((r) => r.contextRecallAtK)),
      contextMrrAtK: mean(rows.map((r) => r.contextReciprocalRankAtK)),
      exactPageRecallAtK: mean(rows.map((r) => r.exactPageRecallAtK)),
      estimatedPageRecallAtK: mean(rows.map((r) => r.estimatedPageRecallAtK)),
      unanswerableNonemptyRate: mean(unanswerable.map((r) => Number(r.returnedCount > 0))),
      falseSufficientEvidenceRate: null,
      latencyP50Ms: percentile(samples, 0.5), latencyP95Ms: percentile(samples, 0.95)
    };
    runs.push({ mode, metrics, rows });
  }
  return {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    purpose: corpus.kind === "synthetic" ? "synthetic evaluator check, NOT real retrieval quality"
      : annotations.annotationStatus === "verified" ? "human-reviewed source evidence retrieval evaluation, NOT generated answer evaluation"
        : "private draft annotation smoke; NOT validated retrieval quality",
    corpus: { id: corpus.id, version: corpus.version, kind: corpus.kind, sha256: sha256(JSON.stringify(corpus)) },
    annotations: { id: annotations.id, version: annotations.version, annotationStatus: annotations.annotationStatus || "synthetic", sha256: sha256(JSON.stringify(annotations)) },
    settings: {
      ...prepared.config, candidateLimitPerRoute: 60,
      lexicalTermPolicy: "production extractLibraryAiTerms + termAliases",
      diversity: "all modes: max(2, ceil(k/4)) per paper, then fill remaining slots",
      evidencePolicy: "strict: full normalized quote in one chunk; context: retrieved chunk plus one adjacent chunk on the same source page; deduplicate by gold evidence id",
      warmupQueriesPerQuestionPerMode: 1
    },
    model: needsVectors ? { provider: cache.model.provider, name: cache.model.name, revision: cache.model.revision, preprocessing: cache.model.preprocessing, dimensions: cache.model.dimensions } : null,
    embeddingPrecomputation: needsVectors ? cache.generation || null : null,
    vectorCacheSha256: needsVectors ? sha256(JSON.stringify(cache)) : null,
    counts: { papers: corpus.papers.length, passages: prepared.index.passages.length, questions: prepared.questions.length, answerable: prepared.questions.filter((q) => q.answerable).length },
    index: { version: prepared.index.version, cleaningVersion: prepared.index.cleaningVersion, cleaningStats: prepared.index.cleaningStats },
    timing: { indexBuildMs: prepared.buildMs, vectorValidationMs, scope: "warm in-process retrieval only; excludes JSON file reads, network, embedding, and answer generation" },
    externalRequests: 0, embeddingTokens: null,
    unmappedEvidence: prepared.questions.flatMap((q) => q.evidence.filter((e) => !prepared.index.passages.some((p) => evidenceMatches(p, e))).map((e) => ({ questionId: q.id, evidenceId: e.id }))),
    unmappedContextEvidence: prepared.questions.flatMap((q) => q.evidence.filter((e) => !prepared.index.passages.some((p) => evidenceMatchesContext(p, e, prepared.index))).map((e) => ({ questionId: q.id, evidenceId: e.id }))),
    runs
  };
}

function markdownReport(report) {
  const number = (value) => value === null ? "N/A" : value.toFixed(4);
  const safe = (value) => String(value).replace(/[|\r\n]/g, " ").replace(/</g, "&lt;");
  const k = report.settings.k;
  const lines = ["# RAG Evaluation", "", `Purpose: ${report.purpose}`, "", `Split: ${report.settings.split}; questions: ${report.counts.questions}; passages: ${report.counts.passages}.`, "",
    `| Mode | Passage Recall@${k} | Passage MRR@${k} | Context Recall@${k} | Context MRR@${k} | Exact page recall | p50 ms | p95 ms |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const { mode, metrics: m } of report.runs) {
    lines.push(`| ${mode} | ${[m.recallAtK, m.mrrAtK, m.contextRecallAtK, m.contextMrrAtK, m.exactPageRecallAtK, m.latencyP50Ms, m.latencyP95Ms].map(number).join(" | ")} |`);
  }
  lines.push("", "Passage metrics require the full normalized quote in one retrieved chunk. Context metrics use the retrieved chunk plus one adjacent chunk on the same source page, matching the agent reader. Unanswerable nonempty rate measures returned neighbors, NOT false supported answers. Answer sufficiency is not evaluated.", "", "## Strict Passage Misses", "");
  for (const run of report.runs) {
    for (const row of run.rows.filter((r) => r.missedEvidenceIds.length)) {
      lines.push(`- ${run.mode} / ${safe(row.questionId)}: ${safe(row.query)}; missed: ${row.missedEvidenceIds.map(safe).join(", ")}`);
    }
  }
  lines.push("", "## Context Misses", "");
  for (const run of report.runs) {
    for (const row of run.rows.filter((r) => r.missedContextEvidenceIds.length)) {
      lines.push(`- ${run.mode} / ${safe(row.questionId)}: ${safe(row.query)}; missed: ${row.missedContextEvidenceIds.map(safe).join(", ")}`);
    }
  }
  lines.push("", `Unmapped gold anchors: ${report.unmappedEvidence.length} at passage level; ${report.unmappedContextEvidence.length} at context level. These remain in the recall denominator.`, "", "Full rankings, raw timing samples, source hashes and settings are in report.json. Reports can contain private queries and paper text; do not publish without review.", "");
  return lines.join("\n");
}

module.exports = { MODES, sha256, normalizeQuote, settings, validateDataset, prepare, embeddingInputs, validateVectors, evidenceMatches, evidenceMatchesContext, scoreResults, retrieve, percentile, runEvaluation, markdownReport };
