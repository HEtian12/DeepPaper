const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syntheticFixture } = require("./evaluation/synthetic.js");
const { prepare, embeddingInputs, validateVectors } = require("./evaluation/core.js");
const { endpointUrl, embedInputs } = require("./evaluation/embed.js");
const { importLibrary } = require("./evaluate-rag.js");
const { extractPdfPages } = require("./evaluation/extract-pdf.js");
const { auditCorpus, annotationCandidates } = require("./evaluation/audit.js");

function writeMinimalPdf(filePath) {
  const content = "BT /F1 18 Tf 72 700 Td (Page mapped evidence) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  fs.writeFileSync(filePath, pdf, "binary");
}

async function main() {
  assert.equal(endpointUrl("https://example.org/v1"), "https://example.org/v1/embeddings");
  assert.equal(endpointUrl("http://127.0.0.1:11434", "ollama"), "http://127.0.0.1:11434/api/embed");
  assert.throws(() => endpointUrl("https://example.org", "ollama"), /local HTTP/);
  assert.throws(() => endpointUrl("http://example.org/v1"), /HTTPS/);
  const { corpus, questions } = syntheticFixture();
  const prepared = prepare(corpus, questions, { split: "all" });
  const inputs = embeddingInputs(prepared);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "deeppaper-eval-embed-"));
  const seen = [];
  const localSeen = [];
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(init.body);
    seen.push(body.input);
    return {
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 0] }], model: "mock-v1", usage: { prompt_tokens: 4, total_tokens: 4 } })
    };
  };
  const args = {
    inputs, out, endpoint: "https://example.org/v1", key: "test-key", model: "mock-v1",
    provider: "mock", revision: "v1", kind: "synthetic", maxInputs: 1, batchSize: 1, fetchImpl
  };
  const localArgs = {
    inputs, out: path.join(out, "ollama"), endpoint: "http://127.0.0.1:11434", key: "",
    model: "qwen3-embedding:0.6b", provider: "ollama", revision: "test-digest", kind: "synthetic",
    maxInputs: 100, batchSize: 3,
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/embed");
      assert.equal(init.headers.Authorization, undefined);
      const body = JSON.parse(init.body);
      localSeen.push(body.input);
      return {
        ok: true,
        json: async () => ({ model: body.model, embeddings: body.input.map(() => [0.25, 0.75]) })
      };
    }
  };
  try {
    const pdfPath = path.join(out, "local.pdf");
    writeMinimalPdf(pdfPath);
    const extracted = await extractPdfPages(pdfPath);
    assert.equal(extracted.pageCount, 1);
    assert(extracted.text.includes("Page mapped evidence"));
    assert.deepEqual(extracted.pageTextOffsets, [{ pageNumber: 1, start: 0, end: extracted.text.length }]);
    const exportPath = path.join(out, "library.json");
    fs.writeFileSync(exportPath, JSON.stringify({ app: "DeepPaper", papers: [
      { ...corpus.papers[0], apiKey: "sensitive", filePath: "C:/private/paper.pdf" },
      { id: "old", text: "no page map", filePath: pdfPath }
    ] }));
    const imported = await importLibrary(exportPath);
    assert.equal(imported.corpus.papers.length, 1);
    assert.deepEqual(imported.excluded, ["old"]);
    const rebuilt = await importLibrary(exportPath, { rebuildPages: true });
    assert.equal(rebuilt.recovered, 1);
    assert.equal(rebuilt.corpus.papers.length, 2);
    assert(rebuilt.corpus.papers[1].text.includes("Page mapped evidence"));
    assert.equal(auditCorpus(rebuilt.corpus).pages, 3);
    assert.equal(annotationCandidates(rebuilt.corpus).papers.length, 2);
    assert.equal(JSON.stringify(imported.corpus).includes("sensitive"), false);
    assert.equal(JSON.stringify(imported.corpus).includes("C:/private"), false);
    const first = await embedInputs(args);
    assert.equal(first.generated, 1);
    assert.equal(first.requests, 1);
    assert.equal(first.remaining, inputs.entries.length - 1);
    const second = await embedInputs(args);
    assert.equal(second.generated, 1);
    assert.equal(second.requests, 2);
    assert.equal(seen.length, 2);
    const final = await embedInputs({ ...args, maxInputs: 100 });
    assert.equal(final.remaining, 0);
    const cache = JSON.parse(fs.readFileSync(final.cachePath, "utf8"));
    assert.equal(cache.generation.requestCount, inputs.entries.length);
    assert.equal(cache.generation.totalTokens, inputs.entries.length * 4);
    assert.equal(validateVectors(cache, prepared, "synthetic").queries.size, 4);
    await assert.rejects(embedInputs({ ...args, model: "different" }), /different model/);
    const local = await embedInputs(localArgs);
    assert.equal(local.remaining, 0);
    assert(localSeen.length > 1);
    assert(localSeen.every(Array.isArray), "Ollama evaluation should use array-input batches");
    const localCache = JSON.parse(fs.readFileSync(local.cachePath, "utf8"));
    assert.equal(localCache.model.provider, "ollama");
    assert.equal(localCache.model.dimensions, 2);
  } finally {
    if (path.resolve(out).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fs.rmSync(out, { recursive: true, force: true });
  }
  console.log("RAG embedding cache checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
