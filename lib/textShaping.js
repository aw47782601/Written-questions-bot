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

module.exports = { isMostlyArabic, shapeArabicLine, wrapWordsByWidth };
