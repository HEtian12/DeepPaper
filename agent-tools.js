(function initAgentTools(root) {
  const schemas = {
    search_library: { required: ["query"], allowed: ["query", "limit"], strings: { query: [1, 500] }, integers: { limit: [3, 30] } },
    search_passages: { required: ["query"], allowed: ["query", "limit"], strings: { query: [1, 500] }, integers: { limit: [3, 20] } },
    read_passages: { required: ["passage_ids"], allowed: ["passage_ids"], arrays: { passage_ids: [1, 8, 180] } },
    read_papers: { required: ["paper_ids", "sections"], allowed: ["paper_ids", "sections"], arrays: { paper_ids: [1, 6, 100] }, enums: { sections: ["metadata", "keywords", "abstract", "motivation", "method", "contributions", "results"] } },
    compare_papers: { required: ["paper_ids", "focus"], allowed: ["paper_ids", "focus"], arrays: { paper_ids: [2, 6, 100] }, strings: { focus: [1, 160] } },
    build_evidence_map: { required: ["paper_ids"], allowed: ["paper_ids"], arrays: { paper_ids: [1, 12, 100] } },
    propose_collection: { required: ["name", "paper_ids", "rationale"], allowed: ["name", "paper_ids", "rationale"], strings: { name: [1, 60], rationale: [1, 600] }, arrays: { paper_ids: [1, 30, 100] } }
  };

  function validateToolCall(tool) {
    const name = String(tool?.name || "");
    const schema = schemas[name];
    if (!schema) return { ok: false, error: `Unsupported tool: ${name || "(empty)"}` };
    const args = tool.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: `${name}: arguments must be an object` };
    const extra = Object.keys(args).filter((key) => !schema.allowed.includes(key));
    if (extra.length) return { ok: false, error: `${name}: unsupported argument(s): ${extra.join(", ")}` };
    const missing = schema.required.filter((key) => !Object.hasOwn(args, key));
    if (missing.length) return { ok: false, error: `${name}: missing required argument(s): ${missing.join(", ")}` };
    for (const [key, [min, max]] of Object.entries(schema.strings || {})) {
      if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].trim().length < min || args[key].length > max)) return { ok: false, error: `${name}: invalid ${key}` };
    }
    for (const [key, [min, max]] of Object.entries(schema.integers || {})) {
      if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < min || args[key] > max)) return { ok: false, error: `${name}: invalid ${key}` };
    }
    for (const [key, [min, max, itemMax]] of Object.entries(schema.arrays || {})) {
      const values = args[key];
      if (!Array.isArray(values) || values.length < min || values.length > max || values.some((value) => typeof value !== "string" || !value.trim() || value.length > itemMax) || new Set(values).size !== values.length) return { ok: false, error: `${name}: invalid ${key}` };
    }
    for (const [key, allowed] of Object.entries(schema.enums || {})) {
      const values = args[key];
      if (!Array.isArray(values) || !values.length || values.length > allowed.length || values.some((value) => !allowed.includes(value)) || new Set(values).size !== values.length) return { ok: false, error: `${name}: invalid ${key}` };
    }
    return { ok: true, tool: { name, arguments: args } };
  }

  function normalizeReadPaperIds(tool, transcript) {
    if (tool?.name !== "read_papers" || !Array.isArray(tool.arguments?.paper_ids)) return tool;
    const candidates = [];
    for (const entry of Array.isArray(transcript) ? transcript : []) {
      if (entry?.type !== "tool_result" || entry?.tool !== "search_library") continue;
      try {
        const result = typeof entry.result === "string" ? JSON.parse(entry.result) : entry.result;
        for (const paper of Array.isArray(result?.papers) ? result.papers : []) {
          const id = String(paper?.paper_id || "").trim();
          const title = String(paper?.title || "").trim().toLocaleLowerCase();
          if (id && title) candidates.push({ id, title });
        }
      } catch {}
    }
    if (!candidates.length) return tool;
    const titleToId = new Map();
    const ambiguousTitles = new Set();
    for (const paper of candidates) {
      if (titleToId.has(paper.title) && titleToId.get(paper.title) !== paper.id) ambiguousTitles.add(paper.title);
      else titleToId.set(paper.title, paper.id);
    }
    for (const title of ambiguousTitles) titleToId.delete(title);
    const validIds = new Set(candidates.map((paper) => paper.id));
    const normalized = [...new Set(tool.arguments.paper_ids.map((value) => {
      const idOrTitle = String(value || "").trim();
      return validIds.has(idOrTitle) ? idOrTitle : titleToId.get(idOrTitle.toLocaleLowerCase());
    }).filter(Boolean))].slice(0, 6);
    return { ...tool, arguments: { ...tool.arguments, paper_ids: normalized } };
  }

  const api = { schemas, validateToolCall, normalizeReadPaperIds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.deepPaperAgentTools = api;
})(globalThis);
