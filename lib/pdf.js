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

// Renders each page of a PDF to a JPEG image buffer, for image-chunk
// embedding (see lib/gemini.js embedImages/captionImage and
// lib/books.js ingestPageImages). JPEG (not PNG) is used to keep the
// base64 stored in book_chunks.image_base64 reasonably small — a scanned
// textbook page as PNG can be several MB, JPEG at quality 80 is
// typically 100-300KB.
//
// Uses pdfjs-dist's legacy Node build for parsing/rasterizing and
// @napi-rs/canvas as the <canvas> implementation it renders into.
// @napi-rs/canvas ships prebuilt native binaries per platform (unlike
// the older `canvas` package, which needs a native build toolchain at
// install time) — this matters because it has to install cleanly in
// Vercel's serverless build environment.
//
// maxPages (optional): caps how many pages get rendered, so a huge book
// doesn't spend minutes rasterizing pages nobody asked to image-embed
// (see env.MAX_IMAGE_PAGES_PER_BOOK, applied by the caller).
async function renderPageImages(buffer, { maxPages = null, scale = 1.5, quality = 0.8 } = {}) {
  // Required lazily so books/environments that never enable
  // ENABLE_IMAGE_CHUNKS don't pay the cost of loading these (fairly
  // heavy) modules on every cold start.
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('@napi-rs/canvas');

  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;
  const totalPages = maxPages ? Math.min(doc.numPages, maxPages) : doc.numPages;

  const images = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');

    await page.render({ canvasContext: context, viewport }).promise;

    const jpegBuffer = await canvas.encode('jpeg', Math.round(quality * 100));
    images.push({ page_number: pageNum, buffer: jpegBuffer, mimeType: 'image/jpeg' });
  }

  return images;
}

module.exports = { extractPagesFromPdf, extractFullText, renderPageImages };
