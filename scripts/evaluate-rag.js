#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { prepare, embeddingInputs, runEvaluation, markdownReport, sha256 } = require("./evaluation/core.js");
const { syntheticFixture } = require("./evaluation/synthetic.js");
const { embedInputs } = require("./evaluation/embed.js");
const { validPageOffsets } = require("../rag.js");
const { extractPdfPages } = require("./evaluation/extract-pdf.js");
const { auditCorpus, annotationCandidates } = require("./evaluation/audit.js");

function usage() {
  return [
    "Usage:",
    "  node scripts/evaluate-rag.js import --library <DeepPaper export.json> --out <private directory> [--rebuild-pages]",
    "  node scripts/evaluate-rag.js inputs --corpus <corpus.json> --questions <questions.json> --out <private directory> [index options]",
    "  node scripts/evaluate-rag.js embed --inputs <embedding-inputs.json> --out <private directory> --endpoint <url> --model <name> --provider <name> --revision <version> --kind real --max-inputs <n> [--batch 1..32]",
    "  node scripts/evaluate-rag.js run --corpus <corpus.json> --questions <questions.json> --out <private directory> [--vectors <vectors.json>] [index options]",
    "  node scripts/evaluate-rag.js demo --out <directory>",
    "Index options: --mode keyword|vector|hybrid|all --split development|test|all --k 1..24 --target 320..10000 --overlap 0..target/3 --cleaning on|off --repeats 1..100",
    "Default mode: keyword. Vector and hybrid modes require a complete, exact-text cached embedding file. No network requests are made."
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  if (!["import", "inputs", "embed", "run", "demo"].includes(command)) throw new Error(usage());
  const allowed = new Set(["--library", "--corpus", "--questions", "--vectors", "--out", "--mode", "--split", "--k", "--target", "--overlap", "--cleaning", "--repeats", "--inputs", "--endpoint", "--model", "--provider", "--revision", "--kind", "--max-inputs", "--batch", "--rebuild-pages"]);
  const args = {};
  const flags = new Set(["--rebuild-pages"]);
  for (let i = 1; i < argv.length; i += 1) {
    if (!allowed.has(argv[i]) || Object.hasOwn(args, argv[i])) throw new Error(`Invalid/duplicate option ${argv[i]}\n${usage()}`);
    if (flags.has(argv[i])) args[argv[i]] = true;
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${argv[i]}`);
      args[argv[i]] = argv[++i];
    }
  }
  const required = command === "import" ? ["--library", "--out"] : command === "demo" ? ["--out"] : command === "embed" ? ["--inputs", "--out", "--endpoint", "--model", "--provider", "--revision", "--kind", "--max-inputs"] : ["--corpus", "--questions", "--out"];
  for (const key of required) if (!args[key]) throw new Error(`Missing ${key}\n${usage()}`);
  if (command === "import" && Object.keys(args).some((key) => !["--library", "--out", "--rebuild-pages"].includes(key))) throw new Error("import received an unrelated option");
  if (command === "demo" && Object.keys(args).some((key) => key !== "--out")) throw new Error("demo supports only --out");
  if (command === "embed" && Object.keys(args).some((key) => ![...required, "--batch"].includes(key))) throw new Error("embed received an unrelated option");
  if (["inputs", "run"].includes(command) && Object.keys(args).some((key) => ![...required, "--vectors", "--mode", "--split", "--k", "--target", "--overlap", "--cleaning", "--repeats"].includes(key))) throw new Error(`${command} received an unrelated option`);
  if (command === "inputs" && args["--vectors"]) throw new Error("inputs does not use --vectors");
  return { command, args };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function getOptions(args) {
  const numeric = (key) => {
    if (args[key] === undefined) return undefined;
    if (!/^\d+$/.test(args[key])) throw new Error(`${key} must be a nonnegative integer`);
    return Number(args[key]);
  };
  if (args["--cleaning"] && !["on", "off"].includes(args["--cleaning"])) throw new Error("--cleaning must be on or off");
  const mode = args["--mode"] || "keyword";
  return {
    modes: mode === "all" ? ["keyword", "vector", "hybrid"] : [mode],
    split: args["--split"], k: numeric("--k"), target: numeric("--target"), overlap: numeric("--overlap"),
    repeats: numeric("--repeats"), cleaning: args["--cleaning"] === undefined ? undefined : args["--cleaning"] === "on"
  };
}

async function importLibrary(file, { rebuildPages = false, onProgress = () => {} } = {}) {
  const exported = readJson(file);
  if (exported?.app !== "DeepPaper" || !Array.isArray(exported.papers)) throw new Error("Not a DeepPaper library export");
  const excluded = [];
  const papers = [];
  let recovered = 0;
  let availablePdfPaths = 0;
  let lastProgress = 0;
  for (const paper of exported.papers) {
    if (paper.kind === "image" || !paper.id) { excluded.push(String(paper.id || "unknown")); continue; }
    let pageData = paper;
    if (!paper.text || !validPageOffsets(paper).length) {
      const filePath = String(paper.filePath || "");
      const available = filePath && path.extname(filePath).toLowerCase() === ".pdf" && fs.existsSync(filePath);
      if (available) availablePdfPaths += 1;
      if (rebuildPages && available) {
        try {
          pageData = { ...paper, ...await extractPdfPages(filePath) };
          recovered += 1;
        } catch (error) {
          onProgress({ id: String(paper.id), error: error.message });
        }
      }
    }
    if (!pageData.text || !validPageOffsets(pageData).length) {
      excluded.push(String(paper.id));
      continue;
    }
    const keywords = Array.isArray(paper.keywords) ? paper.keywords.filter((word) => typeof word === "string") : [];
    const analysis = paper.analysis || {};
    const analysisKeywords = Array.isArray(analysis.keywords) ? analysis.keywords.filter((word) => typeof word === "string") : [];
    const safe = {
      id: String(paper.id), title: String(paper.title || ""), titleZh: String(paper.titleZh || ""),
      titleEn: String(paper.titleEn || ""), year: paper.year || "", venue: String(paper.venue || ""),
      authors: Array.isArray(paper.authors) ? paper.authors.filter((name) => typeof name === "string") : String(paper.authors || ""),
      keywords, analysis: {
        title_zh: String(analysis.title_zh || ""), title_en: String(analysis.title_en || ""),
        year: analysis.year || "", venue: String(analysis.venue || ""), keywords: analysisKeywords
      },
      source: String(paper.titleEn || paper.titleZh || paper.title || analysis.title_en || analysis.title_zh || paper.id),
      text: pageData.text,
      pageCount: pageData.pageCount,
      pageTextOffsets: pageData.pageTextOffsets.map((p) => ({ pageNumber: p.pageNumber, start: p.start, end: p.end }))
    };
    papers.push(safe);
    if (rebuildPages && recovered >= lastProgress + 10) {
      lastProgress = recovered;
      onProgress({ recovered, imported: papers.length, total: exported.papers.length });
    }
  }
  if (!papers.length) throw new Error("No PDF papers with exact page offsets. Use --rebuild-pages if the original PDF files are still present.");
  return {
    corpus: {
      schemaVersion: 1, id: `local-${sha256(fs.readFileSync(path.resolve(file))).slice(0, 12)}`,
      version: "draft-1", kind: "real", source: "Private DeepPaper JSON export; confirm original PDF and redistribution rights before publication",
      papers
    },
    excluded, recovered, availablePdfPaths
  };
}

function gitCommit() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).trim(); }
  catch { return null; }
}

async function main(argv) {
  const { command, args } = parseArgs(argv);
  const out = path.resolve(args["--out"]);
  if (command === "embed") {
    const key = process.env.DEEPPAPER_EVAL_EMBEDDING_KEY;
    if (!key) throw new Error("Set DEEPPAPER_EVAL_EMBEDDING_KEY in the environment; do not pass API keys on the command line");
    const integer = (name, fallback) => {
      const value = args[name] ?? String(fallback);
      if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
      return Number(value);
    };
    const result = await embedInputs({
      inputs: readJson(args["--inputs"]), out, endpoint: args["--endpoint"], key,
      model: args["--model"], provider: args["--provider"], revision: args["--revision"], kind: args["--kind"],
      maxInputs: integer("--max-inputs"), batchSize: integer("--batch", 1),
      progress: (step) => process.stdout.write(`Embedded ${step.generated}; remaining ${step.remaining}; requests ${step.requests}\n`)
    });
    process.stdout.write(`Saved ${result.cachePath}; ${result.remaining} entries still missing.\n`);
    return;
  }
  if (command === "import") {
    const result = await importLibrary(args["--library"], {
      rebuildPages: args["--rebuild-pages"] === true,
      onProgress: (step) => { if (step.error) process.stderr.write(`Skipped PDF ${step.id}: ${step.error}\n`); else process.stdout.write(`Recovered ${step.recovered} page maps; imported ${step.imported}/${step.total}\n`); }
    });
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, "corpus.json"), result.corpus);
    const audit = auditCorpus(result.corpus);
    writeJson(path.join(out, "corpus-audit.json"), audit);
    writeJson(path.join(out, "annotation-candidates.json"), annotationCandidates(result.corpus));
    writeJson(path.join(out, "questions.template.json"), {
      schemaVersion: 1, id: `${result.corpus.id}-questions`, version: "draft-1", kind: "real", annotationStatus: "draft",
      source: "Manual annotation of the local corpus; keep this file private until rights checked",
      questions: []
    });
    process.stdout.write(`Imported ${result.corpus.papers.length} PDF papers, ${audit.pages} pages (${audit.emptyPages} empty); recovered ${result.recovered} page maps; excluded ${result.excluded.length}. Original PDFs available for ${result.availablePdfPaths} previously unmapped papers.\nOutput: ${out}\n`);
    return;
  }
  const { corpus, questions, vectors, options } = command === "demo"
    ? { ...syntheticFixture(), options: { split: "all", modes: ["keyword", "vector", "hybrid"], k: 2, repeats: 3 } }
    : {
      corpus: readJson(args["--corpus"]), questions: readJson(args["--questions"]),
      vectors: args["--vectors"] ? readJson(args["--vectors"]) : null, options: getOptions(args)
    };
  const prepared = prepare(corpus, questions, options);
  if (command === "inputs") {
    fs.mkdirSync(out, { recursive: true });
    writeJson(path.join(out, "embedding-inputs.json"), embeddingInputs(prepared));
    process.stdout.write(`Prepared ${prepared.index.passages.length} passages; embedding inputs in ${out}\n`);
    return;
  }
  const report = runEvaluation(corpus, questions, vectors, options);
  report.environment = {
    gitCommit: gitCommit(), node: process.version, platform: process.platform,
    arch: process.arch, cpu: os.cpus()[0]?.model || null, totalMemoryBytes: os.totalmem(),
    processRssAtReportBytes: process.memoryUsage.rss()
  };
  report.inputs = command === "demo" ? "generated synthetic fixture" : {
    corpusFileSha256: sha256(fs.readFileSync(path.resolve(args["--corpus"]))),
    questionsFileSha256: sha256(fs.readFileSync(path.resolve(args["--questions"]))),
    vectorFileSha256: args["--vectors"] ? sha256(fs.readFileSync(path.resolve(args["--vectors"]))) : null
  };
  fs.mkdirSync(out, { recursive: true });
  if (command === "demo") {
    writeJson(path.join(out, "corpus.json"), corpus);
    writeJson(path.join(out, "questions.json"), questions);
    writeJson(path.join(out, "vectors.json"), vectors);
  }
  writeJson(path.join(out, "report.json"), report);
  fs.writeFileSync(path.join(out, "report.md"), markdownReport(report), "utf8");
  process.stdout.write(`${report.purpose}\n${report.counts.questions} questions; ${report.counts.passages} passages; ${report.runs.map((r) => r.mode).join(", ")}\nReports: ${out}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { parseArgs, importLibrary, main };
