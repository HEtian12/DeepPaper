const fs = require("node:fs");
const path = require("node:path");
const { sha256 } = require("./core.js");

function endpointUrl(value) {
  const url = new URL(String(value));
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("Embedding endpoint must be HTTPS or local HTTP");
  if (url.username || url.password || url.search || url.hash) throw new Error("Embedding endpoint must not contain credentials or query parameters");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/embeddings(?:\/multimodal)?$/i.test(url.pathname)) url.pathname += "/embeddings";
  return url.toString();
}

function validateInputFile(inputs) {
  if (inputs?.schemaVersion !== 1 || inputs.hashing !== "sha256-utf8-exact-text" || !Array.isArray(inputs.entries)) throw new Error("Invalid embedding inputs file");
  const seen = new Set();
  for (const entry of inputs.entries) {
    if (typeof entry.text !== "string" || !entry.text || entry.textHash !== sha256(entry.text)) throw new Error("Embedding input hash mismatch");
    if (seen.has(entry.textHash)) throw new Error("Duplicate embedding input hash");
    seen.add(entry.textHash);
    if (entry.text.length > 8000) throw new Error("Embedding input exceeds the app's 8000 character limit");
  }
}

async function requestVectors(endpoint, key, model, texts, fetchImpl = fetch) {
  const multimodal = /\/embeddings\/multimodal\/?$/i.test(new URL(endpoint).pathname);
  if (multimodal && texts.length !== 1) throw new Error("Multimodal endpoint requires batch size 1");
  const body = multimodal
    ? { model, input: [{ type: "text", text: texts[0] }], encoding_format: "float" }
    : { model, input: texts.length === 1 ? texts[0] : texts, encoding_format: "float" };
  const response = await fetchImpl(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Embedding API returned ${response.status}; stop and check the provider console. Existing batches remain saved.`);
  const data = await response.json();
  const entries = multimodal ? [data?.data?.embedding] : (Array.isArray(data?.data) ? [...data.data].sort((a, b) => Number(a.index) - Number(b.index)).map((item) => item.embedding) : []);
  if (entries.length !== texts.length || !entries.every((v) => Array.isArray(v) && v.length && v.every((n) => typeof n === "number" && Number.isFinite(n)) && v.some((n) => n !== 0))) throw new Error("Embedding API returned invalid vectors");
  return { vectors: entries, usage: data.usage || null, responseModel: data.model || null };
}

async function embedInputs({ inputs, out, endpoint, key, model, provider, revision, kind, maxInputs, batchSize, fetchImpl = fetch, progress = () => {} }) {
  validateInputFile(inputs);
  if (!key || !model || !provider || !revision || !["real", "synthetic"].includes(kind)) throw new Error("Embedding key, model, provider, revision and kind required");
  if (!Number.isInteger(maxInputs) || maxInputs < 1 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error("Invalid --max-inputs or --batch");
  const url = endpointUrl(endpoint);
  const multimodal = /\/embeddings\/multimodal\/?$/i.test(new URL(url).pathname);
  if (multimodal && batchSize !== 1) throw new Error("Multimodal endpoint requires --batch 1");
  fs.mkdirSync(out, { recursive: true });
  const cachePath = path.join(out, "vectors.json");
  const journalPath = path.join(out, "vectors.ndjson");
  const existing = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : null;
  const cache = existing || {
    schemaVersion: 1, kind, endpoint: url,
    model: { provider, name: model, revision, preprocessing: "exact evaluation input text", dimensions: null },
    generation: { requestCount: 0, promptTokens: 0, totalTokens: 0 }, entries: []
  };
  if (cache.schemaVersion !== 1 || cache.kind !== kind || cache.endpoint !== url || cache.model?.provider !== provider || cache.model.name !== model || cache.model.revision !== revision || !Array.isArray(cache.entries)) throw new Error("Existing vectors.json is for a different model/endpoint/dataset kind");
  const seen = new Set(cache.entries.map((entry) => entry.textHash));
  if (seen.size !== cache.entries.length) throw new Error("Duplicate vectors in existing cache");
  if (fs.existsSync(journalPath)) {
    const records = fs.readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const header = records.shift();
    if (header?.type !== "header" || header.endpoint !== url || header.kind !== kind || header.model !== model || header.provider !== provider || header.revision !== revision) throw new Error("Existing vector journal is for a different model/endpoint/dataset kind");
    for (const record of records) {
      if (record.type !== "batch" || !Array.isArray(record.entries)) throw new Error("Invalid vector journal batch");
      const fresh = record.entries.filter((entry) => !seen.has(entry.textHash));
      if (fresh.length && fresh.length !== record.entries.length) throw new Error("Partially duplicated vector journal batch");
      if (!fresh.length) continue;
      for (const entry of fresh) {
        if (cache.model.dimensions && entry.vector.length !== cache.model.dimensions) throw new Error("Vector journal dimension mismatch");
        cache.model.dimensions = entry.vector.length;
        cache.entries.push(entry);
        seen.add(entry.textHash);
      }
      cache.model.responseModel = record.responseModel || cache.model.responseModel || null;
      cache.generation.requestCount += 1;
      cache.generation.promptTokens += Number(record.usage?.prompt_tokens) || 0;
      cache.generation.totalTokens += Number(record.usage?.total_tokens) || 0;
    }
  } else {
    fs.writeFileSync(journalPath, `${JSON.stringify({ type: "header", endpoint: url, kind, model, provider, revision })}\n`, "utf8");
  }
  const remaining = inputs.entries.filter((entry) => !seen.has(entry.textHash));
  let generated = 0;
  for (let offset = 0; offset < Math.min(remaining.length, maxInputs); offset += batchSize) {
    const batch = remaining.slice(offset, Math.min(offset + batchSize, maxInputs));
    const result = await requestVectors(url, key, model, batch.map((entry) => entry.text), fetchImpl);
    if (cache.model.responseModel && result.responseModel && cache.model.responseModel !== result.responseModel) throw new Error("Provider response model changed across batches");
    const dimension = result.vectors[0].length;
    if (result.vectors.some((v) => v.length !== dimension) || (cache.model.dimensions && cache.model.dimensions !== dimension)) throw new Error("Embedding dimension changed across batches");
    cache.model.dimensions = dimension;
    cache.model.responseModel = result.responseModel || cache.model.responseModel || null;
    const newEntries = batch.map((entry, index) => ({ textHash: entry.textHash, vector: result.vectors[index] }));
    fs.appendFileSync(journalPath, `${JSON.stringify({ type: "batch", entries: newEntries, usage: result.usage, responseModel: result.responseModel })}\n`, "utf8");
    newEntries.forEach((entry) => { cache.entries.push(entry); seen.add(entry.textHash); });
    cache.generation.requestCount += 1;
    cache.generation.promptTokens += Number(result.usage?.prompt_tokens) || 0;
    cache.generation.totalTokens += Number(result.usage?.total_tokens) || 0;
    generated += batch.length;
    progress({ generated, remaining: remaining.length - generated, requests: cache.generation.requestCount });
  }
  if (remaining.length === generated) {
    const temporary = `${cachePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(cache)}\n`, "utf8");
    fs.renameSync(temporary, cachePath);
    fs.unlinkSync(journalPath);
  }
  return { cachePath, generated, remaining: remaining.length - generated, requests: cache.generation.requestCount };
}

module.exports = { endpointUrl, validateInputFile, requestVectors, embedInputs };
