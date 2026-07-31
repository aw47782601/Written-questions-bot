// Renders a batch of {question, answer, page} results as a styled PDF in
// a dark "warm graphite" look — "design_5" (see lib/pdfDesigns.js for the
// design registry). This replaces the plum/indigo palette used by
// design_5 (which reads blue/purple) with a strictly warm, neutral dark
// charcoal — no blue or purple anywhere in the fixed palette. Only the
// user's chosen accent color (colors.orange from lib/pdfColors.js) adds
// color; everything else is warm black/charcoal/graphite/gray.
//
// It is also a deliberate structural break from design_4 (navy HUD,
// square brackets) and design_5 (plum, glow halos, diamond badge):
//  - Cards are rectangular with soft corners and a SOLID thick accent
//    bar down the left edge — no glow halo anywhere, and no HUD corner
//    brackets.
//  - Badge is a solid hexagon chip — not design_1's circle, design_2's
//    square, design_3's watermark numeral, design_4's pennant, or
//    design_5's rotated diamond.
//  - Divider is a plain thin rule with a small solid accent square
//    tucked at its LEFT end — distinct from design_5's centered glow
//    line+dot, design_4's dashed+bracket line, design_1's chevron, and
//    design_2's plain full rule.
//  - Chapter header is a capsule that HUGS the width of its own text
//    (solid accent fill, dark text) rather than stretching to the full
//    card width. This is a deliberate fix for the earlier "chapter title
//    spills onto two lines" bug: a fixed-width box being handed a
//    smaller `width` than the text actually needs is what caused PDFKit
//    to silently wrap (lineBreak:false only blocks "\n"-splitting, not
//    wrap-to-width). By sizing the capsule to exactly the text's real
//    width — plus a font-shrink and, only as a last resort, an ellipsis
//    for titles wider than the page — the capsule can never receive a
//    text width smaller than what's needed, so it can never wrap.
//    FIX (this revision): the final draw call still passed `width:
//    fitted.width` into doc.text(), and PDFKit's wrap-to-width can still
//    fire even when the passed width matches the measured width, if the
//    actual rendered glyph width comes out a hair larger (rounding /
//    hinting / character-spacing applied differently between
//    widthOfString and text). Since the text is manually centered via
//    the x position already, no `width` needs to be passed to text() at
//    all — removing it makes a second-line wrap physically impossible.
//  - Header/footer are a plain thin hairline with a small solid accent
//    square page-number chip in the footer, instead of design_5's
//    glowing dot/badge or design_4's brackets.
//
// Functionally it keeps full feature parity with all prior designs:
// *highlighted* term coloring, comparison tables (Gemini-flagged
// { columns, rows } answers), chapter banners once per new chapter, and
// full Arabic shaping + bidi reordering (mostly-Arabic paragraphs/cells,
// and stray Arabic words/phrases inside an otherwise non-Arabic answer) —
// see lib/pdfGenerator.js's header comment for why the run-grouping
// approach is needed; the same approach is used here unchanged, just
// re-themed and re-fonted.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
const { getColorTheme, DEFAULT_PDF_COLOR } = require('./pdfColors');

// --- Fonts -------------------------------------------------------------
const FONT_ARABIC_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Tajawal-Regular.ttf');
const FONT_ARABIC_BOLD_PATH = path.join(__dirname, '../assets/fonts/Tajawal-Bold.ttf');
const FONT_ARABIC_REGULAR = 'Tajawal-Regular';
const FONT_ARABIC_BOLD = 'Tajawal-Bold';

const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_REGULAR = 'Lato-Regular';
const FONT_BOLD = 'Lato-Bold';

const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/AbrilFatface-Regular.ttf');
const FONT_HEADING = 'AbrilFatface-Regular';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 40;

// Fixed warm dark tones used alongside the accent color. Deliberately
// NO blue or purple component anywhere — warm near-black / graphite /
// warm gray only, so the page reads as charcoal, not navy or plum.
const NEUTRAL_INK = '#EDE7DC'; // body text on dark cards (warm off-white)
const NEUTRAL_GRAY = '#9C948A'; // secondary text: page citation, footer brand
const NEUTRAL_BORDER = '#3A342C'; // hairlines / row separators (warm graphite)
const PAGE_BG = '#141210'; // warm near-black page (brownish charcoal, no blue)
const CARD_BG = '#201B16'; // warm dark card
const TABLE_ROW_ALT = '#2A2319'; // alternate table row shade

const HEADER_LINE_Y = 26;
const HEADER_H = HEADER_LINE_Y + 10;
const PAGE_CONTENT_TOP = HEADER_H + 14;

const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 14;

const CARD_PADDING = 18;
const CARD_GAP = 18;
const CARD_RADIUS = 8;
const CARD_ACCENT_BAR_W = 5; // solid left accent bar width
const BADGE_COL_W = 38; // reserved margin for the hexagon badge
const QUESTION_SIZE = 15;
const LABEL_SIZE = 9.5;
const ANSWER_SIZE = 13.5;
const LINE_HEIGHT_Q = 19;
const LINE_HEIGHT_A = 18.5;

// A long answer that doesn't fit in what's left of the current page now
// splits across pages instead of pushing the WHOLE question+answer card
// onto a fresh page (see splitAnswerBlocksForHeight + the card loop in
// generateAnswersPdf) — this is the height reserved on each half of a
// split card for the small "continues on next page" / "continued from
// previous page" note.
const CONTINUATION_NOTE_H = 16;
// Splitting is attempted whenever there's room left for the question +
// divider + ANSWER label + at least this many real answer line(s) —
// regardless of whether the answer overall is short or long. Previously
// this required 2 full lines of leftover room before bothering to split;
// now even a single leftover line is used instead of pushing the whole
// card to the next page and wasting that space.
const MIN_SPLIT_ANSWER_LINES = 1;

// ---------------------------------------------------------------------
// Small text-measuring/drawing helpers (functionally identical to the
// prior designs' — see lib/pdfGenerator.js for the detailed rationale on
// Arabic run-grouping — just wired to this file's own font constants and
// colors legible against a dark card).
// ---------------------------------------------------------------------
function tokenizeHighlighted(text) {
  const parts = String(text || '').split(/\*([^*]+)\*/g);
  const tokens = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    const bold = idx % 2 === 1;
    const words = part.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      if (isMostlyArabic(words[i])) {
        const run = [words[i]];
        let j = i + 1;
        while (j < words.length && isMostlyArabic(words[j])) {
          run.push(words[j]);
          j++;
        }
        const joined = run.join(' ');
        tokens.push({ text: joined, shaped: shapeArabicLine(joined), arabic: true, bold });
        i = j;
      } else {
        tokens.push({ text: words[i], shaped: words[i], arabic: false, bold });
        i++;
      }
    }
  });
  return tokens;
}

function tokenFont(tok) {
  if (tok.arabic) return tok.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR;
  return tok.bold ? FONT_BOLD : FONT_REGULAR;
}

function wrapTokens(doc, tokens, size, maxWidth) {
  doc.fontSize(size);
  doc.font(FONT_REGULAR);
  const spaceWidth = doc.widthOfString(' ');
  const lines = [];
  let current = [];
  let currentWidth = 0;

  tokens.forEach((tok) => {
    doc.font(tokenFont(tok)).fontSize(size);
    const w = doc.widthOfString(tok.shaped);
    const extra = current.length > 0 ? spaceWidth + w : w;
    if (current.length > 0 && currentWidth + extra > maxWidth) {
      lines.push(current);
      current = [tok];
      currentWidth = w;
    } else {
      current.push(tok);
      currentWidth += extra;
    }
  });
  if (current.length > 0) lines.push(current);
  return lines;
}

// Highlighted (*bold*) inline terms use the bright accent color rather
// than a darkened one — on a dark card, a *darker* accent would lose
// contrast instead of standing out.
function drawTokenLines(doc, colors, lines, x, y, size, lineHeight) {
  lines.forEach((line, i) => {
    let cx = x;
    const ly = y + i * lineHeight;
    line.forEach((tok) => {
      doc.font(tokenFont(tok)).fontSize(size);
      const spaceWidth = doc.widthOfString(' ');
      doc.fillColor(tok.bold ? colors.orange : NEUTRAL_INK);
      doc.text(tok.shaped, cx, ly, { lineBreak: false });
      cx += doc.widthOfString(tok.shaped) + spaceWidth;
    });
  });
}

function wrapArabicPlain(doc, text, font, size, maxWidth) {
  const words = String(text || '')
    .replace(/\*/g, '')
    .split(/\s+/)
    .filter(Boolean);
  return wrapWordsByWidth(doc, words, font, size, maxWidth);
}

function drawArabicLines(doc, lines, x, y, width, font, size, lineHeight, color) {
  doc.font(font).fontSize(size).fillColor(color);
  lines.forEach((line, i) => {
    const shaped = shapeArabicLine(line);
    const w = doc.widthOfString(shaped);
    doc.text(shaped, x + Math.max(0, width - w), y + i * lineHeight, { lineBreak: false });
  });
}

function measureQuestion(doc, question, width) {
  if (isMostlyArabic(question)) {
    const lines = wrapArabicPlain(doc, question, FONT_ARABIC_BOLD, QUESTION_SIZE, width);
    return { arabic: true, lines, height: lines.length * LINE_HEIGHT_Q };
  }
  doc.font(FONT_BOLD).fontSize(QUESTION_SIZE);
  const height = doc.heightOfString(question, { width, lineGap: 2 });
  return { arabic: false, height: Math.max(height, LINE_HEIGHT_Q) };
}

function drawQuestion(doc, colors, measured, question, x, y, width) {
  if (measured.arabic) {
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, colors.orange);
  } else {
    doc.font(FONT_BOLD).fontSize(QUESTION_SIZE).fillColor(colors.orange);
    doc.text(question, x, y, { width, lineGap: 2 });
  }
}

const BULLET_RE = /^[-•]\s+/;
const BULLET_INDENT = 13;
const PARA_GAP = 4;

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function measureAnswer(doc, answer, width) {
  const paragraphs = splitParagraphs(answer);
  const blocks = paragraphs.map((raw) => {
    const bullet = BULLET_RE.test(raw);
    const p = bullet ? raw.replace(BULLET_RE, '') : raw;
    const innerWidth = bullet ? width - BULLET_INDENT : width;
    if (isMostlyArabic(p)) {
      const words = tokenizeArabicHighlightedWords(p);
      const lines = wrapArabicHighlightedWords(doc, words, ANSWER_SIZE, innerWidth);
      return { arabic: true, bullet, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_A };
    }
    const tokens = tokenizeHighlighted(p);
    const lines = wrapTokens(doc, tokens, ANSWER_SIZE, innerWidth);
    return { arabic: false, bullet, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_A };
  });
  const height = blocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, blocks.length - 1);
  return { blocks, height };
}

function drawAnswer(doc, colors, measured, x, y, width) {
  let cy = y;
  measured.blocks.forEach((b) => {
    const innerWidth = b.bullet ? width - BULLET_INDENT : width;
    if (b.arabic) {
      drawArabicHighlightedLines(doc, colors, b.lines, x, cy, innerWidth, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.rect(x + width - 8, cy + 4, 4, 4).fill(colors.orange);
    } else {
      drawTokenLines(doc, colors, b.lines, b.bullet ? x + BULLET_INDENT : x, cy, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.rect(x, cy + 4, 4, 4).fill(colors.orange);
    }
    cy += b.height + PARA_GAP;
  });
}

// ---------------------------------------------------------------------
// Comparison tables — solid warm-graphite frame (no glow), thick accent
// rule under the header, thin low-opacity horizontal row separators
// only, no vertical rules.
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;
const TABLE_HEADER_GAP = 3;
const TABLE_RADIUS = 6;

function computeColumnWidths(columns, width, aspectIndex = 0) {
  const n = columns.length;
  if (n === 0) return [];
  const firstW = Math.min(Math.max(width * 0.22, 70), width * 0.34);
  const restW = (width - firstW) / Math.max(1, n - 1);
  return columns.map((_, i) => (i === aspectIndex ? firstW : restW));
}

function tokenizeArabicHighlightedWords(text) {
  const parts = String(text || '').split(/\*([^*]+)\*/g);
  const words = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    const bold = idx % 2 === 1;
    part
      .split(/\s+/)
      .filter(Boolean)
      .forEach((w) => words.push({ word: w, bold }));
  });
  return words;
}

function wrapArabicHighlightedWords(doc, words, size, maxWidth) {
  doc.font(FONT_ARABIC_REGULAR).fontSize(size);
  const spaceWidth = doc.widthOfString(' ');
  const lines = [];
  let current = [];
  let currentWidth = 0;

  words.forEach((w) => {
    doc.font(w.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR).fontSize(size);
    const wWidth = doc.widthOfString(w.word);
    const extra = current.length > 0 ? spaceWidth + wWidth : wWidth;
    if (current.length > 0 && currentWidth + extra > maxWidth) {
      lines.push(current);
      current = [w];
      currentWidth = wWidth;
    } else {
      current.push(w);
      currentWidth += extra;
    }
  });
  if (current.length > 0) lines.push(current);
  return lines;
}

function buildArabicHighlightedRuns(line) {
  const runs = [];
  line.forEach((w) => {
    const last = runs[runs.length - 1];
    if (last && last.bold === w.bold) {
      last.words.push(w.word);
    } else {
      runs.push({ bold: w.bold, words: [w.word] });
    }
  });
  return runs.map((r) => ({ bold: r.bold, shaped: shapeArabicLine(r.words.join(' ')) }));
}

function drawArabicHighlightedLines(doc, colors, lines, x, y, width, size, lineHeight) {
  doc.font(FONT_ARABIC_REGULAR).fontSize(size);
  const spaceWidth = doc.widthOfString(' ');

  lines.forEach((line, i) => {
    const runs = buildArabicHighlightedRuns(line).map((r) => {
      doc.font(r.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR).fontSize(size);
      return { ...r, w: doc.widthOfString(r.shaped) };
    });
    const totalWidth = runs.reduce((sum, r) => sum + r.w, 0) + spaceWidth * Math.max(0, runs.length - 1);

    const ly = y + i * lineHeight;
    let cx = x + Math.max(0, width - totalWidth);
    [...runs].reverse().forEach((r) => {
      doc.font(r.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR).fontSize(size).fillColor(r.bold ? colors.orange : NEUTRAL_INK);
      doc.text(r.shaped, cx, ly, { lineBreak: false });
      cx += r.w + spaceWidth;
    });
  });
}

function measureHeaderCell(doc, text, colWidth) {
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (isMostlyArabic(text)) {
    const lines = wrapArabicPlain(doc, text, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, innerWidth);
    return { arabic: true, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
  }
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = wrapWordsByWidth(doc, words, FONT_BOLD, TABLE_FONT_SIZE, innerWidth);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
}

function measureBodyCell(doc, text, colWidth) {
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (isMostlyArabic(text)) {
    const words = tokenizeArabicHighlightedWords(text);
    const lines = wrapArabicHighlightedWords(doc, words, TABLE_FONT_SIZE, innerWidth);
    return { arabic: true, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
  }
  const tokens = tokenizeHighlighted(text);
  const lines = wrapTokens(doc, tokens, TABLE_FONT_SIZE, innerWidth);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
}

function isArabicTable(columns) {
  return isMostlyArabic(columns.join(' '));
}

function measureComparisonTable(doc, table, width) {
  const rawColumns = (table && table.columns) || [];
  const rawRows = (table && table.rows) || [];
  const rtl = isArabicTable(rawColumns);
  const columns = rtl ? [...rawColumns].reverse() : rawColumns;
  const rows = rtl ? rawRows.map((row) => [...row].reverse()) : rawRows;
  const aspectIndex = rtl ? columns.length - 1 : 0;

  const colWidths = computeColumnWidths(columns, width, aspectIndex);
  const headerCells = columns.map((c, i) => measureHeaderCell(doc, c, colWidths[i]));
  const headerHeight = Math.max(TABLE_ROW_LINE_H, ...headerCells.map((c) => c.height)) + TABLE_CELL_PAD * 2;
  const bodyRows = rows.map((row) => {
    const cells = columns.map((_, i) => measureBodyCell(doc, row[i] || '', colWidths[i]));
    const rowHeight = Math.max(TABLE_ROW_LINE_H, ...cells.map((c) => c.height)) + TABLE_CELL_PAD * 2;
    return { cells, height: rowHeight };
  });
  const height = headerHeight + TABLE_HEADER_GAP + bodyRows.reduce((s, r) => s + r.height, 0);
  return { colWidths, headerCells, headerHeight, bodyRows, height };
}

function drawHeaderCellText(doc, colors, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, colors.orange);
  } else {
    doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor(colors.orange);
    cell.lines.forEach((line, i) => {
      doc.text(line, innerX, y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H, { width: innerWidth, lineBreak: false });
    });
  }
}

function drawBodyCellText(doc, colors, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicHighlightedLines(doc, colors, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, TABLE_FONT_SIZE, TABLE_ROW_LINE_H);
  } else {
    cell.lines.forEach((line, i) => {
      let cx = innerX;
      const ly = y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H;
      line.forEach((tok) => {
        doc.font(tokenFont(tok)).fontSize(TABLE_FONT_SIZE);
        const spaceWidth = doc.widthOfString(' ');
        doc.fillColor(tok.bold ? colors.orange : NEUTRAL_INK);
        doc.text(tok.shaped, cx, ly, { lineBreak: false });
        cx += doc.widthOfString(tok.shaped) + spaceWidth;
      });
    });
  }
}

function drawComparisonTable(doc, colors, measured, x, y, width) {
  const { colWidths, headerCells, headerHeight, bodyRows } = measured;

  // Solid warm-graphite frame — no glow, no vertical/horizontal
  // gridlines; row separation instead comes from alternating fills + a
  // single thin low-opacity rule per row.
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).fill(CARD_BG);
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).stroke();
  doc.restore();

  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, colors, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(2);
  doc.moveTo(x + 6, y + headerHeight).lineTo(x + width - 6, y + headerHeight).stroke();
  doc.restore();

  let ry = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x + 1, ry, width - 2, row.height).fill(ridx % 2 === 0 ? CARD_BG : TABLE_ROW_ALT);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, colors, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    if (ridx > 0) {
      doc.save();
      doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.6);
      doc.moveTo(x + 6, ry).lineTo(x + width - 6, ry).stroke();
      doc.restore();
    }
    ry += row.height;
  });

  // Re-stroke the crisp outer border on top of the row fills.
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).stroke();
  doc.restore();
}

// Returns { firstBlocks, restBlocks }: everything that fits within
// maxHeight goes in firstBlocks (in original order), everything else —
// including the tail of a block that only PARTIALLY fit — goes in
// restBlocks (also in original order). A block only ever gets split
// once, never left with zero lines on either side, so re-drawing either
// half with drawAnswer() never draws an empty/degenerate paragraph. See
// lib/pdfGenerator.js for the original version of this helper.
function splitAnswerBlocksForHeight(blocks, maxHeight) {
  const firstBlocks = [];
  const restBlocks = [];
  let usedHeight = 0;
  let splitDone = false;

  blocks.forEach((b) => {
    if (splitDone) {
      restBlocks.push(b);
      return;
    }

    const gap = firstBlocks.length > 0 ? PARA_GAP : 0;
    if (usedHeight + gap + b.height <= maxHeight) {
      firstBlocks.push(b);
      usedHeight += gap + b.height;
      return;
    }

    // This block doesn't fully fit — see how many of ITS lines fit in
    // whatever's left, and split the block itself at that line.
    const availableForBlock = maxHeight - usedHeight - gap;
    const linesThatFit = Math.max(0, Math.floor(availableForBlock / LINE_HEIGHT_A));

    if (linesThatFit > 0 && linesThatFit < b.lines.length) {
      firstBlocks.push({ ...b, lines: b.lines.slice(0, linesThatFit), height: linesThatFit * LINE_HEIGHT_A });
      restBlocks.push({ ...b, lines: b.lines.slice(linesThatFit), height: (b.lines.length - linesThatFit) * LINE_HEIGHT_A });
    } else {
      // Not even one line of this block fits (or the whole block would
      // fit as-is, just not with the gap above it) — the entire block
      // moves to the next page intact.
      restBlocks.push(b);
    }
    splitDone = true;
  });

  return { firstBlocks, restBlocks };
}

function measureAnswerBody(doc, r, width) {
  if (r.isComparison && r.comparisonTable && Array.isArray(r.comparisonTable.columns) && r.comparisonTable.columns.length > 0) {
    const measured = measureComparisonTable(doc, r.comparisonTable, width);
    const introHeight = r.answer ? measureAnswer(doc, r.answer, width) : null;
    return { kind: 'table', measured, intro: introHeight, height: measured.height + (introHeight ? introHeight.height + PARA_GAP : 0) };
  }
  const measured = measureAnswer(doc, r.answer, width);
  return { kind: 'text', measured, height: measured.height };
}

function drawAnswerBody(doc, colors, body, x, y, width) {
  let cy = y;
  if (body.kind === 'table') {
    if (body.intro) {
      drawAnswer(doc, colors, body.intro, x, cy, width);
      cy += body.intro.height + PARA_GAP;
    }
    drawComparisonTable(doc, colors, body.measured, x, cy, width);
  } else {
    drawAnswer(doc, colors, body.measured, x, y, width);
  }
}

// Divider — a plain thin rule with a small solid accent square tucked
// at its LEFT end. Distinct from design_5's centered glow line + dot,
// design_4's dashed+bracket line, design_1's chevron/diamond, and
// design_2's plain unbroken rule.
function drawDivider(doc, colors, x, y, width) {
  doc.save();
  doc.fillColor(colors.orange);
  doc.rect(x, y - 2, 10, 4).fill();
  doc.restore();

  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(x + 16, y).lineTo(x + width, y).stroke();
  doc.restore();
}

// Chapter header — a capsule that HUGS its own text width (solid accent
// fill, dark text), centered on the page. Unlike a fixed-width box, a
// hugging capsule can never be handed a text width smaller than what
// the text actually needs, so PDFKit's wrap-to-width behavior (which
// "lineBreak: false" does NOT suppress — that option only blocks
// splitting on explicit "\n" characters) can never fire and split the
// title onto a second line. Only if a title is wider than the page does
// this fall back to shrinking the font, and finally to an ellipsis.
const CHAPTER_HEADER_SIZE = 14;
const CHAPTER_HEADER_MIN_SIZE = 9;
const CHAPTER_HEADER_PAD_X = 22;
const CHAPTER_HEADER_PAD_Y = 11;
const CHAPTER_HEADER_GAP = 18;

// Shrinks font size (and, as a last resort, truncates with an ellipsis)
// until `text` fits within `maxWidth` on a single line. Returns the
// final { text, size, width } — `width` is always the REAL rendered
// width of the returned text, never a smaller clamped value.
function fitChapterText(doc, font, text, maxWidth, startSize, minSize, textOpts = {}) {
  let size = startSize;
  doc.font(font);
  let width = doc.fontSize(size).widthOfString(text, textOpts);

  while (width > maxWidth && size > minSize) {
    size -= 0.5;
    width = doc.fontSize(size).widthOfString(text, textOpts);
  }

  if (width > maxWidth) {
    let truncated = text;
    doc.fontSize(size);
    while (truncated.length > 1 && doc.widthOfString(truncated + '…', textOpts) > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    text = truncated.length < text.length ? truncated + '…' : truncated;
    width = doc.widthOfString(text, textOpts);
  }

  return { text, size, width };
}

function measureChapterHeader(doc, chapterText, pageContentWidth) {
  const maxTextW = pageContentWidth - CHAPTER_HEADER_PAD_X * 2;
  const arabic = isMostlyArabic(chapterText);

  let fitted;
  if (arabic) {
    const shaped = shapeArabicLine(chapterText);
    fitted = fitChapterText(doc, FONT_ARABIC_BOLD, shaped, maxTextW, CHAPTER_HEADER_SIZE, CHAPTER_HEADER_MIN_SIZE);
  } else {
    const upper = chapterText.toUpperCase();
    fitted = fitChapterText(
      doc,
      FONT_HEADING,
      upper,
      maxTextW,
      CHAPTER_HEADER_SIZE - 1,
      CHAPTER_HEADER_MIN_SIZE - 1,
      { characterSpacing: 0.5 }
    );
  }

  const capsuleW = fitted.width + CHAPTER_HEADER_PAD_X * 2;
  const capsuleH = fitted.size + CHAPTER_HEADER_PAD_Y * 2;
  return { arabic, fitted, capsuleW, capsuleH };
}

// FIX: no `width` is passed to doc.text() here anymore. The text is
// already precisely centered via its x position (cx - fitted.width/2),
// so a `width` option is unnecessary — and passing one re-opens the
// exact wrap-to-width failure mode this design was meant to close,
// since PDFKit can still wrap even when width ~= the measured width if
// the actually-rendered glyph run comes out a touch wider (rounding /
// hinting / trailing character-spacing differences between
// widthOfString and text()). Dropping `width` makes a second line
// impossible: there is nothing left for PDFKit to wrap against.
function drawChapterHeader(doc, colors, measured, pageContentX, y, pageContentWidth) {
  const { arabic, fitted, capsuleW, capsuleH } = measured;
  const cx = pageContentX + pageContentWidth / 2;
  const capsuleX = cx - capsuleW / 2;
  const r = capsuleH / 2;

  doc.roundedRect(capsuleX, y, capsuleW, capsuleH, r).fill(colors.orange);

  const textY = y + (capsuleH - fitted.size) / 2 - 1;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(fitted.size).fillColor(PAGE_BG);
  doc.text(fitted.text, cx - fitted.width / 2, textY, {
    lineBreak: false,
    ...(arabic ? {} : { characterSpacing: 0.5 }),
  });
}

// Header: a plain thin hairline near the top — no dot, no glow, no
// checkerboard, no brackets.
function drawHeader(doc, pageWidth) {
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(0, HEADER_LINE_Y).lineTo(pageWidth, HEADER_LINE_Y).stroke();
  doc.restore();
}

const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';
const FOOTER_BADGE_SIZE = 20;

// Footer: hairline, brand text (letter-spaced, gray) on the left, and a
// small solid accent square page-number chip on the right.
function drawFooter(doc, colors, pageNum, pageWidth, pageHeight, brand) {
  const lineY = pageHeight - FOOTER_H;
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(0, lineY).lineTo(pageWidth, lineY).stroke();
  doc.restore();

  const rowY = lineY + (FOOTER_ROW_H - 10) / 2 + 2;
  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();
  doc.font(FONT_REGULAR).fontSize(9).fillColor(NEUTRAL_GRAY);
  doc.text(brandText, PAGE_MARGIN, rowY, { lineBreak: false, characterSpacing: 1.5 });

  const bx = pageWidth - PAGE_MARGIN - FOOTER_BADGE_SIZE;
  const by = lineY + (FOOTER_ROW_H - FOOTER_BADGE_SIZE) / 2 + 1;
  doc.roundedRect(bx, by, FOOTER_BADGE_SIZE, FOOTER_BADGE_SIZE, 4).fill(colors.orange);
  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(9).fillColor(PAGE_BG);
  doc.text(pageNumText, bx, by + (FOOTER_BADGE_SIZE - 9) / 2 - 1, {
    width: FOOTER_BADGE_SIZE,
    align: 'center',
    lineBreak: false,
  });
}

// Card frame — rectangular, soft corners, SOLID thick accent bar down
// the left edge instead of a glow halo or HUD brackets.
function drawCardFrame(doc, colors, x, y, w, h) {
  doc.roundedRect(x, y, w, h, CARD_RADIUS).fill(CARD_BG);
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.roundedRect(x, y, w, h, CARD_RADIUS).stroke();
  doc.restore();

  // Solid accent bar clipped to the card's rounded left edge.
  doc.save();
  doc.roundedRect(x, y, w, h, CARD_RADIUS).clip();
  doc.rect(x, y, CARD_ACCENT_BAR_W, h).fill(colors.orange);
  doc.restore();
}

// Hexagon badge — a solid flat-top hexagon chip holding the question
// number — replaces design_1's circle, design_2's square, design_3's
// margin watermark numeral, design_4's pennant, and design_5's rotated
// diamond.
const HEX_SIZE = 24;

function drawBadge(doc, colors, idx, x, y) {
  const cx = x + HEX_SIZE / 2;
  const cy = y + HEX_SIZE / 2;
  const w = HEX_SIZE / 2;
  const h = HEX_SIZE / 2;
  const points = [
    [cx - w * 0.5, cy - h],
    [cx + w * 0.5, cy - h],
    [cx + w, cy],
    [cx + w * 0.5, cy + h],
    [cx - w * 0.5, cy + h],
    [cx - w, cy],
  ];

  doc.save();
  doc.moveTo(points[0][0], points[0][1]);
  points.slice(1).forEach(([px, py]) => doc.lineTo(px, py));
  doc.closePath();
  doc.fill(colors.orange);
  doc.restore();

  const numText = String(idx + 1).padStart(2, '0');
  doc.font(FONT_HEADING).fontSize(8.5).fillColor(PAGE_BG);
  doc.text(numText, x, cy - 4, { width: HEX_SIZE, align: 'center', lineBreak: false });
}

// results: [{ question, answer, page, isError, chapter }] — see
// lib/pdfGenerator.js's header comment for the chapter-banner contract.
// meta: { title, bookName, colorKey, footerBrand } — colorKey is one of
// lib/pdfColors.js's PDF_COLOR_PRESETS keys (defaults to orange/coral).
function generateAnswersPdf(results, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const colors = getColorTheme(meta.colorKey || DEFAULT_PDF_COLOR);
      const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: false });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont(FONT_ARABIC_REGULAR, FONT_ARABIC_REGULAR_PATH);
      doc.registerFont(FONT_ARABIC_BOLD, FONT_ARABIC_BOLD_PATH);
      doc.registerFont(FONT_REGULAR, FONT_REGULAR_PATH);
      doc.registerFont(FONT_BOLD, FONT_BOLD_PATH);
      doc.registerFont(FONT_HEADING, FONT_HEADING_PATH);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentX = PAGE_MARGIN;
      const contentWidth = pageWidth - PAGE_MARGIN * 2;

      let pageNum = 1;
      let y;

      function startPage() {
        doc.rect(0, 0, pageWidth, pageHeight).fill(PAGE_BG);
        drawHeader(doc, pageWidth);
        y = PAGE_CONTENT_TOP;
      }

      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) {
          drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta.footerBrand);
          doc.addPage();
          pageNum += 1;
          startPage();
        }
      }

      startPage();

      let lastChapter = null;

      results.forEach((r, idx) => {
        if (r.chapter && r.chapter !== lastChapter) {
          if (y > PAGE_CONTENT_TOP) {
            drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta.footerBrand);
            doc.addPage();
            pageNum += 1;
            startPage();
          }
          const chMeasured = measureChapterHeader(doc, r.chapter, contentWidth);
          drawChapterHeader(doc, colors, chMeasured, contentX, y, contentWidth);
          y += chMeasured.capsuleH + CHAPTER_HEADER_GAP;
          lastChapter = r.chapter;
        }

        const textColX = contentX + CARD_PADDING + BADGE_COL_W;
        const textColWidth = contentWidth - CARD_PADDING * 2 - BADGE_COL_W;
        // The answer body (and any comparison table) is drawn full-width
        // below the badge row, NOT offset by BADGE_COL_W — so it must be
        // measured at the same full width it's drawn at, or lines/table
        // columns would overshoot the card's right border (see the fix
        // applied to design_3, where this measure/draw width mismatch
        // was the actual bug).
        const fullTextWidth = contentWidth - CARD_PADDING * 2;

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        const aBody = measureAnswerBody(doc, r, fullTextWidth);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const innerHeight =
          qMeasured.height +
          10 + // divider gap
          8 + // gap before ANSWER label
          LABEL_SIZE +
          6 +
          aBody.height +
          (pageNoteText ? 16 : 0);
        const cardHeight = innerHeight + CARD_PADDING * 2 + 6;
        const answerX = contentX + CARD_PADDING;

        // Draws the normal, single-page card exactly as before the
        // dynamic-fill feature existed — used both for the common "fits
        // on this page" case and as the fallback whenever splitting isn't
        // possible/worthwhile (comparison tables, or too little space
        // left to make splitting worth it).
        function drawFullCard() {
          ensureSpace(cardHeight + CARD_GAP);
          const cardY = y;
          drawCardFrame(doc, colors, contentX, cardY, contentWidth, cardHeight);

          // Hexagon badge in the top-left of the card, in the reserved
          // BADGE_COL_W column.
          drawBadge(doc, colors, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 3);

          // Question — offset past the badge column.
          let curY = cardY + CARD_PADDING;
          drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
          curY += qMeasured.height + 10;

          // Divider — thin rule with accent square at left end.
          drawDivider(doc, colors, textColX, curY, textColWidth);
          curY += 12;

          // ANSWER label
          doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orange);
          doc.text('ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
          curY += LABEL_SIZE + 8;

          // Answer body — full card width, not offset by the badge column.
          drawAnswerBody(doc, colors, aBody, answerX, curY, fullTextWidth);
          curY += aBody.height;

          // Page citation
          if (pageNoteText) {
            curY += 4;
            doc.font(FONT_REGULAR).fontSize(9).fillColor(NEUTRAL_GRAY);
            const w = doc.widthOfString(pageNoteText);
            doc.text(pageNoteText, contentX + contentWidth - CARD_PADDING - w, curY, { lineBreak: false });
          }

          y = cardY + cardHeight + CARD_GAP;
        }

        // Plain (non-rounded) box for a split card half — used instead of
        // drawCardFrame's roundedRect, whose rounded edge would visually
        // read as "the card closes here", which is misleading when the
        // answer actually continues onto the next page (same reasoning
        // as design_1's split halves — see lib/pdfGenerator.js).
        function drawSplitHalf(boxY, boxHeight) {
          doc.rect(contentX, boxY, contentWidth, boxHeight).fill(CARD_BG);
          doc.save();
          doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
          doc.rect(contentX, boxY, contentWidth, boxHeight).stroke();
          doc.restore();
          doc.rect(contentX, boxY, CARD_ACCENT_BAR_W, boxHeight).fill(colors.orange);
        }

        const availableOnPage = pageHeight - FOOTER_H - 14 - y;

        if (cardHeight <= availableOnPage || aBody.kind !== 'text') {
          // Fits on the current page as-is (the common case), OR this is
          // a comparison-table answer — table rows aren't line-splittable
          // the way splitAnswerBlocksForHeight works, so tables keep the
          // original "whole card or next page" behavior.
          drawFullCard();
        } else {
          // Doesn't fit whole. Instead of pushing the ENTIRE card to a
          // fresh page and leaving whatever's left of the CURRENT page
          // permanently blank, see if splitting the answer TEXT itself
          // across the page boundary is worthwhile: draw the question +
          // as much of the answer as fits here, continue the rest at the
          // top of the next page.
          //
          // headerHeight mirrors the exact curY increments drawFullCard
          // uses before the answer body starts (question + 10, divider +
          // 12, label + 8) — how much of a split card's first half is
          // taken up by the non-splittable header (question/divider/
          // label), before any answer-line space.
          const headerHeight = qMeasured.height + 10 + 12 + LABEL_SIZE + 8;
          const spaceForAnswerHere = availableOnPage - CARD_PADDING - headerHeight - CONTINUATION_NOTE_H - 6;

          const { firstBlocks, restBlocks } =
            spaceForAnswerHere >= MIN_SPLIT_ANSWER_LINES * LINE_HEIGHT_A
              ? splitAnswerBlocksForHeight(aBody.measured.blocks, spaceForAnswerHere)
              : { firstBlocks: [], restBlocks: [] };

          if (firstBlocks.length === 0 || restBlocks.length === 0) {
            // Not enough room to make splitting worthwhile (or splitting
            // found nothing useful to put on either side) — same as
            // before this feature existed: push the whole card over.
            drawFullCard();
          } else {
            const firstAnswerHeight =
              firstBlocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, firstBlocks.length - 1);
            const firstPartHeight = CARD_PADDING + headerHeight + firstAnswerHeight + CONTINUATION_NOTE_H + CARD_PADDING;

            const cardY = y;
            drawSplitHalf(cardY, firstPartHeight);
            drawBadge(doc, colors, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 3);

            let curY = cardY + CARD_PADDING;
            drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
            curY += qMeasured.height + 10;

            drawDivider(doc, colors, textColX, curY, textColWidth);
            curY += 12;

            doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orange);
            doc.text('ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
            curY += LABEL_SIZE + 8;

            drawAnswer(doc, colors, { blocks: firstBlocks }, answerX, curY, fullTextWidth);
            curY += firstAnswerHeight + 4;

            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(NEUTRAL_GRAY);
            doc.text(`▾ Q${idx + 1} continues on next page…`, answerX, curY, { width: fullTextWidth });

            y = cardY + firstPartHeight;

            drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta.footerBrand);
            doc.addPage();
            pageNum += 1;
            startPage();

            const restAnswerHeight =
              restBlocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, restBlocks.length - 1);
            const secondPartHeight =
              CARD_PADDING + CONTINUATION_NOTE_H + restAnswerHeight + (pageNoteText ? 16 : 0) + CARD_PADDING + 6;

            const cardY2 = y;
            drawSplitHalf(cardY2, secondPartHeight);

            let curY2 = cardY2 + CARD_PADDING;
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(NEUTRAL_GRAY);
            doc.text(`↳ Q${idx + 1} (continued):`, answerX, curY2, { width: fullTextWidth });
            curY2 += CONTINUATION_NOTE_H;

            drawAnswer(doc, colors, { blocks: restBlocks }, answerX, curY2, fullTextWidth);
            curY2 += restAnswerHeight;

            if (pageNoteText) {
              curY2 += 4;
              doc.font(FONT_REGULAR).fontSize(9).fillColor(NEUTRAL_GRAY);
              const w = doc.widthOfString(pageNoteText);
              doc.text(pageNoteText, contentX + contentWidth - CARD_PADDING - w, curY2, { lineBreak: false });
            }

            y = cardY2 + secondPartHeight + CARD_GAP;
          }
        }
      });

      drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta.footerBrand);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAnswersPdf };
