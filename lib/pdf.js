const pdfParse = require('pdf-parse');

// Extracts text per page from a PDF buffer.
// Returns: [{ page_number: 1, text: "..." }, ...]
async function extractPagesFromPdf(buffer) {
  const pages = [];

  await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent().then((textContent) => {
        const text = textContent.items.map((item) => item.str).join(' ');
        pages.push({ page_number: pages.length + 1, text });
        return text;
      }),
  });

  return pages;
}

// Concatenates all page text (used for question-file extraction,
// where page numbers don't matter).
async function extractFullText(buffer) {
  const pages = await extractPagesFromPdf(buffer);
  return pages.map((p) => p.text).join('\n');
}

module.exports = { extractPagesFromPdf, extractFullText };
