(function initDeepPaperVectorStore(root) {
  const DB_NAME = "deeppaper.semantic-index.v1";
  const STORE_NAME = "passage_vectors";
  const DB_VERSION = 1;

  function normalizeConfig(config = {}) {
    const baseUrl = String(config.embeddingBaseUrl || config.baseUrl || "").trim().replace(/\/+$/, "");
    return {
      enabled: Boolean(config.embeddingEnabled ?? config.enabled),
      baseUrl,
      apiKey: String(config.embeddingApiKey || config.apiKey || "").trim(),
      model: String(config.embeddingModel || config.model || "").trim()
    };
  }

  function hashText(value, seed = 2166136261) {
    let hash = seed >>> 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function contentHash(value) {
    const text = String(value || "");
    return `${text.length}:${hashText(text)}${hashText(text, 3339675911)}`;
  }

  function configKey(config = {}) {
    const normalized = normalizeConfig(config);
    return hashText(`${normalized.baseUrl}|${normalized.model}`);
  }

  function passageFingerprint(passage) {
    return contentHash(passage?.text);
  }

  function groupPassagesByFingerprint(passages) {
    const groups = new Map();
    (Array.isArray(passages) ? passages : []).forEach((passage) => {
      const fingerprint = passageFingerprint(passage);
      if (!groups.has(fingerprint)) groups.set(fingerprint, []);
      groups.get(fingerprint).push(passage);
    });
    return [...groups.values()];
  }

  function cosineSimilarity(left, right) {
    if (!left?.length || left.length !== right?.length) return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
      const a = Number(left[index]) || 0;
      const b = Number(right[index]) || 0;
      dot += a * b;
      leftNorm += a * a;
      rightNorm += b * b;
    }
    if (!leftNorm || !rightNorm) return -1;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  function rankVectors(passages, vectorMap, queryVector, limit = 60) {
    const vectors = vectorMap instanceof Map ? vectorMap : new Map(Object.entries(vectorMap || {}));
    return (Array.isArray(passages) ? passages : [])
      .map((passage) => ({
        passage,
        semanticScore: cosineSimilarity(queryVector, vectors.get(passage.passageId))
      }))
      .filter((item) => Number.isFinite(item.semanticScore) && item.semanticScore > -1)
      .sort((a, b) => b.semanticScore - a.semanticScore)
      .slice(0, Math.max(1, Number(limit) || 60));
  }

  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB 请求失败。"));
    });
  }

  function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB 写入失败。"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 写入已取消。"));
    });
  }

  function openDatabase() {
    if (!root.indexedDB) return Promise.reject(new Error("当前环境不支持本地向量索引。"));
    return new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("configKey", "configKey", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地向量索引。"));
    });
  }

  async function getRecordsForConfig(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      return await requestPromise(transaction.objectStore(STORE_NAME).index("configKey").getAll(key));
    } finally {
      database.close();
    }
  }

  async function getVectorMap(passages, config) {
    const key = configKey(config);
    const records = await getRecordsForConfig(key);
    const fingerprints = new Map((Array.isArray(passages) ? passages : []).map((passage) => [passage.passageId, passageFingerprint(passage)]));
    return new Map(records
      .filter((record) => fingerprints.get(record.passageId) === record.fingerprint)
      .map((record) => [record.passageId, record.vector]));
  }

  async function getMetadataMap(passages, config) {
    const key = configKey(config);
    const records = await getRecordsForConfig(key);
    const fingerprints = new Map((Array.isArray(passages) ? passages : []).map((passage) => [passage.passageId, passageFingerprint(passage)]));
    return new Map(records
      .filter((record) => fingerprints.get(record.passageId) === record.fingerprint)
      .map((record) => [record.passageId, record.metadata || {}]));
  }

  async function getStatus(passages, config) {
    const list = Array.isArray(passages) ? passages : [];
    if (!normalizeConfig(config).enabled) return { enabled: false, configured: false, total: list.length, indexed: 0, missing: list.length };
    const normalized = normalizeConfig(config);
    const configured = Boolean(normalized.baseUrl && normalized.apiKey && normalized.model);
    if (!configured) return { enabled: true, configured: false, total: list.length, indexed: 0, missing: list.length };
    const vectorMap = await getVectorMap(list, config);
    const firstVector = vectorMap.values().next().value;
    return {
      enabled: true,
      configured: true,
      total: list.length,
      indexed: vectorMap.size,
      missing: Math.max(0, list.length - vectorMap.size),
      dimension: firstVector?.length || 0
    };
  }

  async function writeRecords(records) {
    if (!records.length) return;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      records.forEach((record) => store.put(record));
      await transactionPromise(transaction);
    } finally {
      database.close();
    }
  }

  async function removeStaleRecords(key, currentIds) {
    const records = await getRecordsForConfig(key);
    const stale = records.filter((record) => !currentIds.has(record.passageId));
    if (!stale.length) return;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      stale.forEach((record) => store.delete(record.id));
      await transactionPromise(transaction);
    } finally {
      database.close();
    }
  }

  function shouldReduceEmbeddingBatch(error) {
    const message = String(error?.message || error || "");
    return /\b(500|502|503|504)\b|InternalServiceError|Internal Server Error|unexpected internal error|batch.{0,20}(?:large|limit)|Embedding 返回数量|维度不一致/i.test(message);
  }

  function passageVectorMetadata(passage) {
    return {
      ...(passage?.metadata && typeof passage.metadata === "object" ? passage.metadata : {}),
      paperId: passage?.paperId || "",
      title: passage?.title || "",
      year: passage?.year || "",
      venue: passage?.venue || "",
      authors: Array.isArray(passage?.authors) ? passage.authors : [],
      keywords: Array.isArray(passage?.keywords) ? passage.keywords : [],
      section: passage?.section || "",
      pageNumber: Number(passage?.pageNumber) || null,
      estimatedPage: Boolean(passage?.estimatedPage),
      ordinal: Number(passage?.ordinal) || 0,
      pageCharStart: Number(passage?.pageCharStart) || 0,
      pageCharEnd: Number(passage?.pageCharEnd) || 0,
      cleaningVersion: Number(passage?.cleaningVersion) || 0,
      contentHash: passageFingerprint(passage)
    };
  }

  function createVectorRecord(key, model, passage, vector, dimension, updatedAt = new Date().toISOString()) {
    const metadata = passageVectorMetadata(passage);
    return {
      id: `${key}:${passage.passageId}`,
      configKey: key,
      passageId: passage.passageId,
      paperId: passage.paperId,
      fingerprint: passageFingerprint(passage),
      contentHash: metadata.contentHash,
      cleaningVersion: metadata.cleaningVersion,
      pageNumber: metadata.pageNumber,
      section: metadata.section,
      metadata,
      model,
      dimension,
      vector: Float32Array.from(vector),
      updatedAt
    };
  }

  async function indexPassages(passages, config, embedTexts, onProgress = () => {}) {
    const list = Array.isArray(passages) ? passages.filter((passage) => passage?.passageId && passage?.text) : [];
    const normalized = normalizeConfig(config);
    if (!normalized.enabled || !normalized.baseUrl || !normalized.apiKey || !normalized.model) {
      throw new Error("请先在当前接口中完整配置并启用 Embedding。" );
    }
    if (typeof embedTexts !== "function") throw new Error("Embedding 调用模块未加载。" );

    const key = configKey(config);
    const existing = await getRecordsForConfig(key);
    const fingerprints = new Map(list.map((passage) => [passage.passageId, passageFingerprint(passage)]));
    const valid = new Map(existing
      .filter((record) => fingerprints.get(record.passageId) === record.fingerprint)
      .map((record) => [record.passageId, record]));
    const missing = list.filter((passage) => !valid.has(passage.passageId));
    const existingByFingerprint = new Map(existing
      .filter((record) => record?.fingerprint && record?.vector?.length)
      .map((record) => [record.fingerprint, record]));
    const pendingGroups = [];
    const reusedRecords = [];
    groupPassagesByFingerprint(missing).forEach((group) => {
      const cached = existingByFingerprint.get(passageFingerprint(group[0]));
      if (!cached) {
        pendingGroups.push(group);
        return;
      }
      group.forEach((passage) => reusedRecords.push(createVectorRecord(
        key,
        normalized.model,
        passage,
        cached.vector,
        cached.dimension || cached.vector.length
      )));
    });
    if (reusedRecords.length) await writeRecords(reusedRecords);

    const metadataRefresh = list
      .filter((passage) => valid.has(passage.passageId))
      .filter((passage) => {
        const record = valid.get(passage.passageId);
        return !record.metadata
          || record.cleaningVersion !== (Number(passage.cleaningVersion) || 0)
          || record.pageNumber !== (Number(passage.pageNumber) || null)
          || record.section !== (passage.section || "");
      })
      .map((passage) => {
        const record = valid.get(passage.passageId);
        return createVectorRecord(key, normalized.model, passage, record.vector, record.dimension || record.vector.length, record.updatedAt);
      });
    if (metadataRefresh.length) await writeRecords(metadataRefresh);

    let batchSize = 16;
    let completed = valid.size + reusedRecords.length;
    let embedded = 0;
    let reused = reusedRecords.length;
    onProgress({ completed, total: list.length, newlyIndexed: completed - valid.size, embedded, reused });

    let offset = 0;
    while (offset < pendingGroups.length) {
      const batchGroups = pendingGroups.slice(offset, offset + batchSize);
      const batch = batchGroups.map((group) => group[0]);
      let vectors;
      let dimension;
      try {
        vectors = await embedTexts(batch.map((passage) => passage.text));
        if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Embedding 返回数量与段落数量不一致。" );
        dimension = vectors[0]?.length || 0;
        if (!dimension || vectors.some((vector) => !vector?.length || vector.length !== dimension)) {
          throw new Error("Embedding 返回了无效或维度不一致的向量。" );
        }
      } catch (error) {
        if (batch.length > 1 && shouldReduceEmbeddingBatch(error)) {
          batchSize = Math.max(1, Math.floor(batch.length / 2));
          onProgress({
            completed,
            total: list.length,
            newlyIndexed: completed - valid.size,
            batchSize,
            embedded,
            reused,
            reducingBatch: true
          });
          continue;
        }
        throw error;
      }
      const now = new Date().toISOString();
      const records = batchGroups.flatMap((group, index) => group.map((passage) => createVectorRecord(
        key,
        normalized.model,
        passage,
        vectors[index],
        dimension,
        now
      )));
      await writeRecords(records);
      offset += batchGroups.length;
      completed += records.length;
      embedded += batchGroups.length;
      reused += records.length - batchGroups.length;
      onProgress({ completed, total: list.length, newlyIndexed: completed - valid.size, embedded, reused });
    }

    await removeStaleRecords(key, new Set(list.map((passage) => passage.passageId)));
    return { total: list.length, indexed: completed, newlyIndexed: missing.length, embedded, reused };
  }

  async function clearConfig(config) {
    const key = configKey(config);
    const records = await getRecordsForConfig(key);
    if (!records.length) return 0;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      records.forEach((record) => store.delete(record.id));
      await transactionPromise(transaction);
    } finally {
      database.close();
    }
    return records.length;
  }

  const api = {
    normalizeConfig,
    configKey,
    contentHash,
    passageFingerprint,
    groupPassagesByFingerprint,
    cosineSimilarity,
    rankVectors,
    shouldReduceEmbeddingBatch,
    getVectorMap,
    getMetadataMap,
    getStatus,
    indexPassages,
    clearConfig
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    return;
  }
  root.deepPaperVectorStore = api;
})(globalThis);
