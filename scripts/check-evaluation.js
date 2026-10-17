const assert = require("node:assert/strict");
const { syntheticFixture } = require("./evaluation/synthetic.js");
const {
  prepare, embeddingInputs, validateDataset, validateVectors, scoreResults,
  runEvaluation, evidenceMatches, markdownReport
} = require("./evaluation/core.js");
const { splitTextIntoChunks, buildPassageIndex, readPassages } = require("../rag.js");

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

const spanningText = `${"x".repeat(310)}EVIDENCE_SPANS_CHUNKS${"y".repeat(300)}`;
const spanningIndex = buildPassageIndex([{
  id: "split-evidence", title: "Chunk boundary fixture", text: spanningText,
  pageCount: 1, pageTextOffsets: [{ pageNumber: 1, start: 0, end: spanningText.length }], keywords: []
}], { target: 320, overlap: 0, cleaning: false });
const spanningEvidence = { id: "split-e1", paperId: "split-evidence", pageNumber: 1, quote: "EVIDENCE_SPANS_CHUNKS", relevance: 2 };
const spanningQuestion = { answerable: true, evidence: [spanningEvidence] };
const strictPassage = spanningIndex.passages[0];
assert(!evidenceMatches(strictPassage, spanningEvidence), "strict metric should require a quote within one chunk");
assert(readPassages(spanningIndex, [strictPassage.passageId], 1)[0].context.replace(/\s+/gu, "").includes(spanningEvidence.quote), "reader context should recover evidence crossing an adjacent chunk boundary");
const spanningScores = scoreResults(spanningQuestion, [strictPassage], 1, spanningIndex);
assert.equal(spanningScores.recallAtK, 0);
assert.equal(spanningScores.contextRecallAtK, 1);
assert.deepEqual(spanningScores.missedContextEvidenceIds, []);
assert.equal(scoreResults({ answerable: true, evidence: [{ ...spanningEvidence, pageNumber: 2 }] }, [strictPassage], 1, spanningIndex).contextRecallAtK, 0, "context evidence must not cross source pages");

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
assert(Number.isFinite(report.runs[0].metrics.contextRecallAtK));
assert(report.runs.every((run) => run.rows.length === 4));
assert(markdownReport(report).includes("synthetic evaluator check"));

console.log("RAG evaluation checks passed.");
