const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { executeLocalTool, uniqueIds } = require("../agent.js");
const { validateToolCall, normalizeReadPaperIds } = require("../agent-tools.js");
const { retrieveLibraryCandidates, extractLibraryAiTerms, termAliases } = require("../library-ai.js");
const rag = require("../rag.js");

const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert(indexHtml.indexOf("library-ai.js") < indexHtml.indexOf("agent.js"), "Agent must load after library retrieval helpers");
assert(indexHtml.indexOf("vector-store.js") < indexHtml.indexOf("agent.js"), "Agent must load after vector storage");
assert(indexHtml.indexOf("agent-tools.js") < indexHtml.indexOf("agent.js"), "Agent tool schemas must load before the renderer Agent");
assert(preloadSource.includes("runAgentStep"), "preload must expose the Agent step IPC");
assert(preloadSource.includes("cancelAgentRun"), "preload must expose Agent cancellation");
assert(preloadSource.includes("createEmbeddings"), "preload must expose the Embedding IPC");
assert(preloadSource.includes("verifyAgentAnswer"), "preload must expose the verification IPC");
assert(mainSource.includes('ipcMain.handle("agent:step"'), "main process must handle Agent steps");
assert(mainSource.includes('ipcMain.handle("embeddings:create"'), "main process must handle embeddings");
assert(mainSource.includes('body: JSON.stringify({ model, input: values })'), "local Ollama embeddings must use the /api/embed request format");
assert(mainSource.includes("function sleep(ms)"), "main process must define the retry delay helper");
assert(mainSource.includes('ipcMain.handle("agent:verify"'), "main process must verify evidence");
assert(packageJson.build.files.includes("agent.js"), "Agent renderer must be included in packaged builds");
assert(packageJson.build.files.includes("vector-store.js"), "Vector storage must be included in packaged builds");
assert(packageJson.build.files.includes("agent-tools.js"), "Agent tool schemas must be included in packaged builds");
assert(mainSource.includes("validateToolCall(value.tool)"), "main process must validate Agent tool calls before returning them");
assert(mainSource.includes('ipcMain.handle("agent:cancel"'), "main process must handle Agent cancellation");
assert(mainSource.includes("signal: controller.signal"), "Agent model requests must accept cancellation signals");
const agentSource = fs.readFileSync(path.join(root, "agent.js"), "utf8");
assert(agentSource.includes("renderExecutionTrace"), "Agent UI must expose execution traces");
assert(agentSource.includes("data-agent-retry"), "Agent UI must expose failed-task retry");
assert(agentSource.includes("task.stepsCompleted"), "Agent must resume from its completed-step checkpoint");

assert.equal(validateToolCall({ name: "search_library", arguments: { query: "long tail", limit: 5 } }).ok, true);
assert.equal(validateToolCall({ name: "search_library", arguments: { query: "x", limit: 31 } }).ok, false);
assert.equal(validateToolCall({ name: "search_library", arguments: { query: "x", debug: true } }).ok, false);
assert.equal(validateToolCall({ name: "read_papers", arguments: { paper_ids: ["paper-a"], sections: ["unknown"] } }).ok, false);
assert.equal(validateToolCall({ name: "read_papers", arguments: { paper_ids: Array.from({ length: 7 }, (_, i) => `paper-${i}`), sections: ["method"] } }).ok, false);
assert.equal(validateToolCall({ name: "compare_papers", arguments: { paper_ids: ["paper-a", "paper-a"], focus: "method" } }).ok, false);
assert.equal(validateToolCall({ name: "not_a_tool", arguments: {} }).ok, false);
const searchTranscript = [{ type: "tool_result", tool: "search_library", result: JSON.stringify({ papers: [
  { paper_id: "paper-a", title: "Paper A" },
  { paper_id: "paper-b", title: "Paper B" },
  { paper_id: "paper-c", title: "Paper C" },
  { paper_id: "paper-d", title: "Paper D" },
  { paper_id: "paper-e", title: "Paper E" },
  { paper_id: "paper-f", title: "Paper F" },
  { paper_id: "paper-g", title: "Paper G" }
] }) }];
const normalizedRead = normalizeReadPaperIds({ name: "read_papers", arguments: { paper_ids: ["Paper A", "paper-b", "Paper C", "Paper D", "Paper E", "Paper F", "Paper G", "bogus"], sections: ["method"] } }, searchTranscript);
assert.deepEqual(normalizedRead.arguments.paper_ids, ["paper-a", "paper-b", "paper-c", "paper-d", "paper-e", "paper-f"]);
assert.equal(validateToolCall(normalizedRead).ok, true);

async function run() {
const papers = [
  {
    id: "paper-a",
    titleZh: "长尾识别中的知识蒸馏",
    titleEn: "Knowledge Distillation for Long-tailed Recognition",
    year: "2025",
    venue: "CVPR",
    keywords: ["长尾识别", "知识蒸馏"],
    text: "长尾识别需要处理类别不平衡。知识蒸馏通过教师学生框架迁移知识。",
    pageCount: 1,
    pageTextOffsets: [{ pageNumber: 1, start: 0, end: 34 }],
    analysis: {
      abstract_zh: "研究长尾识别中的知识蒸馏。",
      motivation: "缓解类别不平衡。",
      method: "教师学生框架。",
      contributions: ["提出蒸馏方法"],
      main_results: "提升尾类精度。"
    }
  },
  {
    id: "paper-b",
    titleZh: "通用目标检测",
    year: "2024",
    venue: "ICCV",
    keywords: ["目标检测"],
    text: "object detection",
    analysis: { abstract_zh: "通用检测方法。" }
  }
];

const retrieve = (library, query, limit) => retrieveLibraryCandidates(library, query, limit);
const search = await executeLocalTool({ name: "search_library", arguments: { query: "长尾识别，知识蒸馏", limit: 10 } }, papers, retrieve);
assert.equal(search.ok, true);
assert.equal(search.papers[0].paper_id, "paper-a");
const rejectedSearch = await executeLocalTool({ name: "search_library", arguments: { query: "x", limit: 99 } }, papers, retrieve);
assert.equal(rejectedSearch.ok, false);

const read = await executeLocalTool({ name: "read_papers", arguments: { paper_ids: ["paper-a"], sections: ["method"] } }, papers, retrieve);
assert.equal(read.papers.length, 1);
assert.equal(read.papers[0].method, "教师学生框架。");
assert.equal(read.papers[0].abstract, undefined);

const ragApi = { ...rag, extractTerms: extractLibraryAiTerms, termAliases };
const passageSearch = await executeLocalTool({ name: "search_passages", arguments: { query: "知识蒸馏", limit: 5 } }, papers, retrieve, ragApi);
assert.equal(passageSearch.ok, true);
assert.equal(passageSearch.passages[0].paper_id, "paper-a");
const allPassages = rag.buildPassageIndex(papers).passages;
const hybridSearch = await executeLocalTool(
  { name: "search_passages", arguments: { query: "teacher student transfer", limit: 5 } },
  papers,
  retrieve,
  ragApi,
  {
    embeddingConfig: { embeddingEnabled: true },
    vectorStore: {
      getVectorMap: async () => new Map(allPassages.map((passage) => [passage.passageId, passage.paperId === "paper-a" ? [1, 0] : [0, 1]]))
    },
    createEmbeddings: async () => ({ ok: true, vectors: [[1, 0]] })
  }
);
assert.equal(hybridSearch.retrievalMode, "hybrid");
assert.equal(hybridSearch.passages[0].paper_id, "paper-a");
assert.equal(hybridSearch.passages[0].semantic_rank, 1);
const passageRead = await executeLocalTool({ name: "read_passages", arguments: { passage_ids: [passageSearch.passages[0].passage_id] } }, papers, retrieve, ragApi);
assert.equal(passageRead.passages.length, 1);
assert(passageRead.passages[0].context.includes("教师学生"));

const evidenceMap = await executeLocalTool({ name: "build_evidence_map", arguments: { paper_ids: ["paper-a", "paper-b"] } }, papers, retrieve, ragApi);
assert.equal(evidenceMap.ok, true);
assert.equal(evidenceMap.evidenceMap.papers.length, 2);
assert.equal(evidenceMap.evidenceMap.papers[0].method, "教师学生框架。");

const proposal = await executeLocalTool({
  name: "propose_collection",
  arguments: { name: "长尾蒸馏", paper_ids: ["paper-a", "missing"], rationale: "与主题直接相关" }
}, papers, retrieve);
assert.equal(proposal.ok, true);
assert.deepEqual(proposal.proposal.paperIds, ["paper-a"]);
assert.equal(proposal.proposal.status, "pending");
assert.deepEqual(uniqueIds(["a", "a", "b"]), ["a", "b"]);

console.log("Agent checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
