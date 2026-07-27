// Helpers for rendering Arabic (and mixed Arabic/Latin) text correctly
// inside PDFKit, which only draws raw glyph runs left-to-right and does
// zero contextual shaping or bidi reordering on its own.
//
// Pipeline for a line of text that should read as Arabic:
//   1. arabic-reshaper turns each logical-order Arabic letter into the
//      correct contextual presentation form (initial/medial/final/isolated)
//      so letters join into cursive script instead of drawing as separate
//      isolated glyphs.
//   2. bidi-js reorders the reshaped codepoints into *visual* order (the
//      order you'd draw them left-to-right on the page) per the Unicode
//      Bidirectional Algorithm, keeping embedded Latin words/numbers in
//      their own reading order while flipping the Arabic runs around them.
//
// Word-wrapping has to happen BEFORE this shaping/reordering (on the
// original logical-order string), because reordering assumes the input
// is a single visual line — reorder first, then wrap, and line breaks
// would land in the wrong place.
const bidiFactory = require('bidi-js');
const reshaper = require('arabic-reshaper');

const bidi = bidiFactory();

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F]/g;

// Characters that the decorative display fonts (Comic Neue / Spectral /
// Fredoka / Archivo Black / Abril Fatface / Tajawal / the Arabic faces)
// don't reliably carry glyphs for, so any word containing one needs to be
// drawn with a fallback font instead — see the tokenFont() fallback in
// each pdfDesign*.js / pdfGenerator.js. Confirmed via font cmap
// inspection (fontTools) against Lato, which has the widest coverage of
// the bundled fonts and is what these fall back to:
//   - Greek block (α β γ δ ... Α Β Γ ...) — used constantly in
//     science/math answers.
//   - U+2000-U+2BFF: general punctuation, superscripts/subscripts,
//     currency symbols, letterlike symbols (℅ № ™ ...), number forms,
//     arrows (← ↑ → ↓ ↔ ↕ ...), mathematical operators (± × ÷ ≠ ≤ ≥ √ ∞
//     ∑ ∏ ∫ ...), misc technical, enclosed alphanumerics, geometric
//     shapes, misc symbols, and dingbats.
// Without this, any of the above would otherwise silently draw as a
// blank/missing glyph box.
// Note: a few codepoints even Lato doesn't carry (e.g. ℃/℉, the double
// arrows ⇐⇑⇒⇓⇔) will still render as a missing-glyph box — none of the
// bundled fonts have them, so there's no fallback font left to reach for.
const SYMBOL_FALLBACK_RE = /[\u0370-\u03FF\u1F00-\u1FFF\u2000-\u2BFF]/;

function hasGreek(word) {
  return SYMBOL_FALLBACK_RE.test(String(word || ''));
}

// Rough heuristic: does Arabic script make up a meaningful share of this
// string's letters? Used to decide whether a whole answer/question should
// be treated (and right-aligned) as an Arabic paragraph.
function isMostlyArabic(text) {
  if (!text) return false;
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length === 0) return false;
  const arabicCount = (letters.match(ARABIC_RE) || []).length;
  return arabicCount / letters.length > 0.3;
}

// Shapes + bidi-reorders a single already-wrapped line for correct visual
// rendering with a plain left-to-right glyph drawer like PDFKit.
function shapeArabicLine(line) {
  if (!line) return line;
  const shaped = reshaper.convertArabic(line);
  const levels = bidi.getEmbeddingLevels(shaped);
  return bidi.getReorderedString(shaped, levels);
}

// Greedy word-wrap of an array of words into lines that each fit within
// maxWidth, measured with the given PDFKit doc/font/size. Words stay in
// logical (reading) order within and across lines — shaping/reordering
// happens per-line afterwards, once the line's final word set is known.
function wrapWordsByWidth(doc, words, font, size, maxWidth) {
  doc.font(font).fontSize(size);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const spaceWidth = doc.widthOfString(' ');

  for (const word of words) {
    const wWidth = doc.widthOfString(word);
    const extra = current.length > 0 ? spaceWidth + wWidth : wWidth;
    if (current.length > 0 && currentWidth + extra > maxWidth) {
      lines.push(current.join(' '));
      current = [word];
      currentWidth = wWidth;
    } else {
      current.push(word);
      currentWidth += extra;
    }
  }
  if (current.length > 0) lines.push(current.join(' '));
  return lines;
}

module.exports = { isMostlyArabic, hasGreek, shapeArabicLine, wrapWordsByWidth };
