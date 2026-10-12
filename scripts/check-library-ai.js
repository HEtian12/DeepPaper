const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  extractLibraryAiTerms,
  retrieveLibraryCandidates,
  toApiCandidate,
  toLocalMatch
} = require("../library-ai.js");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const indexHtml = read("index.html");
const preloadSource = read(path.join("electron", "preload.js"));
const mainSource = read(path.join("electron", "main.js"));
const packageJson = JSON.parse(read("package.json"));

assert(indexHtml.includes('<script src="./library-ai.js"></script>'), "index.html must load library-ai.js");
assert(
  indexHtml.indexOf('<script src="./library-ai.js"></script>') > indexHtml.indexOf('<script src="./app.js"></script>'),
  "library-ai.js must load after app.js"
);
assert(preloadSource.includes('chatWithLibrary: (payload) => ipcRenderer.invoke("library:ai-chat", payload)'), "preload bridge missing");
assert(mainSource.includes('ipcMain.handle("library:ai-chat"'), "library AI IPC handler missing");
assert(packageJson.build.files.includes("library-ai.js"), "library-ai.js missing from packaged files");

const terms = extractLibraryAiTerms("帮我找到同时涉及长尾分布和知识蒸馏的论文");
assert.deepStrictEqual(terms, ["长尾分布", "知识蒸馏"], "Chinese conjunction query should become two strict concepts");

const mockPapers = [
  {
    id: "both",
    titleZh: "面向长尾识别的数据集蒸馏",
    titleEn: "Long-tailed Dataset Distillation",
    year: 2026,
    venue: "AAAI",
    keywords: ["长尾分布", "知识蒸馏", "类别不平衡"],
    analysis: {
      abstract_zh: "研究长尾数据上的知识蒸馏问题。",
      method: { method_name: "双教师蒸馏" }
    }
  },
  {
    id: "tail-only",
    titleZh: "长尾视觉识别",
    year: 2025,
    keywords: ["长尾识别", "类别不平衡"],
    analysis: { abstract_zh: "研究类别不平衡条件下的视觉识别。" }
  },
  {
    id: "other",
    titleZh: "自动抑郁识别",
    year: 2024,
    keywords: ["抑郁识别", "多模态"],
    analysis: { abstract_zh: "根据视频和音频判断抑郁程度。" }
  }
];

const results = retrieveLibraryCandidates(mockPapers, "长尾分布和知识蒸馏", 10);
assert.strictEqual(results[0].id, "both", "paper matching all concepts should rank first");
assert.deepStrictEqual(results[0].matchedTerms, ["长尾分布", "知识蒸馏"], "matched terms should be preserved");
assert(results.some((item) => item.id === "tail-only"), "semantic long-tail expansion should recall related paper");
assert(!results.some((item) => item.id === "other"), "unrelated paper should not enter scored results");

const apiCandidate = toApiCandidate(results[0]);
assert.strictEqual(apiCandidate.id, "both");
assert(!Object.prototype.hasOwnProperty.call(apiCandidate, "_fields"), "private local search fields must not be sent to AI");

const localMatch = toLocalMatch(results[0]);
assert.strictEqual(localMatch.paperId, "both");
assert(localMatch.reason.includes("长尾分布"), "local match should explain the matched terms");

const libraryAiSource = read("library-ai.js");
assert(libraryAiSource.includes("查看全部本地匹配"), "library AI must offer an all-local-matches view");
assert(libraryAiSource.includes("allLocalCandidates.slice(0, MAX_CANDIDATES)"), "only the top candidates should be sent to AI");

console.log("library-ai checks passed");
