const assert = require("assert");
const {
  normalizeConfig,
  configKey,
  contentHash,
  passageFingerprint,
  groupPassagesByFingerprint,
  cosineSimilarity,
  rankVectors,
  shouldReduceEmbeddingBatch
} = require("../vector-store.js");

const config = normalizeConfig({
  embeddingEnabled: true,
  embeddingBaseUrl: "https://example.com/v1/",
  apiKey: "chat-key",
  embeddingModel: "embedding-model"
});
assert.equal(config.enabled, true);
assert.equal(config.baseUrl, "https://example.com/v1");
assert.equal(config.apiKey, "chat-key");
assert.equal(configKey(config), configKey({ ...config }));
assert.equal(configKey(config), configKey({ ...config, provider: "api" }), "existing cloud vector cache keys must remain compatible");
const localConfig = normalizeConfig({
  embeddingEnabled: true,
  embeddingProvider: "ollama",
  embeddingBaseUrl: "http://127.0.0.1:11434",
  embeddingModel: "bge-m3"
});
assert.equal(localConfig.provider, "ollama");
assert.equal(localConfig.apiKey, "");
assert.notEqual(configKey(config), configKey(localConfig), "cloud and local model vectors must not share a cache namespace");

const passage = { passageId: "p1", text: "长尾识别与知识蒸馏" };
assert.equal(passageFingerprint(passage), passageFingerprint({ ...passage }));
assert.equal(passageFingerprint({ ...passage, contentHash: "stale-hash" }), contentHash(passage.text));
assert.equal(groupPassagesByFingerprint([
  { passageId: "p1", text: "重复正文", contentHash: "same" },
  { passageId: "p2", text: "重复正文", contentHash: "same" },
  { passageId: "p3", text: "其他正文", contentHash: "other" }
]).length, 2, "duplicate passage content should share one embedding work group");
assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
assert.equal(shouldReduceEmbeddingBatch(new Error("Embedding 请求失败：500 InternalServiceError")), true);
assert.equal(shouldReduceEmbeddingBatch(new Error("Embedding 请求失败：401 Unauthorized")), false);

const ranked = rankVectors(
  [passage, { passageId: "p2", text: "目标检测" }],
  new Map([["p1", [1, 0]], ["p2", [0, 1]]]),
  [0.9, 0.1],
  2
);
assert.equal(ranked[0].passage.passageId, "p1");
assert(ranked[0].semanticScore > ranked[1].semanticScore);

console.log("Vector store checks passed.");
