const assert = require("node:assert/strict");
const { syntheticFixture } = require("./evaluation/synthetic.js");
const {
  prepare, embeddingInputs, validateDataset, validateVectors, scoreResults,
  runEvaluation, evidenceMatches, markdownReport
} = require("./evaluation/core.js");
const { splitTextIntoChunks, buildPassageIndex } = require("../rag.js");

const { corpus, questions, vectors } = syntheticFixture();
const prepared = prepare(corpus, questions, { split: "all", k: 2, repeats: 2 });
assert.equal(prepared.index.passages.length, 5);
assert.equal(prepared.questions.length, 4);
assert.equal(embeddingInputs(prepared).entries.length, 9);

const badQuote = structuredClone(questions);
badQuote.questions[0].evidence[0].quote = "invented evidence";
assert.throws(() => validateDataset(corpus, badQuote), /quote not found/);
const badPage = structuredClone(questions);
badPage.questions[0].evidence[0].pageNumber = 2;
assert.throws(() => validateDataset(corpus, badPage), /quote not found/);
const duplicate = structuredClone(questions);
duplicate.questions[0].evidence.push({ ...duplicate.questions[0].evidence[0], id: "e1-copy" });
assert.throws(() => validateDataset(corpus, duplicate), /duplicate identifiers/);
const leak = structuredClone(questions);
leak.questions[1].query = leak.questions[0].query;
assert.throws(() => validateDataset(corpus, leak), /identical query/);
const noOffsets = structuredClone(corpus);
delete noOffsets.papers[0].pageTextOffsets;
assert.throws(() => validateDataset(noOffsets, questions), /verified PDF page offsets/);
const realDraft = structuredClone(questions);
realDraft.kind = "real";
const realCorpus = { ...corpus, kind: "real" };
assert.throws(() => validateDataset(realCorpus, realDraft), /annotationStatus/);
realDraft.annotationStatus = "draft";
assert.equal(runEvaluation(realCorpus, realDraft, null, { modes: ["keyword"], repeats: 1 }).annotations.annotationStatus, "draft");

const missingVector = structuredClone(vectors);
missingVector.entries.pop();
assert.throws(() => validateVectors(missingVector, prepared, "synthetic"), /Missing\/stale vector/);
const wrongDimension = structuredClone(vectors);
wrongDimension.entries[0].vector = [1];
assert.throws(() => validateVectors(wrongDimension, prepared, "synthetic"), /mismatched vector/);
assert.throws(() => runEvaluation(corpus, questions, null, { split: "all", modes: ["vector"] }), /Vector cache/);

const gold = questions.questions[0];
const hit = prepared.index.passages.find((p) => p.paperId === "demo-a" && p.pageNumber === 1);
const repeated = scoreResults(gold, [hit, { ...hit, passageId: "overlapping-copy" }], 2);
assert.equal(repeated.recallAtK, 1);
assert.equal(repeated.reciprocalRankAtK, 1);
assert.equal(repeated.hitEvidenceIds.length, 1);
const estimated = { ...hit, pageNumber: 99, estimatedPage: true };
assert(evidenceMatches(estimated, gold.evidence[0]));
const estimatedScore = scoreResults(gold, [estimated], 1);
assert.equal(estimatedScore.recallAtK, 1);
assert.equal(estimatedScore.exactPageRecallAtK, 0);
assert.equal(estimatedScore.estimatedPageRecallAtK, 0);
const noAnswer = scoreResults(questions.questions[3], [hit], 1);
assert.equal(noAnswer.recallAtK, null);
assert.equal(noAnswer.returnedCount, 1);

const longText = "A sentence about semantic ranking and citations. ".repeat(35);
const withoutOverlap = splitTextIntoChunks(longText, { target: 400, overlap: 0 });
const withOverlap = splitTextIntoChunks(longText, { target: 400, overlap: 100 });
assert(withoutOverlap.length > 1);
assert(withOverlap.length > withoutOverlap.length);
assert(withoutOverlap.every((item, i) => i === 0 || item.start === withoutOverlap[i - 1].end));
const header = [1, 2, 3, 4].map((pageNumber) => `Shared Journal Header\nUnique body on page ${pageNumber}.\n${pageNumber}`);
const text = header.join("\n\n");
let offset = 0;
const offsets = header.map((page, i) => {
  const start = offset;
  offset += page.length + 2;
  return { pageNumber: i + 1, start, end: start + page.length };
});
const paper = { id: "cleaning-check", text, pageCount: 4, pageTextOffsets: offsets, keywords: [] };
const cleaned = buildPassageIndex([paper]);
const raw = buildPassageIndex([paper], { cleaning: false });
assert.equal(cleaned.cleaningVersion, 1);
assert.equal(raw.cleaningVersion, 0);
assert(cleaned.passages.every((p) => !p.text.includes("Shared Journal Header")));
assert(raw.passages.every((p) => p.text.includes("Shared Journal Header")));

const report = runEvaluation(corpus, questions, vectors, { split: "all", modes: ["keyword", "vector", "hybrid"], k: 2, repeats: 2 });
assert.equal(report.runs.length, 3);
assert.equal(report.counts.questions, 4);
assert.equal(report.externalRequests, 0);
assert.equal(report.runs[0].metrics.falseSufficientEvidenceRate, null);
assert(report.runs.every((run) => run.rows.length === 4));
assert(markdownReport(report).includes("synthetic evaluator check"));

console.log("RAG evaluation checks passed.");
