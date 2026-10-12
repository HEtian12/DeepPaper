const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { executeLocalTool, uniqueIds } = require("../agent.js");
const { retrieveLibraryCandidates, extractLibraryAiTerms, termAliases } = require("../library-ai.js");
const rag = require("../rag.js");

const root = path.join(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "electron", "main.js"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert(indexHtml.indexOf("library-ai.js") < indexHtml.indexOf("agent.js"), "Agent must load after library retrieval helpers");
assert(indexHtml.indexOf("vector-store.js") < indexHtml.indexOf("agent.js"), "Agent must load after vector storage");
assert(preloadSource.includes("runAgentStep"), "preload must expose the Agent step IPC");
assert(preloadSource.includes("createEmbeddings"), "preload must expose the Embedding IPC");
assert(preloadSource.includes("verifyAgentAnswer"), "preload must expose the verification IPC");
assert(mainSource.includes('ipcMain.handle("agent:step"'), "main process must handle Agent steps");
assert(mainSource.includes('ipcMain.handle("embeddings:create"'), "main process must handle embeddings");
assert(mainSource.includes("function sleep(ms)"), "main process must define the retry delay helper");
assert(mainSource.includes('ipcMain.handle("agent:verify"'), "main process must verify evidence");
assert(packageJson.build.files.includes("agent.js"), "Agent renderer must be included in packaged builds");
assert(packageJson.build.files.includes("vector-store.js"), "Vector storage must be included in packaged builds");

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
