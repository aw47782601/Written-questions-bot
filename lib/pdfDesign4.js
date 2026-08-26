// Renders a batch of {question, answer, page} results as a styled PDF in
// a dark "tech / HUD readout" look — the "design_4" template (see
// lib/pdfDesigns.js for the design registry). This is a deliberate, 100%
// visual break from design_1 ("M.E.M design"), design_2 ("Nova design")
// and design_3 ("Atlas design"):
//
//  - It's the only dark design. Page background is near-black navy
//    (PAGE_BG) with slightly-lighter slate cards (CARD_BG) — the exact
//    opposite of design_1's cream page, design_2's white page, and
//    design_3's ivory page. Every other design puts a tint on either the
//    page or the card against a light neutral; this one is dark
//    throughout, so accent colors read as glowing highlights instead of
//    printed ink.
//  - Different font stack from any prior pairing: Comic Neue
//    (regular/bold) for body copy paired with Archivo Black for
//    headings — design_1 pairs Comic Neue with Fredoka, design_2 pairs
//    Archivo Black with Lato, so this specific pairing is new — plus
//    Scheherazade New for Arabic (shared with design_3's font file, but
//    never previously paired with Comic Neue/Archivo Black).
//  - No badge circle (design_1), square (design_2), or margin watermark
//    numeral (design_3): each question gets a right-pointing "pennant
//    tag" polygon badge instead — a small flag-shaped chip.
//  - Cards have square corners with a thin neutral border PLUS four
//    small accent-colored corner brackets that jut slightly outside the
//    card edges, like a HUD/viewfinder frame — none of the prior designs
//    use corner brackets.
//  - The divider under the question is a dashed accent rule flanked by
//    two small bracket ticks "[- - - -]", left-aligned under the text
//    column — distinct from design_1's full-width chevron/diamond,
//    design_2's plain full-width hairline, and design_3's short
//    centered rule-diamond ornament.
//  - Chapter headers are a full-width accent banner with a pointed
//    (arrow/pennant) right edge instead of design_1's plain rounded
//    banner, design_2's left-bar+underline, or design_3's centered
//    rule-flanked title.
//  - The comparison table is a "terminal grid": no header fill, bold
//    accent header text over a thick accent rule, with low-opacity
//    accent gridlines throughout and dark zebra striping — distinct from
//    design_1's orange-filled header, design_2's dark-ink-filled header,
//    and design_3's double-rule/ivory-white striping.
//  - Header/footer use corner-bracket marks and a rounded accent "pill"
//    page-number chip instead of design_1's checkerboard, design_2's
//    single rule + plain text, or design_3's double rule + ornament.
//
// Functionally it keeps full feature parity with design_1/2/3:
// *highlighted* term coloring, comparison tables (Gemini-flagged
// { columns, rows } answers), chapter banners once per new chapter, and
// full Arabic shaping + bidi reordering (mostly-Arabic paragraphs/cells,
// and stray Arabic words/phrases inside an otherwise non-Arabic answer) —
// see lib/pdfGenerator.js's header comment for why the run-grouping
// approach is needed; the same approach is used here unchanged, just
// re-themed and re-fonted.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, hasGreek, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
const { getColorTheme, DEFAULT_PDF_COLOR } = require('./pdfColors');

// --- Fonts -------------------------------------------------------------
const FONT_ARABIC_REGULAR_PATH = path.join(__dirname, '../assets/fonts/ScheherazadeNew-Regular.ttf');
const FONT_ARABIC_BOLD_PATH = path.join(__dirname, '../assets/fonts/ScheherazadeNew-Bold.ttf');
const FONT_ARABIC_REGULAR = 'ScheherazadeNew-Regular';
const FONT_ARABIC_BOLD = 'ScheherazadeNew-Bold';

const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/ComicNeue-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/ComicNeue-Bold.ttf');

// Comic Neue has zero Greek glyph coverage and only patchy coverage of
// arrows/math operators/other symbol blocks (confirmed via font cmap
// inspection), so alpha/beta/gamma-style symbols and arrows/operators
// like → ↑ ↓ ← ± × ÷ ≤ ≥ √ ∞ ∑ in a science/math answer silently drew as
// blank/missing-glyph boxes. Lato has by far the widest coverage of the
// bundled fonts for these ranges, so it's registered purely as a per-word
// fallback — see tokenFont() below and hasGreek()'s definition in
// textShaping.js for exactly which ranges trigger it — without changing
// this design's Comic Neue look for everything else.
const FONT_GREEK_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_GREEK_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_GREEK_REGULAR = 'Lato-Regular';
const FONT_GREEK_BOLD = 'Lato-Bold';
const FONT_REGULAR = 'ComicNeue-Regular';
const FONT_BOLD = 'ComicNeue-Bold';

const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/ArchivoBlack-Regular.ttf');
const FONT_HEADING = 'ArchivoBlack-Regular';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 40;

// Fixed dark "HUD" tones used alongside the accent color. Only the accent
// itself (badge, corner brackets, divider dashes, chapter banner, table
// header/rule, footer pill) comes from the user's chosen colorKey (see
// lib/pdfColors.js) — everything else stays a fixed dark neutral so the
// page reads as a dark console/readout rather than an accent-tinted one.
const NEUTRAL_INK = '#E7EAF0'; // body text on dark cards
const NEUTRAL_GRAY = '#7C8598'; // secondary text: page citation, footer brand
const NEUTRAL_BORDER = '#2A2F3A'; // hairlines / card border / gridlines
const PAGE_BG = '#12151C'; // near-black navy page
const CARD_BG = '#1B2029'; // slightly lighter slate card
const CARD_BG_ALT = '#20263050'.slice(0, 7); // (unused placeholder guard, see TABLE_ROW_ALT below)
const TABLE_ROW_ALT = '#20262F'; // alternate table row shade

// Header: a thin accent rule at the very top plus a hairline further
// down, with small accent corner brackets at both top corners — no
// checkerboard (design_1), no plain single rule (design_2), no double
// rule + diamond ornament (design_3).
const TOP_RULE_H = 2;
const HEADER_GAP_H = 20;
const HEADER_H = TOP_RULE_H + HEADER_GAP_H;
const PAGE_CONTENT_TOP = HEADER_H + 22;

// Footer: hairline + brand text on the left, rounded accent "pill" page
// number chip on the right.
const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 14;

const CARD_PADDING = 18;
const CARD_GAP = 16;
const BADGE_COL_W = 40; // reserved margin for the pennant-tag badge
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
        tokens.push({ text: words[i], shaped: words[i], arabic: false, greek: hasGreek(words[i]), bold });
        i++;
      }
    }
  });
  return tokens;
}

function tokenFont(tok) {
  if (tok.arabic) return tok.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR;
  if (tok.greek) return tok.bold ? FONT_GREEK_BOLD : FONT_GREEK_REGULAR;
  return tok.bold ? FONT_BOLD : FONT_REGULAR;
}

// Question-text tokenizer — same Arabic-run-grouping + Greek/symbol
// fallback as tokenizeHighlighted above, minus the *highlight* markup
// parsing (a question has no bold/plain distinction of its own — the
// whole line is uniformly bold, so every token is marked bold=true).
function tokenizeQuestionWords(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const tokens = [];
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
      tokens.push({ text: joined, shaped: shapeArabicLine(joined), arabic: true, bold: true });
      i = j;
    } else {
      tokens.push({ text: words[i], shaped: words[i], arabic: false, greek: hasGreek(words[i]), bold: true });
      i++;
    }
  }
  return tokens;
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
// contrast instead of standing out, the opposite of the light-page
// designs where a darkened accent is what pops against a pale card.
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
  // Per-word Arabic-run/Greek-symbol fallback (see tokenizeQuestionWords)
  // instead of a single flat doc.text(FONT_BOLD) call, so α β γ / → ± ×
  // ÷ etc. inside a question no longer draw as a blank missing-glyph box.
  const tokens = tokenizeQuestionWords(question);
  const lines = wrapTokens(doc, tokens, QUESTION_SIZE, width);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_Q };
}

function drawQuestion(doc, colors, measured, question, x, y, width) {
  if (measured.arabic) {
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, colors.orange);
  } else {
    drawTokenLines(doc, colors, measured.lines, x, y, QUESTION_SIZE, LINE_HEIGHT_Q);
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
// Comparison tables — "terminal grid" styling: no filled header band,
// bold accent header text over a thick accent rule, low-opacity accent
// gridlines, dark zebra striping (CARD_BG / TABLE_ROW_ALT).
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;
const TABLE_HEADER_GAP = 3;

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

  // No filled header band — bold accent text sits directly on the card,
  // separated from the body by a thick accent rule + thin neutral rule
  // (the opposite of design_1/design_2's filled header bands, and a
  // single thick rule rather than design_3's thick+thin double rule).
  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, colors, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.75);
  doc.moveTo(x, y + headerHeight).lineTo(x + width, y + headerHeight).stroke();
  doc.restore();

  let ry = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x, ry, width, row.height).fill(ridx % 2 === 0 ? CARD_BG : TABLE_ROW_ALT);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, colors, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    ry += row.height;
  });

  // Low-opacity accent gridlines throughout — a "terminal grid" look
  // instead of neutral-gray gridlines.
  doc.save();
  doc.strokeColor(colors.orange).strokeOpacity(0.35).lineWidth(0.75);
  doc.rect(x, y, width, measured.height).stroke();
  let gx = x;
  colWidths.forEach((w, i) => {
    gx += w;
    if (i < colWidths.length - 1) doc.moveTo(gx, y + headerHeight + TABLE_HEADER_GAP).lineTo(gx, y + measured.height).stroke();
  });
  let gy = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row) => {
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
    gy += row.height;
  });
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

// Divider — a dashed accent rule flanked by two small bracket ticks,
// "[- - - -]", left-aligned under the text column (not full-width like
// design_1/design_2, not short-and-centered like design_3).
const DIVIDER_W = 130;
const DIVIDER_DASH_W = 6;
const DIVIDER_DASH_GAP = 4;
const DIVIDER_TICK = 4;

function drawDivider(doc, colors, x, y, width) {
  const totalW = Math.min(DIVIDER_W, width);
  const startX = x;
  const endX = x + totalW;

  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.moveTo(startX, y - DIVIDER_TICK).lineTo(startX, y + DIVIDER_TICK).stroke();
  doc.moveTo(startX, y - DIVIDER_TICK).lineTo(startX + DIVIDER_TICK, y - DIVIDER_TICK).stroke();
  doc.moveTo(startX, y + DIVIDER_TICK).lineTo(startX + DIVIDER_TICK, y + DIVIDER_TICK).stroke();
  doc.moveTo(endX, y - DIVIDER_TICK).lineTo(endX, y + DIVIDER_TICK).stroke();
  doc.moveTo(endX, y - DIVIDER_TICK).lineTo(endX - DIVIDER_TICK, y - DIVIDER_TICK).stroke();
  doc.moveTo(endX, y + DIVIDER_TICK).lineTo(endX - DIVIDER_TICK, y + DIVIDER_TICK).stroke();
  doc.restore();

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.5);
  let dx = startX + 8;
  const dashEnd = endX - 8;
  while (dx < dashEnd) {
    const segEnd = Math.min(dx + DIVIDER_DASH_W, dashEnd);
    doc.moveTo(dx, y).lineTo(segEnd, y).stroke();
    dx = segEnd + DIVIDER_DASH_GAP;
  }
  doc.restore();
}

// Chapter header — a full-width accent banner with a pointed
// (arrow/pennant) right edge, bold uppercase white title near the left,
// like a section tab — instead of design_1's plain rounded banner,
// design_2's left-bar+underline, or design_3's centered rule-flanked
// title.
//
// Used to be a fixed CHAPTER_HEADER_H (40): the English branch clamped
// to one line via lineBreak: false (long titles got clipped by the
// pennant shape), and the Arabic branch clamped the *measured width*
// with Math.min but still passed the full (unclamped) shaped string to
// doc.text with that narrowed width, which let it wrap unpredictably
// against a banner that never grew to match. measureChapterHeader() now
// wraps the title onto as many lines as it needs and returns the
// resulting height; the pennant polygon is drawn at that height instead
// of the old constant.
const CHAPTER_HEADER_SIZE = 15;
const CHAPTER_HEADER_LINE_H = 18;
const CHAPTER_HEADER_PAD_Y = 11;
const CHAPTER_HEADER_GAP = 16;
const CHAPTER_ARROW_W = 20;

function measureChapterHeader(doc, chapterText, pageContentWidth) {
  const maxTextW = Math.max(10, pageContentWidth - CHAPTER_ARROW_W - 30);
  const arabic = isMostlyArabic(chapterText);
  const font = arabic ? FONT_ARABIC_BOLD : FONT_HEADING;
  const size = arabic ? CHAPTER_HEADER_SIZE : CHAPTER_HEADER_SIZE - 1;
  const raw = arabic ? String(chapterText || '') : String(chapterText || '').toUpperCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const opts = arabic ? {} : { characterSpacing: 0.5 };
  const lines = wrapWordsByWidth(doc, words, font, size, maxTextW, opts);
  const shapedLines = arabic ? lines.map((l) => shapeArabicLine(l)) : lines;
  const textHeight = Math.max(lines.length, 1) * CHAPTER_HEADER_LINE_H;
  const height = Math.max(textHeight + CHAPTER_HEADER_PAD_Y * 2, CHAPTER_ARROW_W * 2 + 4);
  return { arabic, lines: shapedLines, maxTextW, height };
}

function drawChapterHeader(doc, colors, measured, x, y, width) {
  const { arabic, lines, maxTextW, height } = measured;
  doc.save();
  doc.polygon(
    [x, y],
    [x + width - CHAPTER_ARROW_W, y],
    [x + width, y + height / 2],
    [x + width - CHAPTER_ARROW_W, y + height],
    [x, y + height]
  ).fill(colors.orange);
  doc.restore();

  const textX = x + 16;
  const textStartY = y + (height - Math.max(lines.length, 1) * CHAPTER_HEADER_LINE_H) / 2;
  const size = arabic ? CHAPTER_HEADER_SIZE : CHAPTER_HEADER_SIZE - 1;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(size).fillColor('#0D0F14');
  lines.forEach((line, i) => {
    const lineY = textStartY + i * CHAPTER_HEADER_LINE_H;
    if (arabic) {
      const w = Math.min(doc.widthOfString(line), maxTextW);
      doc.text(line, x + width - CHAPTER_ARROW_W - 16 - w, lineY, { width: w, lineBreak: false });
    } else {
      doc.text(line, textX, lineY, { width: maxTextW, lineBreak: false, characterSpacing: 0.5 });
    }
  });
}

// Header: thin accent rule at the very top + a hairline further down,
// with small accent corner brackets at both top corners of the content
// area — a "HUD frame" opening instead of design_1's checkerboard,
// design_2's single solid rule, or design_3's double rule + diamond.
function drawHeader(doc, colors, pageWidth) {
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(TOP_RULE_H);
  doc.moveTo(0, TOP_RULE_H / 2).lineTo(pageWidth, TOP_RULE_H / 2).stroke();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(0, HEADER_H).lineTo(pageWidth, HEADER_H).stroke();
  doc.restore();

  const bw = 14;
  const bh = 8;
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.5);
  doc.moveTo(PAGE_MARGIN - 6, HEADER_H - 1).lineTo(PAGE_MARGIN - 6, HEADER_H - 1 - bh).lineTo(PAGE_MARGIN - 6 + bw, HEADER_H - 1 - bh).stroke();
  doc.moveTo(pageWidth - PAGE_MARGIN + 6, HEADER_H - 1).lineTo(pageWidth - PAGE_MARGIN + 6, HEADER_H - 1 - bh).lineTo(pageWidth - PAGE_MARGIN + 6 - bw, HEADER_H - 1 - bh).stroke();
  doc.restore();
}

const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';

// Footer: hairline, brand text (letter-spaced, gray) on the left, and a
// rounded accent "pill" chip holding the page number on the right —
// distinct from design_1's checkerboard, design_2's plain left/right
// text split, and design_3's centered "BRAND · N" line.
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

  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(10);
  const numW = doc.widthOfString(pageNumText);
  const pillW = numW + 22;
  const pillH = 20;
  const pillX = pageWidth - PAGE_MARGIN - pillW;
  const pillY = lineY + (FOOTER_ROW_H - pillH) / 2 + 2;
  doc.roundedRect(pillX, pillY, pillW, pillH, pillH / 2).fill(colors.orange);
  doc.fillColor('#0D0F14');
  doc.text(pageNumText, pillX, pillY + (pillH - 10) / 2, { width: pillW, align: 'center', lineBreak: false });
}

// Card frame: square-cornered dark card with a thin neutral border plus
// four small accent-colored corner brackets that jut slightly outside
// the card edges — a HUD/viewfinder frame, unlike design_1's rounded
// cream card, design_2's flat white card + left accent bar, or
// design_3's ivory card in a thin+hairline double-rule frame.
const CORNER_BRACKET_LEN = 10;

function drawCardFrame(doc, colors, x, y, w, h) {
  doc.rect(x, y, w, h).fill(CARD_BG);
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(1);
  doc.rect(x, y, w, h).stroke();
  doc.restore();

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.5);
  const cl = CORNER_BRACKET_LEN;
  // top-left
  doc.moveTo(x - 2, y + cl).lineTo(x - 2, y - 2).lineTo(x + cl, y - 2).stroke();
  // top-right
  doc.moveTo(x + w - cl, y - 2).lineTo(x + w + 2, y - 2).lineTo(x + w + 2, y + cl).stroke();
  // bottom-left
  doc.moveTo(x - 2, y + h - cl).lineTo(x - 2, y + h + 2).lineTo(x + cl, y + h + 2).stroke();
  // bottom-right
  doc.moveTo(x + w - cl, y + h + 2).lineTo(x + w + 2, y + h + 2).lineTo(x + w + 2, y + h - cl).stroke();
  doc.restore();
}

// Pennant-tag badge: a small right-pointing flag shape holding the
// question number — replaces design_1's circle, design_2's square, and
// design_3's margin watermark numeral.
const TAG_W = 32;
const TAG_H = 20;
const TAG_NOTCH = 7;

function drawBadge(doc, colors, idx, x, y) {
  doc.save();
  doc.polygon(
    [x, y],
    [x + TAG_W - TAG_NOTCH, y],
    [x + TAG_W, y + TAG_H / 2],
    [x + TAG_W - TAG_NOTCH, y + TAG_H],
    [x, y + TAG_H]
  ).fill(colors.orange);
  doc.restore();
  const numText = String(idx + 1).padStart(2, '0');
  doc.font(FONT_HEADING).fontSize(10).fillColor('#0D0F14');
  doc.text(numText, x, y + (TAG_H - 10) / 2, { width: TAG_W - TAG_NOTCH, align: 'center', lineBreak: false });
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
      doc.registerFont(FONT_GREEK_REGULAR, FONT_GREEK_REGULAR_PATH);
      doc.registerFont(FONT_GREEK_BOLD, FONT_GREEK_BOLD_PATH);
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
          const chMeasured = measureChapterHeader(doc, r.chapter, contentWidth);
          drawChapterHeader(doc, colors, chMeasured, contentX, y, contentWidth);
          y += chMeasured.height + CHAPTER_HEADER_GAP;
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

          // Pennant-tag badge in the top-left of the card, in the
          // reserved BADGE_COL_W column.
          drawBadge(doc, colors, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 2);

          // Question — offset past the badge column.
          let curY = cardY + CARD_PADDING;
          drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
          curY += qMeasured.height + 10;

          // Divider — dashed accent rule under the text column.
          drawDivider(doc, colors, textColX, curY, textColWidth);
          curY += 12;

          // ANSWER label
          doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orange);
          doc.text('▸ ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
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
            drawCardFrame(doc, colors, contentX, cardY, contentWidth, firstPartHeight);
            drawBadge(doc, colors, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 2);

            let curY = cardY + CARD_PADDING;
            drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
            curY += qMeasured.height + 10;

            drawDivider(doc, colors, textColX, curY, textColWidth);
            curY += 12;

            doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orange);
            doc.text('▸ ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
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
            drawCardFrame(doc, colors, contentX, cardY2, contentWidth, secondPartHeight);

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
