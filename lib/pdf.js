const pdfParse = require('pdf-parse');

// Matches a repeated per-page watermark/stamp line, e.g. a student ID +
// email like "UG_31272312@med.tanta.edu.eg" that some download sources
// stamp onto every page (sometimes multiple times per page). Left in,
// this identical junk text becomes part of every single chunk, which
// (a) pollutes every embedding with the same shared prefix, flattening
// similarity scores across the whole book, and (b) sits in the way of
// keyword search on real content near the top of the page.
const WATERMARK_LINE_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

// PDF text layers frequently use "smart"/typographic characters that
// look identical on screen but are different bytes than what a person
// types: non-breaking hyphens, en/em dashes standing in for "-", curly
// quotes, non-breaking spaces. These silently break exact substring
// search (/search, ilike) and can degrade embedding quality by turning
// clean words into oddly-tokenized ones. Normalize to plain ASCII
// equivalents before anything gets chunked or embedded.
function normalizeText(raw) {
  return raw
    .normalize('NFKC')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-') // hyphens/dashes → "-"
    .replace(/[\u2018\u2019\u201B]/g, "'") // curly single quotes
    .replace(/[\u201C\u201D\u201F]/g, '"') // curly double quotes
    .replace(/[\u00A0\u2007\u202F]/g, ' ') // non-breaking spaces → regular space
    .replace(WATERMARK_LINE_RE, ' ') // strip repeated email/ID watermark stamps
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Extracts text per page from a PDF buffer.
// Returns: [{ page_number: 1, text: "..." }, ...]
async function extractPagesFromPdf(buffer) {
  const pages = [];

  await pdfParse(buffer, {
    pagerender: (pageData) =>
      pageData.getTextContent().then((textContent) => {
        const text = normalizeText(textContent.items.map((item) => item.str).join(' '));
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
