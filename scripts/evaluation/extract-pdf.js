const fs = require("node:fs/promises");
const path = require("node:path");

let pdfjsPromise;
function normalizePaperText(value) {
  return value.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractPdfPages(filePath) {
  const stats = await fs.stat(filePath);
  if (stats.size > 100 * 1024 * 1024) throw new Error("PDF exceeds 100 MiB local evaluation limit");
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsPromise;
  const standardFontDataUrl = `${path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts").replace(/\\/g, "/")}/`;
  const cMapUrl = `${path.join(__dirname, "..", "..", "node_modules", "pdfjs-dist", "cmaps").replace(/\\/g, "/")}/`;
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(filePath)), disableWorker: true, standardFontDataUrl, cMapUrl, cMapPacked: true });
  const document = await task.promise;
  const pageTexts = [];
  try {
    if (document.numPages > 500) throw new Error("PDF exceeds 500 page local evaluation limit");
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      let lastY;
      for (const item of content.items || []) {
        const y = item?.transform?.[5];
        text += lastY === undefined || lastY === y ? String(item?.str || "") : `\n${String(item?.str || "")}`;
        if (item?.hasEOL) text += "\n";
        lastY = y;
      }
      pageTexts.push(normalizePaperText(text));
    }
  } finally {
    await document.destroy();
  }
  let text = "";
  const pageTextOffsets = [];
  pageTexts.forEach((pageText, index) => {
    if (text && pageText) text += "\n\n";
    const start = text.length;
    text += pageText;
    pageTextOffsets.push({ pageNumber: index + 1, start, end: text.length });
  });
  if (!text) throw new Error("PDF has no extractable text");
  return { text, pageCount: pageTexts.length, pageTextOffsets };
}

module.exports = { extractPdfPages };
