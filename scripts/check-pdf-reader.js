const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const packageJson = JSON.parse(read("package.json"));
const index = read("index.html");
const preload = read("electron/preload.js");
const main = read("electron/main.js");
const reader = read("pdf-reader.js");

if (packageJson.dependencies?.["pdfjs-dist"] !== "5.6.205") {
  throw new Error("PDF reader regression: pdfjs-dist must stay pinned to 5.6.205.");
}
if (!packageJson.build?.files?.includes("pdf-reader.js")) {
  throw new Error("PDF reader regression: pdf-reader.js is missing from the packaged app.");
}

const appScript = index.indexOf('<script src="./app.js"></script>');
const readerScript = index.indexOf('<script src="./pdf-reader.js"></script>');
if (appScript < 0 || readerScript < appScript) {
  throw new Error("PDF reader regression: pdf-reader.js must load after app.js.");
}

const required = [
  [index, "pdfjs-dist/legacy/web/pdf_viewer.css"],
  [preload, "readPdfBytes"],
  [main, 'ipcMain.handle("papers:readPdf"'],
  [reader, "PDFViewer"],
  [reader, "pdfAnchor"],
  [reader, "renderDetail = renderDetailWithPdfReader"],
  [reader, "jumpToCorpusSource = jumpToPdfCorpusSource"]
];
for (const [source, token] of required) {
  if (!source.includes(token)) throw new Error(`PDF reader regression: missing ${token}`);
}

if (reader.includes("pdfOutlineBtn") || reader.includes("pdfOutlinePanel")) {
  throw new Error("PDF reader regression: the removed outline UI returned.");
}
if (reader.includes('id="pdfSelectionToolbar"') || reader.includes('data-pdf-selection-action=')) {
  throw new Error("PDF reader regression: the removed selection toolbar returned.");
}

console.log("PDF reader feature check passed.");
