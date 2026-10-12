const { sha256 } = require("./core.js");
const { validPageOffsets } = require("../../rag.js");

function auditCorpus(corpus) {
  const papers = corpus.papers.map((paper) => {
    const pages = validPageOffsets(paper).map((offset) => ({
      pageNumber: offset.pageNumber,
      text: paper.text.slice(offset.start, offset.end)
    }));
    return {
      id: paper.id, title: paper.titleEn || paper.titleZh || paper.title,
      pageCount: pages.length, characterCount: paper.text.length,
      emptyPageCount: pages.filter((page) => !page.text.trim()).length,
      shortPageCount: pages.filter((page) => page.text.trim().length < 100).length,
      firstContentPage: pages.find((page) => page.text.trim().length >= 100)?.pageNumber || null
    };
  });
  return {
    schemaVersion: 1, corpusId: corpus.id, corpusVersion: corpus.version,
    papers: papers.length, pages: papers.reduce((sum, p) => sum + p.pageCount, 0),
    emptyPages: papers.reduce((sum, p) => sum + p.emptyPageCount, 0),
    shortPages: papers.reduce((sum, p) => sum + p.shortPageCount, 0),
    characters: papers.reduce((sum, p) => sum + p.characterCount, 0),
    paperDetails: papers
  };
}

function annotationCandidates(corpus) {
  return {
    schemaVersion: 1, corpusId: corpus.id,
    purpose: "Source excerpts for human question and evidence annotation; not gold labels",
    papers: corpus.papers.map((paper) => {
      const offsets = validPageOffsets(paper);
      const page = offsets.find((item) => paper.text.slice(item.start, item.end).trim().length >= 100) || offsets[0];
      return {
        paperId: paper.id, title: paper.titleEn || paper.titleZh || paper.title,
        sourceHash: sha256(paper.text), suggestedPage: page?.pageNumber || null,
        excerpt: page ? paper.text.slice(page.start, page.end).replace(/\s+/g, " ").slice(0, 500) : ""
      };
    })
  };
}

module.exports = { auditCorpus, annotationCandidates };
