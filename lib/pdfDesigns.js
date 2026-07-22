// Registry of selectable PDF answer-sheet designs. Right now there's only
// one — the orange-card curriculum-book look in lib/pdfGenerator.js,
// registered here as "design_1" — but every call site (the bot's PDF
// delivery code, the /pdfcolor picker, etc.) goes through this registry
// instead of importing pdfGenerator.js directly, so adding "design_2" later
// is just: write lib/pdfDesignN.js exporting a `generateAnswersPdf(results,
// meta)` with the same signature, then add one entry to DESIGNS below.
const { generateAnswersPdf: renderDesign1 } = require('./pdfGenerator');

const DESIGNS = {
  design_1: {
    id: 'design_1',
    label: 'M.E.M design',
    render: renderDesign1,
  },
};

const DEFAULT_DESIGN_ID = 'design_1';

function isValidDesignId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(DESIGNS, id);
}

function listDesigns() {
  return Object.values(DESIGNS);
}

// results: [{ question, answer, page, isError }]
// meta: { title, bookName, colorKey } — see lib/pdfGenerator.js /
// lib/pdfColors.js for what meta.colorKey accepts.
function renderPdf(designId, results, meta = {}) {
  const design = DESIGNS[designId] || DESIGNS[DEFAULT_DESIGN_ID];
  return design.render(results, meta);
}

module.exports = { DESIGNS, DEFAULT_DESIGN_ID, isValidDesignId, listDesigns, renderPdf };
