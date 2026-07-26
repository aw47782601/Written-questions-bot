// Renders a batch of {question, answer, page} results as a styled PDF in
// a dark "neon glow" look — the "design_5" template (see
// lib/pdfDesigns.js for the design registry). Design_4 ("Vertex design")
// was already the first dark design (square-cornered HUD/blueprint
// look); this one is dark too, but a deliberate, 100% visual break from
// ALL FOUR prior designs, design_4 especially since they share the
// dark-page space:
//
//  - Different font stack from any prior pairing: Lato (regular/bold)
//    for body copy, Abril Fatface for headings — design_2 pairs Lato
//    with Archivo Black, design_3 pairs Abril Fatface with Spectral, so
//    this specific pairing is new — plus Tajawal for Arabic (shared with
//    design_2's font file, but never previously paired with Lato+Abril
//    Fatface together).
//  - Deep plum/indigo page (not design_4's near-black navy) with
//    ROUNDED cards that carry a soft multi-stroke "glow" halo around
//    their border — design_4's cards are square-cornered with hard HUD
//    corner brackets and no glow at all.
//  - Badge is a rotated diamond "gem" chip, not design_1's circle,
//    design_2's square, design_3's watermark numeral, or design_4's
//    pennant tag.
//  - The divider is a full-width glowing line (a soft wide low-opacity
//    stroke plus a crisp bright hairline on top of it) with a single
//    accent dot at its center — distinct from design_4's short dashed
//    line with bracket ticks, design_1's chevron/diamond, design_2's
//    plain rule, and design_3's short centered rule-diamond.
//  - Chapter headers are a centered pill/capsule outline (card-colored
//    fill, glowing accent-colored stroke, accent-colored text) — the
//    opposite fill relationship from design_4's solid-filled arrow
//    banner with dark text, and unlike design_1's solid banner,
//    design_2's left-bar+underline, or design_3's rule-flanked title.
//  - The comparison table drops gridlines entirely: a single glowing
//    rounded outer frame, a thick accent rule under the header, and only
//    thin low-opacity horizontal row separators — no vertical rules at
//    all, unlike every prior design's fully gridded/ruled table.
//  - Header/footer are minimal: a single glowing hairline with one
//    centered accent dot at the top, and a glowing circular page-number
//    badge at the bottom instead of design_4's corner brackets + pill
//    chip, design_1's checkerboard, design_2's plain rule + text, or
//    design_3's double rule + diamond ornament.
//
// Functionally it keeps full feature parity with design_1/2/3/4:
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

// Fixed dark "neon" tones used alongside the accent color. Only the
// accent itself (badge, glow halos, divider, chapter pill, table rule,
// header/footer dot + page badge) comes from the user's chosen colorKey
// (see lib/pdfColors.js) — everything else stays a fixed deep
// plum/indigo so the page reads as a glowing card on dark glass rather
// than design_4's flat navy HUD readout.
const NEUTRAL_INK = '#E9E4F5'; // body text on dark cards
const NEUTRAL_GRAY = '#8B84A6'; // secondary text: page citation, footer brand
const NEUTRAL_BORDER = '#332B52'; // hairlines / row separators
const PAGE_BG = '#0F0B1A'; // deep near-black plum page
const CARD_BG = '#1A1430'; // lighter indigo card
const TABLE_ROW_ALT = '#211A3B'; // alternate table row shade

const HEADER_LINE_Y = 22;
const HEADER_H = HEADER_LINE_Y + 14;
const PAGE_CONTENT_TOP = HEADER_H + 14;

const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 14;

const CARD_PADDING = 18;
const CARD_GAP = 18;
const CARD_RADIUS = 14;
const BADGE_COL_W = 38; // reserved margin for the diamond "gem" badge
const QUESTION_SIZE = 15;
const LABEL_SIZE = 9.5;
const ANSWER_SIZE = 13.5;
const LINE_HEIGHT_Q = 19;
const LINE_HEIGHT_A = 18.5;

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
// Comparison tables — no gridlines at all: a single glowing rounded
// outer frame, a thick accent rule under the header, and thin
// low-opacity horizontal row separators only.
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;
const TABLE_HEADER_GAP = 3;
const TABLE_RADIUS = 10;

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

  // Soft glowing rounded outer frame — no vertical/horizontal gridlines
  // like design_4's terminal grid; row separation instead comes from
  // alternating fills + a single thin low-opacity rule per row.
  drawGlowFrame(doc, colors, x, y, width, measured.height, TABLE_RADIUS);

  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, colors, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.75);
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

  // Re-stroke the crisp outer border on top of the row fills so it stays
  // visible (the glow halo underneath is soft/low-opacity by design).
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.2);
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).stroke();
  doc.restore();
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

// Divider — a full-width glowing line: a soft wide low-opacity stroke
// underneath a crisp bright hairline, with a single small accent dot at
// its center. Distinct from design_4's short dashed+bracket line,
// design_1's chevron/diamond, design_2's plain rule, and design_3's
// short centered rule-diamond.
function drawDivider(doc, colors, x, y, width) {
  doc.save();
  doc.strokeColor(colors.orange).strokeOpacity(0.16).lineWidth(3);
  doc.moveTo(x, y).lineTo(x + width, y).stroke();
  doc.strokeOpacity(0.85).lineWidth(1);
  doc.moveTo(x, y).lineTo(x + width, y).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(colors.orange);
  doc.circle(x + width / 2, y, 2.2).fill();
  doc.restore();
}

// Chapter header — a centered pill/capsule OUTLINE: card-colored fill,
// a glowing accent stroke, and accent-colored uppercase text — the
// opposite fill relationship from design_4's solid-filled arrow banner
// (accent fill + dark text). Distinct from design_1's solid banner,
// design_2's left-bar+underline, and design_3's rule-flanked title too.
const CHAPTER_HEADER_SIZE = 15;
const CHAPTER_HEADER_H = 40;
const CHAPTER_HEADER_GAP = 18;

function drawChapterHeader(doc, colors, chapterText, x, y, width) {
  const r = CHAPTER_HEADER_H / 2;
  drawGlowFrame(doc, colors, x, y, width, CHAPTER_HEADER_H, r);

  const cx = x + width / 2;
  const textY = y + (CHAPTER_HEADER_H - CHAPTER_HEADER_SIZE) / 2 - 1;
  const maxTextW = width - 60;
  if (isMostlyArabic(chapterText)) {
    const shaped = shapeArabicLine(chapterText);
    doc.font(FONT_ARABIC_BOLD).fontSize(CHAPTER_HEADER_SIZE).fillColor(colors.orange);
    const w = Math.min(doc.widthOfString(shaped), maxTextW);
    doc.text(shaped, cx - w / 2, textY, { width: w, lineBreak: false });
  } else {
    doc.font(FONT_HEADING).fontSize(CHAPTER_HEADER_SIZE - 1).fillColor(colors.orange);
    const upper = chapterText.toUpperCase();
    const w = Math.min(doc.widthOfString(upper, { characterSpacing: 0.5 }), maxTextW);
    doc.text(upper, cx - w / 2, textY, { width: w, lineBreak: false, characterSpacing: 0.5 });
  }
}

// Header: a single glowing hairline near the top with one centered
// accent dot — no checkerboard (design_1), no plain rule (design_2), no
// double rule + diamond (design_3), no corner brackets (design_4).
function drawHeader(doc, colors, pageWidth) {
  doc.save();
  doc.strokeColor(colors.orange).strokeOpacity(0.22).lineWidth(4);
  doc.moveTo(0, HEADER_LINE_Y).lineTo(pageWidth, HEADER_LINE_Y).stroke();
  doc.strokeOpacity(0.9).lineWidth(1);
  doc.moveTo(0, HEADER_LINE_Y).lineTo(pageWidth, HEADER_LINE_Y).stroke();
  doc.restore();

  doc.save();
  doc.fillColor(colors.orange);
  doc.circle(pageWidth / 2, HEADER_LINE_Y, 2.5).fill();
  doc.restore();
}

const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';
const FOOTER_BADGE_R = 11;

// Footer: hairline, brand text (letter-spaced, gray) on the left, and a
// glowing circular page-number badge on the right — distinct from
// design_4's rounded pill chip, design_1's checkerboard, design_2's
// plain left/right text split, and design_3's centered "BRAND · N" line.
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

  const cx = pageWidth - PAGE_MARGIN - FOOTER_BADGE_R;
  const cy = lineY + FOOTER_ROW_H / 2 + 1;
  doc.save();
  doc.strokeColor(colors.orange).strokeOpacity(0.2).lineWidth(5);
  doc.circle(cx, cy, FOOTER_BADGE_R + 2).stroke();
  doc.restore();
  doc.circle(cx, cy, FOOTER_BADGE_R).fill(colors.orange);
  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(9).fillColor('#0F0B1A');
  doc.text(pageNumText, cx - FOOTER_BADGE_R, cy - 4.5, { width: FOOTER_BADGE_R * 2, align: 'center', lineBreak: false });
}

// Shared "glow" primitive: two wide, low-opacity rounded-rect strokes
// (a soft halo) underneath a crisp full-opacity rounded-rect stroke on
// top — used for the card frame, chapter pill, and table frame so the
// whole design reads as glowing glass/neon rather than design_4's flat
// hard-edged HUD brackets.
function drawGlowFrame(doc, colors, x, y, w, h, r) {
  doc.save();
  doc.strokeColor(colors.orange);
  doc.strokeOpacity(0.09).lineWidth(6);
  doc.roundedRect(x - 3, y - 3, w + 6, h + 6, Math.min(r + 3, (Math.min(w, h) + 6) / 2)).stroke();
  doc.strokeOpacity(0.2).lineWidth(3);
  doc.roundedRect(x - 1.5, y - 1.5, w + 3, h + 3, Math.min(r + 1.5, (Math.min(w, h) + 3) / 2)).stroke();
  doc.restore();

  doc.roundedRect(x, y, w, h, r).fill(CARD_BG);
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.2);
  doc.roundedRect(x, y, w, h, r).stroke();
  doc.restore();
}

// Diamond "gem" badge — a rotated square chip holding the question
// number — replaces design_1's circle, design_2's square, design_3's
// margin watermark numeral, and design_4's pennant tag.
const GEM_SIZE = 24;

function drawBadge(doc, colors, idx, x, y) {
  const cx = x + GEM_SIZE / 2;
  const cy = y + GEM_SIZE / 2;
  const side = GEM_SIZE * 0.62;
  doc.save();
  doc.strokeColor(colors.orange).strokeOpacity(0.25).lineWidth(4);
  doc.translate(cx, cy);
  doc.rotate(45);
  doc.rect(-side / 2 - 2, -side / 2 - 2, side + 4, side + 4).stroke();
  doc.restore();

  doc.save();
  doc.translate(cx, cy);
  doc.rotate(45);
  doc.rect(-side / 2, -side / 2, side, side).fill(colors.orange);
  doc.restore();

  const numText = String(idx + 1).padStart(2, '0');
  doc.font(FONT_HEADING).fontSize(8.5).fillColor('#0F0B1A');
  doc.text(numText, x, cy - 4, { width: GEM_SIZE, align: 'center', lineBreak: false });
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
        drawHeader(doc, colors, pageWidth);
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
          drawChapterHeader(doc, colors, r.chapter, contentX, y, contentWidth);
          y += CHAPTER_HEADER_H + CHAPTER_HEADER_GAP;
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

        ensureSpace(cardHeight + CARD_GAP);

        const cardY = y;
        drawGlowFrame(doc, colors, contentX, cardY, contentWidth, cardHeight, CARD_RADIUS);

        // Diamond "gem" badge in the top-left of the card, in the
        // reserved BADGE_COL_W column.
        drawBadge(doc, colors, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 3);

        // Question — offset past the badge column.
        let curY = cardY + CARD_PADDING;
        drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
        curY += qMeasured.height + 10;

        // Divider — full-width glow line under the text column.
        drawDivider(doc, colors, textColX, curY, textColWidth);
        curY += 12;

        // ANSWER label
        doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orange);
        doc.text('✦ ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
        curY += LABEL_SIZE + 8;

        // Answer body — full card width, not offset by the badge column.
        const answerX = contentX + CARD_PADDING;
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
      });

      drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta.footerBrand);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAnswersPdf };
