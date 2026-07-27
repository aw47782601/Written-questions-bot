// Renders a batch of {question, answer, page} results as a styled PDF in
// a classic editorial/book-plate look — the "design_3" template (see
// lib/pdfDesigns.js for the design registry). This is a deliberate, 100%
// visual break from BOTH design_1 (lib/pdfGenerator.js, "M.E.M design",
// playful checkerboard/cream-card look) and design_2 (lib/pdfDesign2.js,
// "Nova design", flat modern left-accent-bar look):
//
//  - Entirely different font stack, shared with neither prior design:
//    Spectral (regular/bold) for body copy instead of Comic Neue/Lato,
//    Abril Fatface — a dramatic high-contrast display serif — for
//    headings/chapter titles/footer brand instead of Fredoka/ArchivoBlack,
//    and Scheherazade New (regular/bold) for Arabic instead of Noto Naskh
//    Arabic/Tajawal — a classical scribal naskh face with its own distinct
//    letterforms rather than a plain modern Arabic UI face.
//  - Warm ivory "paper" page background with pure-white cards framed in a
//    thin+hairline double rule (a book-plate frame), instead of design_1's
//    plain page + cream card or design_2's plain white page + light-gray
//    card — i.e. here it's the *page* that carries the tint and the card
//    that's whiter, the opposite relationship from design_2.
//  - No badge circle or square: each question gets a large, low-opacity
//    "watermark" numeral set in Abril Fatface in the margin, like a
//    classical book's exercise numbering, instead of a solid numbered
//    badge.
//  - The divider under the question is a short, centered ornamental
//    rule-dot-rule (flanking a small accent diamond), not full-width —
//    distinct from design_1's full-width chevron/diamond divider and
//    design_2's full-width plain hairline.
//  - Chapter headers are a centered, small-caps-style title flanked by
//    full-width rules above and below with a small accent ornament
//    between title and rule, like a book's chapter title page — not
//    design_1's solid banner nor design_2's left-bar+underline.
//  - The comparison table has no filled header band at all: bold accent
//    serif header text sits over a double rule (thick+thin), with ivory/
//    white zebra striping — distinct from design_1's orange-filled header
//    and design_2's dark-ink-filled header.
//  - Header/footer are a thin double rule with a small centered accent
//    ornament, and a centered "BRAND · N" footer line — distinct from
//    design_1's checkerboard bands and design_2's single accent rule +
//    left/right footer text.
//
// Functionally it keeps full feature parity with design_1/design_2:
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

const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Spectral-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/Spectral-Bold.ttf');
const FONT_REGULAR = 'Spectral-Regular';
const FONT_BOLD = 'Spectral-Bold';

// Spectral has almost no Greek glyph coverage and only patchy coverage of
// arrows/math operators/other symbol blocks (confirmed via font cmap
// inspection), so alpha/beta/gamma-style symbols and arrows/operators
// like → ↑ ↓ ← ± × ÷ ≤ ≥ √ ∞ ∑ in a science/math answer silently drew as
// blank/missing-glyph boxes. Lato has by far the widest coverage of the
// bundled fonts for these ranges, so it's registered purely as a per-word
// fallback — see tokenFont() below and hasGreek()'s definition in
// textShaping.js for exactly which ranges trigger it — without changing
// this design's Spectral look for everything else.
const FONT_GREEK_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_GREEK_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_GREEK_REGULAR = 'Lato-Regular';
const FONT_GREEK_BOLD = 'Lato-Bold';

const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/AbrilFatface-Regular.ttf');
const FONT_HEADING = 'AbrilFatface-Regular';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 42;

// Fixed warm "paper" tones used alongside the accent color, so the design
// reads as a classic printed book plate rather than either design_1's
// accent-tinted cream cards or design_2's cool neutral-gray flat-report
// look — only the accent color itself (numeral watermark, ornaments,
// rules, chapter title, table header text) comes from the user's chosen
// colorKey (see lib/pdfColors.js).
const NEUTRAL_INK = '#2B241C';
const NEUTRAL_GRAY = '#847A6B';
const NEUTRAL_BORDER = '#D9CFBD';
const NEUTRAL_WHITE = '#FFFFFF';
// The page itself carries the tint (warm ivory paper); cards sit on top
// in a whiter tone — the opposite fill relationship from design_2, where
// the page is plain white and the card carries the tint.
const PAGE_BG = '#FBF7EF';
const CARD_BG = '#FFFDF8';

// Header: a thin double rule (rule / gap / hairline) with a small accent
// diamond ornament centered between them — no title/book-name text, no
// checkerboard, no single solid accent bar. Kept deliberately content-free
// so nothing book-identifying ever shows up here regardless of what a
// caller passes in meta.
const TOP_RULE_H = 2;
const HEADER_GAP_H = 20; // breathing room between the two rules
const HEADER_H = TOP_RULE_H + HEADER_GAP_H;
const PAGE_CONTENT_TOP = HEADER_H + 22;

// Footer: hairline above a single centered "BRAND · N" line.
const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 14;

const CARD_PADDING = 18;
const CARD_GAP = 16;
const BADGE_COL_W = 40; // reserved margin for the watermark numeral
const QUESTION_SIZE = 15;
const LABEL_SIZE = 9.5;
const ANSWER_SIZE = 13.5;
const LINE_HEIGHT_Q = 19;
const LINE_HEIGHT_A = 18.5;

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
// Gap between the header's thick+thin double rule and the first body row.
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
  const height = headerHeight + TABLE_HEADER_GAP + bodyRows.reduce((s, r) => s + r.height, 0);
  return { colWidths, headerCells, headerHeight, bodyRows, height };
}

function drawHeaderCellText(doc, colors, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, colors.orangeDark);
  } else {
    doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor(colors.orangeDark);
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

  // No filled header band at all — bold accent serif text sits directly
  // on the card, separated from the body by a thick+thin double rule.
  // This is the deliberate opposite of design_1's orange-filled header
  // and design_2's dark-ink-filled header.
  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, colors, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1.5);
  doc.moveTo(x, y + headerHeight).lineTo(x + width, y + headerHeight).stroke();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(x, y + headerHeight + TABLE_HEADER_GAP).lineTo(x + width, y + headerHeight + TABLE_HEADER_GAP).stroke();
  doc.restore();

  let ry = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x, ry, width, row.height).fill(ridx % 2 === 0 ? CARD_BG : PAGE_BG);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, colors, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    ry += row.height;
  });

  doc.save();
  doc.strokeColor(colors.orange).lineWidth(1).rect(x, y, width, measured.height).stroke();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
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

// Short, CENTERED rule–diamond–rule ornament under the question — unlike
// design_1's full-width chevron/diamond divider or design_2's full-width
// plain hairline, this one is a fixed short width and sits in the middle
// of the column, book-plate style.
const DIVIDER_SEG_W = 46;
const DIVIDER_GAP_W = 10;
const DIVIDER_DIAMOND = 3.5;

function drawDivider(doc, x, y, width) {
  const cx = x + width / 2;
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(cx - DIVIDER_GAP_W / 2 - DIVIDER_SEG_W, y).lineTo(cx - DIVIDER_GAP_W / 2, y).stroke();
  doc.moveTo(cx + DIVIDER_GAP_W / 2, y).lineTo(cx + DIVIDER_GAP_W / 2 + DIVIDER_SEG_W, y).stroke();
  doc.restore();
  doc.save();
  doc.translate(cx, y);
  doc.rotate(45);
  doc.rect(-DIVIDER_DIAMOND / 2, -DIVIDER_DIAMOND / 2, DIVIDER_DIAMOND, DIVIDER_DIAMOND).fill(NEUTRAL_BORDER);
  doc.restore();
}

// Chapter header — a book "chapter title page" treatment: a full-width
// hairline, a small accent diamond ornament, the centered title in the
// display serif, and a second full-width hairline below — instead of
// design_1's solid banner card or design_2's left-bar + underline.
//
// Used to be a fixed CHAPTER_HEADER_H (46) sized for one line, with each
// line's "cut the rule open behind the text" white box measured only for
// that single line's width — so a long title either got clipped
// (lineBreak: false) or, worse, its white backing box was too narrow the
// moment it needed to wrap, letting the hairline show through the text.
// measureChapterHeader() now wraps the title onto as many centered lines
// as it needs; the bottom rule (and the per-line white backing boxes) are
// then positioned to match that line count instead of the old constant.
const CHAPTER_HEADER_SIZE = 16;
const CHAPTER_HEADER_LINE_H = 20;
const CHAPTER_HEADER_TOP_PAD = 6; // y -> top rule
const CHAPTER_HEADER_TEXT_PAD = 8; // top rule -> first text line, and last text line -> bottom rule
const CHAPTER_HEADER_BOTTOM_PAD = 6; // bottom rule -> end of header block
const CHAPTER_HEADER_GAP = 16;

function measureChapterHeader(doc, chapterText, pageContentWidth) {
  const maxTextW = Math.max(10, pageContentWidth - 40); // keep clear of the page edges when centered
  const arabic = isMostlyArabic(chapterText);
  const font = arabic ? FONT_ARABIC_BOLD : FONT_HEADING;
  const raw = arabic ? String(chapterText || '') : String(chapterText || '').toUpperCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const opts = arabic ? {} : { characterSpacing: 1 };
  const lines = wrapWordsByWidth(doc, words, font, CHAPTER_HEADER_SIZE, maxTextW, opts);
  const shapedLines = arabic ? lines.map((l) => shapeArabicLine(l)) : lines;
  const textHeight = Math.max(lines.length, 1) * CHAPTER_HEADER_LINE_H;
  const height =
    CHAPTER_HEADER_TOP_PAD + CHAPTER_HEADER_TEXT_PAD * 2 + textHeight + CHAPTER_HEADER_BOTTOM_PAD;
  return { arabic, lines: shapedLines, textHeight, height };
}

function drawChapterHeader(doc, colors, measured, x, y, width) {
  const { arabic, lines, textHeight, height } = measured;
  const topRuleY = y + CHAPTER_HEADER_TOP_PAD;
  const bottomRuleY = y + height - CHAPTER_HEADER_BOTTOM_PAD;
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(x, topRuleY).lineTo(x + width, topRuleY).stroke();
  doc.moveTo(x, bottomRuleY).lineTo(x + width, bottomRuleY).stroke();
  doc.restore();

  // Small accent diamond centered on the top rule, breaking it — an
  // ornamental flourish rather than a solid colored bar.
  const cx = x + width / 2;
  doc.save();
  doc.rect(cx - 12, topRuleY - 4, 24, 8).fill(PAGE_BG);
  doc.translate(cx, topRuleY);
  doc.rotate(45);
  doc.rect(-3, -3, 6, 6).fill(colors.orange);
  doc.restore();

  const textStartY = topRuleY + CHAPTER_HEADER_TEXT_PAD;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(CHAPTER_HEADER_SIZE).fillColor(colors.orangeDark);
  lines.forEach((line, i) => {
    const lineY = textStartY + i * CHAPTER_HEADER_LINE_H;
    const opts = arabic ? { lineBreak: false } : { lineBreak: false, characterSpacing: 1 };
    const w = doc.widthOfString(line, arabic ? {} : { characterSpacing: 1 });
    // Cut the hairline open behind this line only (not the full text
    // block height), so a short second line in an otherwise-wide title
    // doesn't leave an oversized white gap in the rule.
    doc.rect(cx - w / 2 - 8, lineY - 2, w + 16, CHAPTER_HEADER_SIZE + 4).fill(PAGE_BG);
    doc.fillColor(colors.orangeDark);
    doc.text(line, cx - w / 2, lineY, opts);
  });
}

// Header: a thin accent hairline right at the top edge, then a second
// neutral hairline a little further down with a small accent diamond
// centered on it — a double-rule book-plate treatment, not design_1's
// checkerboard nor design_2's single solid accent bar.
function drawHeader(doc, colors, pageWidth) {
  doc.save();
  doc.strokeColor(colors.orange).lineWidth(TOP_RULE_H);
  doc.moveTo(0, TOP_RULE_H / 2).lineTo(pageWidth, TOP_RULE_H / 2).stroke();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(0, HEADER_H).lineTo(pageWidth, HEADER_H).stroke();
  doc.restore();

  const cx = pageWidth / 2;
  doc.save();
  doc.rect(cx - 10, HEADER_H - 4, 20, 8).fill(PAGE_BG);
  doc.translate(cx, HEADER_H);
  doc.rotate(45);
  doc.rect(-3, -3, 6, 6).fill(colors.orange);
  doc.restore();
}

const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';

// Footer: a hairline above a single CENTERED "BRAND · N" line — a
// classic printed-book folio line, not design_1's checkerboard nor
// design_2's left-brand/right-page-number split layout.
function drawFooter(doc, colors, pageNum, pageWidth, pageHeight, brand) {
  const lineY = pageHeight - FOOTER_H;
  doc.save();
  doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.75);
  doc.moveTo(0, lineY).lineTo(pageWidth, lineY).stroke();
  doc.restore();

  const rowY = lineY + (FOOTER_ROW_H - 10) / 2 + 2;
  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();

  doc.font(FONT_REGULAR).fontSize(9);
  const brandW = doc.widthOfString(brandText, { characterSpacing: 1 });
  const sepText = '  ·  ';
  const sepW = doc.widthOfString(sepText);
  const pageNumText = String(pageNum);
  doc.font(FONT_BOLD).fontSize(9.5);
  const pageW = doc.widthOfString(pageNumText);
  const totalW = brandW + sepW + pageW;
  let tx = pageWidth / 2 - totalW / 2;

  doc.font(FONT_REGULAR).fontSize(9).fillColor(NEUTRAL_GRAY);
  doc.text(brandText, tx, rowY, { lineBreak: false, characterSpacing: 1 });
  tx += brandW;
  doc.fillColor(NEUTRAL_BORDER);
  doc.text(sepText, tx, rowY, { lineBreak: false });
  tx += sepW;
  doc.font(FONT_BOLD).fontSize(9.5).fillColor(colors.orangeDark);
  doc.text(pageNumText, tx, rowY, { lineBreak: false });
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
        // Warm ivory paper background for the whole page — the tint lives
        // on the page here, with cards sitting in a whiter tone on top
        // (the opposite fill relationship from design_2).
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

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        // NOTE: must use textColWidth here, not the full card width. The
        // answer (and its comparison table, if any) is drawn starting at
        // textColX — shifted right by BADGE_COL_W to clear the watermark
        // numeral column — so wrapping/column-width math has to use the
        // same narrower width or lines/table columns overshoot the card's
        // right border by (BADGE_COL_W - CARD_PADDING) px.
        const aBody = measureAnswerBody(doc, r, textColWidth);
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
        // Whiter-than-page card in a thin+hairline DOUBLE-rule frame — a
        // book-plate border — instead of design_1's rounded cream card or
        // design_2's flat white card with a colored left accent bar.
        doc.rect(contentX, cardY, contentWidth, cardHeight).fill(CARD_BG);
        doc.save();
        doc.strokeColor(colors.orange).lineWidth(1.1);
        doc.rect(contentX, cardY, contentWidth, cardHeight).stroke();
        doc.strokeColor(NEUTRAL_BORDER).lineWidth(0.6);
        doc.rect(contentX + 3, cardY + 3, contentWidth - 6, cardHeight - 6).stroke();
        doc.restore();

        // Large, low-opacity "watermark" numeral in the margin — a
        // classical book's exercise numbering, replacing both design_1's
        // circle badge and design_2's square badge.
        doc.save();
        doc.fillOpacity(0.32);
        doc.font(FONT_HEADING).fontSize(30).fillColor(colors.orange);
        doc.text(String(idx + 1).padStart(2, '0'), contentX + 6, cardY + CARD_PADDING - 6, {
          width: BADGE_COL_W + CARD_PADDING - 4,
          align: 'left',
          lineBreak: false,
        });
        doc.restore();

        // Question
        let curY = cardY + CARD_PADDING;
        drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
        curY += qMeasured.height + 10;

        // Divider — short, centered ornament under the text column.
        drawDivider(doc, textColX, curY, textColWidth);
        curY += 12;

        // ANSWER label — small caps, letter-spaced, accent-dark, flanked
        // by tiny flourish marks instead of a plain flat label.
        doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.orangeDark);
        doc.text('❧  ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
        curY += LABEL_SIZE + 8;

        // Answer body
        drawAnswerBody(doc, colors, aBody, textColX, curY, textColWidth);
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
