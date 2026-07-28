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

// pdf-parse (used for text extraction below) bundles its OWN old copy of
// pdfjs internally (v1.10.100) — a completely separate module instance
// from the pdfjs-dist package used for image rendering further down this
// file — so silencing pdfjs-dist's console output (see pdfjsVerbosityOption
// above) doesn't touch this one; it needs the fix applied separately, via
// the global `PDFJS.verbosity` property that pdf-parse's bundled build
// exposes. Same reasoning as above: this only silences recoverable
// warning-level noise ("ignoring XObject...", "TT: undefined function..."),
// not real errors — text extraction already worked fine before this, it
// was just noisy. Wrapped in try/catch since this reaches into pdf-parse's
// internals (not a documented part of its own API) — if a future pdf-parse
// version changes this internal layout, we'd rather silently keep the
// (harmless) log noise than break text extraction entirely.
function silencePdfParseWarnings() {
  try {
    // eslint-disable-next-line global-require
    const PDFJS = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
    PDFJS.verbosity = 0; // VERBOSITY_LEVELS.errors
  } catch (err) {
    // Best-effort only — see comment above.
  }
}
silencePdfParseWarnings();

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
// pdfjs-dist 5.x+ (this project is pinned to ^6.1.200) ships ESM only —
// there is no more `legacy/build/pdf.js` CommonJS entry point, only
// `legacy/build/pdf.mjs`. A plain require() of the old path silently
// throws MODULE_NOT_FOUND, which (since image ingestion is treated as
// best-effort everywhere it's called) used to fail completely silently:
// no rendered images, no error surfaced to the user beyond a generic
// "couldn't get any usable content" a couple of layers up. Loading it
// via dynamic import() instead is what actually works from this
// CommonJS file.
//
// getDocument() also needs a worker script (pdf.worker.mjs) to render
// pages, and by default resolves it as "./pdf.worker.mjs" *relative to
// pdf.mjs's own location inside node_modules* at runtime. That's a path
// serverless bundlers (Vercel included) can't see statically — nothing
// in *our* source code references it directly — so the file silently
// never makes it into the deployed function, and getDocument() fails
// with "Setting up fake worker failed: Cannot find module ...". Setting
// GlobalWorkerOptions.workerSrc ourselves, to an explicit require.resolve()'d
// absolute path, fixes two things at once: pdfjs no longer has to
// guess the path, AND require.resolve() with a literal string is
// something Vercel's file-tracing (@vercel/nft) CAN see statically, so
// combined with the vercel.json includeFiles entry (see that file) the
// worker script actually ships with the deployment.
async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  return pdfjsLib;
}

// pdfjs logs a LOT at its default verbosity (WARNINGS) whenever a PDF has
// any malformed/non-standard content it has to recover from — things like
// "getOperatorList - ignoring XObject: FormatError: XObject should be a
// stream" or "TT: undefined function: 32". These are pdfjs successfully
// working around minor structural issues in the source PDF (a bad
// embedded XObject, a font missing a glyph program function) — rendering
// and text extraction still complete fine, there's no actual failure for
// the app to react to. They were flooding logs (sometimes hundreds of
// lines for a single book) purely because pdfjs's default verbosity
// includes them. Dropping to ERRORS-only keeps genuine failures
// (getDocument()/page.render() throwing) visible while silencing this
// recoverable noise. Unlike some other pdfjs-dist versions, 6.x doesn't
// export a global setVerbosityLevel() — verbosity is a per-document
// option instead, so every getDocument() call below passes this.
function pdfjsVerbosityOption(pdfjsLib) {
  return { verbosity: pdfjsLib.VerbosityLevel.ERRORS };
}

// pdfjs needs this to correctly render text set in one of the 14
// standard PDF fonts (Helvetica, Times, etc.) when the PDF itself
// doesn't embed that font's glyph data — without it, those pages render
// with fallback/missing glyphs, silently degrading what the vision model
// actually receives for captioning. Points at pdfjs-dist's own bundled
// copy; in Node, pdfjs reads this as a local filesystem path (not a URL
// fetch), so a trailing separator is required.
function standardFontDataUrl() {
  const pdfjsPkgPath = require.resolve('pdfjs-dist/package.json');
  return require('path').join(require('path').dirname(pdfjsPkgPath), 'standard_fonts') + require('path').sep;
}

// maxPages (optional): caps how many pages get rendered, so a huge book
// doesn't spend minutes rasterizing pages nobody asked to image-embed
// (see env.MAX_IMAGE_PAGES_PER_BOOK, applied by the caller).
// pageNumbers (optional): render exactly these page numbers instead of
// "the first N pages in document order". Used for mixed text+image
// books (see lib/books.js ingestPageImages), where only the pages that
// don't carry enough of their own extractable text — or that carry an
// embedded photo/diagram alongside their text — need to be rendered as
// images at all; plain text pages are already covered by text chunks.
// maxPages still applies as a ceiling on top of pageNumbers, so a very
// long list of "needs image" pages can't blow past the same budget a
// fully-scanned book would.
async function renderPageImages(buffer, { maxPages = null, scale = 1.5, quality = 0.8, pageNumbers = null } = {}) {
  // Required lazily so books/environments that never enable
  // ENABLE_IMAGE_CHUNKS don't pay the cost of loading these (fairly
  // heavy) modules on every cold start.
  const pdfjsLib = await loadPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFontDataUrl(),
    ...pdfjsVerbosityOption(pdfjsLib),
  });
  const doc = await loadingTask.promise;

  let targetPages;
  if (pageNumbers && pageNumbers.length > 0) {
    targetPages = pageNumbers.filter((p) => p >= 1 && p <= doc.numPages);
    if (maxPages) targetPages = targetPages.slice(0, maxPages);
  } else {
    const totalPages = maxPages ? Math.min(doc.numPages, maxPages) : doc.numPages;
    targetPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const images = [];
  for (const pageNum of targetPages) {
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

// Flags which pages contain at least one embedded raster image (a photo,
// diagram, scanned figure, chart bitmap, etc.), independent of how much
// extractable text that same page also has. This is what makes a true
// MIXED page — normal body-text paragraphs sitting next to a photo/
// diagram in the same page — get picked up for image-chunk embedding.
// A word-count-only heuristic (see lib/books.js MIN_WORDS_FOR_TEXT_COVERAGE)
// can only catch pages that are ALMOST ENTIRELY image (little/no text);
// it can't see a page that has both, since that page's word count looks
// perfectly normal. This function is the other half of that check.
//
// Works by walking each page's operator list (pdfjs-dist's low-level
// "list of drawing instructions for this page") and checking for any
// image-paint op — this is far cheaper than actually rendering the page
// to a canvas (see renderPageImages above), so it's safe to run over
// every page of the book before deciding which ones to rasterize.
async function detectPagesWithImages(buffer) {
  const pdfjsLib = await loadPdfjs();
  const { OPS } = pdfjsLib;
  const IMAGE_OPS = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObjectRepeat,
  ]);

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFontDataUrl(),
    ...pdfjsVerbosityOption(pdfjsLib),
  });
  const doc = await loadingTask.promise;

  const pagesWithImages = new Set();
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const opList = await page.getOperatorList();
    if (opList.fnArray.some((fn) => IMAGE_OPS.has(fn))) {
      pagesWithImages.add(pageNum);
    }
  }

  return pagesWithImages;
}

module.exports = { extractPagesFromPdf, extractFullText, renderPageImages, detectPagesWithImages };
