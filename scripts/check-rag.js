const assert = require("assert");
const {
  CLEANING_VERSION,
  contentHash,
  repairEnglishLineBreaks,
  cleanPdfPages,
  detectSectionHeading,
  splitTextIntoChunks,
  validPageOffsets,
  buildPassageIndex,
  searchPassages,
  searchPassagesHybrid,
  readPassages
} = require("../rag.js");

const repaired = repairEnglishLineBreaks("A classifi-\ncation model for long-\ntailed data.");
assert(repaired.text.includes("classification model"), "split English words should be repaired");
assert(repaired.text.includes("long-\ntailed"), "real hyphenated compounds should keep their hyphen");
assert.equal(repaired.repairedHyphenations, 1);

const cleaned = cleanPdfPages([1, 2, 3, 4].map((pageNumber) => ({
  pageNumber,
  text: `Journal of Reliable AI\n${pageNumber === 1 ? "1. Introduction\n" : ""}Body text on page ${pageNumber}.\nCopyright 2026\n${pageNumber}`
})));
assert(cleaned.pages.every((page) => !page.text.includes("Journal of Reliable AI")), "repeated headers should be removed");
assert(cleaned.pages.every((page) => !page.text.includes("Copyright 2026")), "repeated footers should be removed");
assert.equal(cleaned.stats.removedHeaderFooterLines, 8);
assert.equal(cleaned.stats.removedPageNumberLines, 4);
assert.equal(detectSectionHeading("2.3 Proposed Method"), "方法");
assert.equal(contentHash("same text"), contentHash("same text"));

const firstPage = "长尾识别需要缓解类别不平衡问题，并提高尾部类别的识别精度。";
const secondPage = "知识蒸馏通过教师模型向学生模型迁移知识，可用于长尾视觉识别。";
const text = `${firstPage}\n\n${secondPage}`;
const paper = {
  id: "rag-paper",
  titleZh: "长尾识别中的知识蒸馏",
  pageCount: 2,
  keywords: ["长尾识别", "知识蒸馏"],
  text,
  pageTextOffsets: [
    { pageNumber: 1, start: 0, end: firstPage.length },
    { pageNumber: 2, start: firstPage.length + 2, end: text.length }
  ]
};

assert.equal(validPageOffsets(paper).length, 2);
const index = buildPassageIndex([paper]);
assert.equal(index.passages.length, 2);
assert.equal(index.passages[1].pageNumber, 2);
assert.equal(index.passages[1].estimatedPage, false);
assert.equal(index.cleaningVersion, CLEANING_VERSION);
assert.equal(index.passages[0].metadata.pageNumber, 1);
assert.equal(index.passages[0].metadata.contentHash, index.passages[0].contentHash);
assert(Number.isInteger(index.passages[0].pageCharStart));

const results = searchPassages(index, "知识蒸馏", 5, { extractTerms: () => ["知识蒸馏"] });
assert.equal(results[0].pageNumber, 2);
assert(results[0].text.includes("教师模型"));

const chineseQuestion = searchPassages(index, "长尾识别如何缓解类别不平衡问题？", 5, { extractTerms: () => ["长尾识别如何缓解类别不平衡问题"] });
assert.equal(chineseQuestion[0].paperId, "rag-paper", "Chinese question phrases should match title and keyword metadata");

const acronymIndex = buildPassageIndex([{
  id: "acronym-paper",
  title: "Ordinal grading with CLIP-DR",
  pageCount: 1,
  keywords: ["排序感知提示"],
  text: "CLIP-DR uses rank-aware prompts to model ordinal information."
}]);
const acronymQuestion = searchPassages(acronymIndex, "CLIP-DR 如何使用排序感知提示？", 5, { extractTerms: () => ["无关查询"] });
assert.equal(acronymQuestion[0].paperId, "acronym-paper", "Latin acronyms should be extracted from mixed-language queries");

const rarityIndex = buildPassageIndex([
  { id: "common-paper", title: "Learning overview", text: "learning methods and learning systems", pageCount: 1, keywords: [] },
  { id: "rare-paper", title: "Rare concept", text: "rare concept learning methods", pageCount: 1, keywords: [] }
]);
const rarityResults = searchPassages(rarityIndex, "learning rare concept", 5, { extractTerms: () => ["learning", "rare concept"] });
assert.equal(rarityResults[0].paperId, "rare-paper", "specific rare query terms should outweigh ubiquitous terms");

const vectorMap = new Map(index.passages.map((passage) => [
  passage.passageId,
  passage.pageNumber === 2 ? [1, 0] : [0, 1]
]));
const hybrid = searchPassagesHybrid(index, "teacher student transfer", [1, 0], vectorMap, 5, { extractTerms: () => ["teacher student transfer"] });
assert.equal(hybrid[0].pageNumber, 2);
assert.equal(hybrid[0].retrievalMode, "hybrid");
assert.equal(hybrid[0].semanticRank, 1);

const read = readPassages(index, [results[0].passageId], 1);
assert.equal(read.length, 1);
assert(read[0].context.includes("类别不平衡"));

const estimated = buildPassageIndex([{ id: "legacy", title: "旧论文", pageCount: 5, text: "旧格式正文".repeat(300) }]);
assert(estimated.passages.length > 1);
assert(estimated.passages.every((item) => item.estimatedPage));
assert(splitTextIntoChunks("测试文本。".repeat(300)).length > 1);

console.log("RAG checks passed.");
