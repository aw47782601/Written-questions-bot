// Renders a batch of {question, answer, page} results as a styled PDF in
// a flat, modern/editorial look — the "design_2" template (see
// lib/pdfDesigns.js for the design registry). This is a deliberate, 100%
// visual break from design_1 (lib/pdfGenerator.js, "M.E.M design"):
//
//  - Different font stack throughout: Lato (regular/bold) for body copy
//    instead of Comic Neue, ArchivoBlack for headings/chapter
//    titles/footer brand instead of Fredoka, and Tajawal (regular/bold)
//    for Arabic instead of Noto Naskh Arabic — a plain modern Arabic UI
//    face instead of a traditional naskh calligraphic one.
//  - No checkerboard header/footer band — a thin solid accent rule up
//    top and a hairline + plain text footer instead.
//  - Cards are flat white rectangles with a colored left accent bar and
//    a square (not circular) numbered badge, instead of rounded cream
//    cards with a circle badge.
//  - The divider under the question is a plain thin rule, not the
//    "o——◆——o" chevron/diamond divider.
//  - Chapter headers are a left-accent-bar + underlined heading, not a
//    solid colored banner.
//  - The comparison table uses a dark header row + neutral gray/white
//    zebra striping instead of the orange header + cream/white striping.
//
// Functionally it keeps full feature parity with design_1: *highlighted*
// term coloring, comparison tables (Gemini-flagged { columns, rows }
// answers), chapter banners once per new chapter, and full Arabic
// shaping + bidi reordering (mostly-Arabic paragraphs/cells, and stray
// Arabic words/phrases inside an otherwise non-Arabic answer) — see
// lib/pdfGenerator.js's header comment for why the run-grouping approach
// is needed; the same approach is used here unchanged, just re-themed.
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

const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/ArchivoBlack-Regular.ttf');
const FONT_HEADING = 'ArchivoBlack-Regular';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 40;

// Fixed neutral tones used alongside the accent color, so the design
// reads as "flat modern report" rather than a warm accent-tinted look
// like design_1's cream cards — only the accent color itself (badge,
// left bar, header rule, chapter title, table header) comes from the
// user's chosen colorKey (see lib/pdfColors.js).
const NEUTRAL_INK = '#1F2430';
const NEUTRAL_GRAY = '#6B7280';
const NEUTRAL_LIGHT = '#F3F4F6';
const NEUTRAL_BORDER = '#E5E7EB';
const NEUTRAL_WHITE = '#FFFFFF';

// Header: a thin solid accent rule at the very top, then a hairline a
// little further down — no title/book-name text, no checkerboard. Kept
// deliberately content-free (like design_1's checkerboard band, which
// also carries no title) so nothing book-identifying ever shows up here
// regardless of what a caller passes in meta.
const TOP_RULE_H = 6;
const HEADER_GAP_H = 18; // breathing room between the rule and the hairline
const HEADER_H = TOP_RULE_H + HEADER_GAP_H;
const PAGE_CONTENT_TOP = HEADER_H + 20;

// Footer: hairline + one row of plain text.
const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 14;

const CARD_PADDING = 16;
const CARD_GAP = 14;
const CARD_ACCENT_BAR_W = 5;
const BADGE_SIZE = 24;
const BADGE_COL_W = 38;
const QUESTION_SIZE = 15;
const LABEL_SIZE = 10;
const ANSWER_SIZE = 13.5;
const LINE_HEIGHT_Q = 18;
const LINE_HEIGHT_A = 17.5;

// ---------------------------------------------------------------------
// Small text-measuring/drawing helpers (functionally identical to
// design_1's — see lib/pdfGenerator.js for the detailed rationale on
// Arabic run-grouping — just wired to this file's own font constants).
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

function drawTokenLines(doc, colors, lines, x, y, size, lineHeight) {
  lines.forEach((line, i) => {
    let cx = x;
    const ly = y + i * lineHeight;
    line.forEach((tok) => {
      doc.font(tokenFont(tok)).fontSize(size);
      const spaceWidth = doc.widthOfString(' ');
      doc.fillColor(tok.bold ? colors.orangeDark : NEUTRAL_INK);
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
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, colors.orangeDark);
  } else {
    doc.font(FONT_BOLD).fontSize(QUESTION_SIZE).fillColor(colors.orangeDark);
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
      if (b.bullet) doc.rect(x + width - 8, cy + 4, 4, 4).fill(colors.orangeDark);
    } else {
      drawTokenLines(doc, colors, b.lines, b.bullet ? x + BULLET_INDENT : x, cy, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.rect(x, cy + 4, 4, 4).fill(colors.orangeDark);
    }
    cy += b.height + PARA_GAP;
  });
}

// ---------------------------------------------------------------------
// Comparison tables — dark header row + neutral gray/white zebra
// striping, instead of design_1's orange header + cream/white striping.
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;

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
      doc.font(r.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR).fontSize(size).fillColor(r.bold ? colors.orangeDark : NEUTRAL_INK);
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
  const height = headerHeight + bodyRows.reduce((s, r) => s + r.height, 0);
  return { colWidths, headerCells, headerHeight, bodyRows, height };
}

function drawHeaderCellText(doc, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, NEUTRAL_WHITE);
  } else {
    doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor(NEUTRAL_WHITE);
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
        doc.fillColor(tok.bold ? colors.orangeDark : NEUTRAL_INK);
        doc.text(tok.shaped, cx, ly, { lineBreak: false });
        cx += doc.widthOfString(tok.shaped) + spaceWidth;
      });
    });
  }
}

function drawComparisonTable(doc, colors, measured, x, y, width) {
  const { colWidths, headerCells, headerHeight, bodyRows } = measured;

  // Dark ink header row (not the accent color itself) so the table reads
  // as a distinct, more "data report" block rather than design_1's
  // accent-colored header — the accent still shows up via the outer
  // border and via highlighted-term coloring inside cells.
  doc.rect(x, y, width, headerHeight).fill(NEUTRAL_INK);
  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  let ry = y + headerHeight;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x, ry, width, row.height).fill(ridx % 2 === 0 ? NEUTRAL_WHITE : NEUTRAL_LIGHT);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, colors, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    ry += row.height;
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.2);
  doc.rect(x, y, width, measured.height).stroke();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  let gx = x;
  colWidths.forEach((w, i) => {
    gx += w;
    if (i < colWidths.length - 1) doc.moveTo(gx, y + headerHeight).lineTo(gx, y + measured.height).stroke();
  });
  let gy = y + headerHeight;
  bodyRows.forEach((row) => {
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
    gy += row.height;
  });
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

// Plain thin rule under the question — a deliberate departure from
// design_1's "o——◆——o" chevron/diamond divider.
function drawDivider(doc, x, y, width) {
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(x, y).lineTo(x + width, y).stroke();
  doc.restore();
}

// Chapter header — a left accent bar + bold uppercase title + a thin
// accent-colored underline, instead of design_1's solid banner card.
const CHAPTER_HEADER_SIZE = 14;
const CHAPTER_HEADER_H = 34;
const CHAPTER_HEADER_GAP = 14;
const CHAPTER_BAR_W = 4;

function drawChapterHeader(doc, colors, chapterText, x, y, width) {
  doc.rect(x, y, CHAPTER_BAR_W, CHAPTER_HEADER_H).fill(colors.orange);
  const textX = x + CHAPTER_BAR_W + 10;
  const textWidth = width - CHAPTER_BAR_W - 10;
  const textY = y + (CHAPTER_HEADER_H - CHAPTER_HEADER_SIZE) / 2 - 6;
  if (isMostlyArabic(chapterText)) {
    const shaped = shapeArabicLine(chapterText);
    doc.font(FONT_ARABIC_BOLD).fontSize(CHAPTER_HEADER_SIZE).fillColor(NEUTRAL_INK);
    const w = doc.widthOfString(shaped);
    doc.text(shaped, textX + Math.max(0, textWidth - w), textY, { lineBreak: false, characterSpacing: 0.5 });
  } else {
    doc.font(FONT_HEADING).fontSize(CHAPTER_HEADER_SIZE).fillColor(NEUTRAL_INK);
    doc.text(chapterText.toUpperCase(), textX, textY, { width: textWidth, lineBreak: false, characterSpacing: 0.5 });
  }
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.5);
  doc.moveTo(x, y + CHAPTER_HEADER_H - 2).lineTo(x + width, y + CHAPTER_HEADER_H - 2).stroke();
  doc.restore();
}

// Header: thin solid accent rule at the very top, then a hairline —
// no title, no book name, no checkerboard, no icon.
function drawHeader(doc, colors, pageWidth) {
  doc.rect(0, 0, pageWidth, TOP_RULE_H).fill(colors.orange);
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(0, HEADER_H).lineTo(pageWidth, HEADER_H).stroke();
  doc.restore();
}

const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';

// Footer: hairline above a plain text row — brand text left, page
// number right, no checkerboard/watermark.
function drawFooter(doc, colors, pageNum, pageWidth, pageHeight, brand) {
  const lineY = pageHeight - FOOTER_H;
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(0, lineY).lineTo(pageWidth, lineY).stroke();
  doc.restore();

  const rowY = lineY + (FOOTER_ROW_H - 10) / 2 + 2;
  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();
  doc.font(FONT_REGULAR).fontSize(9).fillColor(NEUTRAL_GRAY);
  doc.text(brandText, PAGE_MARGIN, rowY, { characterSpacing: 1, lineBreak: false });

  const pageNumText = String(pageNum);
  doc.font(FONT_BOLD).fontSize(10).fillColor(colors.orangeDark);
  const w = doc.widthOfString(pageNumText);
  doc.text(pageNumText, pageWidth - PAGE_MARGIN - w, rowY, { lineBreak: false });
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

        const textColX = contentX + CARD_ACCENT_BAR_W + CARD_PADDING + BADGE_COL_W;
        const textColWidth = contentWidth - CARD_ACCENT_BAR_W - CARD_PADDING * 2 - BADGE_COL_W;

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        const aBody = measureAnswerBody(doc, r, contentWidth - CARD_ACCENT_BAR_W - CARD_PADDING * 2);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const innerHeight =
          qMeasured.height +
          8 + // divider gap
          6 + // gap before ANSWER label
          LABEL_SIZE +
          6 +
          aBody.height +
          (pageNoteText ? 16 : 0);
        const cardHeight = innerHeight + CARD_PADDING * 2 + 6;

        ensureSpace(cardHeight + CARD_GAP);

        const cardY = y;
        // Flat white card, thin neutral border, no rounding — plus the
        // colored left accent bar that replaces design_1's filled cream
        // background as the "this is one card" visual cue.
        doc.rect(contentX, cardY, contentWidth, cardHeight).fillAndStroke(NEUTRAL_WHITE, NEUTRAL_BORDER);
        doc.rect(contentX, cardY, CARD_ACCENT_BAR_W, cardHeight).fill(colors.orange);

        // Square numbered badge (not a circle)
        const badgeX = contentX + CARD_ACCENT_BAR_W + CARD_PADDING;
        const badgeY = cardY + CARD_PADDING;
        doc.roundedRect(badgeX, badgeY, BADGE_SIZE, BADGE_SIZE, 4).fill(colors.orangeDark);
        doc.font(FONT_BOLD).fontSize(12).fillColor(NEUTRAL_WHITE);
        doc.text(String(idx + 1), badgeX, badgeY + (BADGE_SIZE - 12) / 2 - 1, { width: BADGE_SIZE, align: 'center' });

        // Question
        let curY = cardY + CARD_PADDING;
        drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
        curY += qMeasured.height + 8;

        // Divider — starts after the badge column, same reasoning as
        // design_1 (never cuts through the badge).
        drawDivider(doc, textColX, curY, textColWidth);
        curY += 10;

        // ANSWER label — small uppercase, letter-spaced, accent-dark.
        doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orangeDark);
        doc.text('ANSWER', contentX + CARD_ACCENT_BAR_W + CARD_PADDING, curY, { lineBreak: false, characterSpacing: 1 });
        curY += LABEL_SIZE + 6;

        // Answer body
        drawAnswerBody(doc, colors, aBody, contentX + CARD_ACCENT_BAR_W + CARD_PADDING, curY, contentWidth - CARD_ACCENT_BAR_W - CARD_PADDING * 2);
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
