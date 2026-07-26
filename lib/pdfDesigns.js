// Registry of selectable PDF answer-sheet designs. Right now there's only
// one — the orange-card curriculum-book look in lib/pdfGenerator.js,
// registered here as "design_1" — but every call site (the bot's PDF
// delivery code, the /pdfcolor picker, etc.) goes through this registry
// instead of importing pdfGenerator.js directly, so adding "design_2" later
// is just: write lib/pdfDesignN.js exporting a `generateAnswersPdf(results,
// meta)` with the same signature, then add one entry to DESIGNS below.
const { generateAnswersPdf: renderDesign1 } = require('./pdfGenerator');
const { generateAnswersPdf: renderDesign2 } = require('./pdfDesign2');
const { generateAnswersPdf: renderDesign3 } = require('./pdfDesign3');
const { generateAnswersPdf: renderDesign4 } = require('./pdfDesign4');
const { generateAnswersPdf: renderDesign5 } = require('./pdfDesign5');

const DESIGNS = {
  design_1: {
    id: 'design_1',
    label: 'M.E.M design',
    render: renderDesign1,
  },
  design_2: {
    id: 'design_2',
    label: 'light mode 1',
    render: renderDesign2,
  },
  design_3: {
    id: 'design_3',
    label: 'light mode 2',
    render: renderDesign3,
  },
  design_4: {
    id: 'design_4',
    label: 'Dark mode 1',
    render: renderDesign4,
  },
  design_5: {
    id: 'design_5',
    label: 'Dark mode 2',
    render: renderDesign5,
  },
};

const DEFAULT_DESIGN_ID = 'design_2';

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
