// Renders a batch of {question, answer, page, chapter} results as a styled
// PDF in the light "Ultra-short curriculum sheet" look — "design_6" (see
// lib/pdfDesigns.js for the design registry). This design is a deliberate
// visual match for a reference study-sheet PDF the user supplied: a cream/
// white page, a red rounded "hero" title box on the first page, teal pill
// section banners (the reference's "Definition" / "Complete" / "Ultrashort"
// / "Graphs" headers), red bold category labels, green checkmark bullet
// items, a pale-yellow highlight chip for callout headings, and a pale-blue
// footer bar with a navy page-number circle centered between a left/right
// brand label — exactly the reference's "<bookName> [n] <footerBrand>"
// footer row.
//
// FONT NOTE: the user asked for "Cooper Black 18 / Adlam Display 14".
// Adlam Display is a real, freely-licensed (OFL) Google Font and is used
// here as requested. Cooper Black itself is NOT a freely-licensed font
// (it's a Monotype/Letraset commercial typeface), so it is not bundled
// here — shipping it would be a copyright problem. Instead this design
// uses "Fraunces" (also OFL, on Google Fonts) instanced at its Black
// weight + Soft optical setting + Wonky contours, which is the closest
// legally-free typeface to Cooper Black's thick, bubbly, rounded-serif
// character (see assets/fonts/FrauncesBlackSoft-Regular.ttf). If you own
// a Cooper Black license, drop the real .ttf into assets/fonts and swap
// FONT_HEADING_PATH below — everything else keys off the FONT_HEADING
// constant so no other code needs to change.
//
// Functionally this keeps full feature parity with design_2 through
// design_5: *highlighted* term coloring, comparison tables (Gemini-flagged
// { columns, rows } answers), chapter banners once per new chapter, a
// long-answer page-split (question stays with the first chunk of the
// answer, the rest continues on the next page), and full Arabic shaping +
// bidi reordering for mostly-Arabic paragraphs/cells or stray Arabic runs
// inside an otherwise Latin answer — see lib/pdfGenerator.js's header
// comment for why the run-grouping approach is needed; the same approach
// is used here unchanged, just re-themed and re-fonted to match the
// reference sheet.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
const { getColorTheme, DEFAULT_PDF_COLOR } = require('./pdfColors');

// --- Fonts -------------------------------------------------------------
const FONT_ARABIC_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Tajawal-Regular.ttf');
const FONT_ARABIC_BOLD_PATH = path.join(__dirname, '../assets/fonts/Tajawal-Bold.ttf');
const FONT_ARABIC_REGULAR = 'Tajawal-Regular';
const FONT_ARABIC_BOLD = 'Tajawal-Bold';

// Adlam Display — body copy, labels, footer brand text. One weight only
// (it's a display face, not a text family with a bold cut), so "bold"
// re-uses the same file; emphasis is carried by color instead of weight.
const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/AdlamDisplay-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/AdlamDisplay-Regular.ttf');
const FONT_REGULAR = 'AdlamDisplay-Regular';
const FONT_BOLD = 'AdlamDisplay-Regular';

// Fraunces (Black/Soft/Wonky instance) — the Cooper-Black-style headline
// face: hero title, section/chapter pill banners, question labels, badge
// numerals.
const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/FrauncesBlackSoft-Regular.ttf');
const FONT_HEADING = 'FrauncesBlackSoft-Regular';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 40;

// Requested type sizes: headline face at 18pt, body face at 14pt.
const HEADING_SIZE = 18;
const BODY_SIZE = 14;

// Fixed reference-sheet palette — a warm cream page, a red "hero" accent
// (title box, badges, category labels), a teal accent (section banners,
// dividers), a soft yellow highlight chip, a green checkmark, and a pale
// blue footer bar with a navy page-number circle. Deliberately NOT
// derived from meta.colorKey the way design_1–design_5 derive their
// single accent — the reference sheet is a fixed two-accent brand look
// (red + teal together), not a single hue that can be re-tinted.
const PAGE_BG = '#FFFEFA';
const CARD_BG = '#FFFFFF';
const CARD_BORDER = '#E7DFC7';
const TEXT_INK = '#232323';
const TEXT_GRAY = '#7A7167';

const RED = '#C0272D';
const RED_DARK = '#8E1D22';
const TEAL = '#1B5E73';
const TEAL_DARK = '#123F4D';
const YELLOW_BG = '#FFF3B0';
const YELLOW_BORDER = '#EBD97A';
const GREEN = '#2F8F46';
const HERO_BAND_BG = '#F7DFA0';
const FOOTER_BG = '#D7E7F2';
const FOOTER_NAVY = '#123F4D';

const HEADER_H = 14;
const PAGE_CONTENT_TOP = HEADER_H + 16;

const FOOTER_ROW_H = 30;
const FOOTER_H = FOOTER_ROW_H + 12;

const CARD_PADDING = 18;
const CARD_GAP = 16;
const CARD_RADIUS = 10;
const BADGE_COL_W = 34;
const QUESTION_SIZE = HEADING_SIZE;
const LABEL_SIZE = 9.5;
const ANSWER_SIZE = BODY_SIZE;
const LINE_HEIGHT_Q = 22;
const LINE_HEIGHT_A = 19;

// Hero title box (drawn once, at the top of page 1, when meta.title is
// given) — the reference sheet's red rounded box on a pale-yellow band.
const HERO_BAND_H = 92;
const HERO_BOX_H = 58;

// A long answer that doesn't fit in what's left of the current page now
// splits across pages instead of pushing the WHOLE question+answer card
// onto a fresh page — see splitAnswerBlocksForHeight + the card loop in
// generateAnswersPdf.
const CONTINUATION_NOTE_H = 16;
const MIN_SPLIT_ANSWER_LINES = 1;

// ---------------------------------------------------------------------
// Small text-measuring/drawing helpers — functionally identical to the
// prior designs' (see lib/pdfGenerator.js for the detailed rationale on
// Arabic run-grouping), wired to this file's own font constants/colors.
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
  if (tok.arabic) return FONT_ARABIC_REGULAR;
  return FONT_REGULAR;
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

// Highlighted (*bold*) inline terms render in the red accent — matching
// the reference sheet's red bold key-term styling inside body copy.
function drawTokenLines(doc, lines, x, y, size, lineHeight) {
  lines.forEach((line, i) => {
    let cx = x;
    const ly = y + i * lineHeight;
    line.forEach((tok) => {
      doc.font(tokenFont(tok)).fontSize(size);
      const spaceWidth = doc.widthOfString(' ');
      doc.fillColor(tok.bold ? RED : TEXT_INK);
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
  doc.font(FONT_HEADING).fontSize(QUESTION_SIZE);
  const height = doc.heightOfString(question, { width, lineGap: 2 });
  return { arabic: false, height: Math.max(height, LINE_HEIGHT_Q) };
}

function drawQuestion(doc, measured, question, x, y, width) {
  if (measured.arabic) {
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, RED_DARK);
  } else {
    doc.font(FONT_HEADING).fontSize(QUESTION_SIZE).fillColor(RED_DARK);
    doc.text(question, x, y, { width, lineGap: 2 });
  }
}

// Bullet markers a line can start with, mirroring the reference sheet's
// three list styles:
//   "» " / "> "  -> category label line (red circled-arrow bullet, bold
//                   red text) — e.g. the reference's "Management:",
//                   "Effectiveness:" headers.
//   "✓ " / "√ "  -> checkmark item (green check, plain text) — the
//                   reference's "✓ Planning functions" style lines.
//   "# "         -> highlighted callout heading (pale-yellow chip) — the
//                   reference's "Enumerate management functions" banners.
//   "- " / "• "  -> plain sub-bullet (small dot), the fallback style.
const CATEGORY_RE = /^[»>]\s+/;
const CHECK_RE = /^[✓√]\s+/;
const HIGHLIGHT_RE = /^#\s+/;
const BULLET_RE = /^[-•]\s+/;
const BULLET_INDENT = 15;
const PARA_GAP = 5;

function classifyParagraph(raw) {
  if (CATEGORY_RE.test(raw)) return { kind: 'category', text: raw.replace(CATEGORY_RE, '') };
  if (CHECK_RE.test(raw)) return { kind: 'check', text: raw.replace(CHECK_RE, '') };
  if (HIGHLIGHT_RE.test(raw)) return { kind: 'highlight', text: raw.replace(HIGHLIGHT_RE, '') };
  if (BULLET_RE.test(raw)) return { kind: 'bullet', text: raw.replace(BULLET_RE, '') };
  return { kind: 'plain', text: raw };
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const HIGHLIGHT_CHIP_PAD_X = 10;
const HIGHLIGHT_CHIP_PAD_Y = 5;

function measureAnswer(doc, answer, width) {
  const paragraphs = splitParagraphs(answer);
  const blocks = paragraphs.map((raw) => {
    const { kind, text: p } = classifyParagraph(raw);
    const indent = kind === 'bullet' || kind === 'check' ? BULLET_INDENT : 0;
    const innerWidth = width - indent;

    if (kind === 'highlight') {
      doc.font(FONT_HEADING).fontSize(LABEL_SIZE + 1);
      const words = String(p).split(/\s+/).filter(Boolean);
      const lines = wrapWordsByWidth(doc, words, FONT_HEADING, LABEL_SIZE + 1, width - HIGHLIGHT_CHIP_PAD_X * 2);
      const h = lines.length * (LABEL_SIZE + 6) + HIGHLIGHT_CHIP_PAD_Y * 2;
      return { kind, arabic: false, lines, height: h };
    }

    if (isMostlyArabic(p)) {
      const words = tokenizeArabicHighlightedWords(p);
      const lines = wrapArabicHighlightedWords(doc, words, ANSWER_SIZE, innerWidth);
      return { kind, arabic: true, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_A };
    }
    const tokens = tokenizeHighlighted(p);
    const lines = wrapTokens(doc, tokens, ANSWER_SIZE, innerWidth);
    return { kind, arabic: false, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_A };
  });
  const height = blocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, blocks.length - 1);
  return { blocks, height };
}

function drawAnswer(doc, measured, x, y, width) {
  let cy = y;
  measured.blocks.forEach((b) => {
    if (b.kind === 'highlight') {
      const w = width;
      const h = b.height;
      doc.save();
      doc.roundedRect(x, cy, w, h, 5).fill(YELLOW_BG);
      doc.strokeColor(YELLOW_BORDER).lineWidth(1);
      doc.roundedRect(x, cy, w, h, 5).stroke();
      doc.restore();
      doc.font(FONT_HEADING).fontSize(LABEL_SIZE + 1).fillColor(TEAL_DARK);
      b.lines.forEach((line, i) => {
        doc.text(line, x + HIGHLIGHT_CHIP_PAD_X, cy + HIGHLIGHT_CHIP_PAD_Y + i * (LABEL_SIZE + 6), {
          width: w - HIGHLIGHT_CHIP_PAD_X * 2,
          lineBreak: false,
        });
      });
      cy += h + PARA_GAP;
      return;
    }

    const indent = b.kind === 'bullet' || b.kind === 'check' ? BULLET_INDENT : 0;
    const innerWidth = width - indent;

    if (b.arabic) {
      drawArabicHighlightedLines(doc, b.lines, x, cy, innerWidth, ANSWER_SIZE, LINE_HEIGHT_A, b.kind === 'category');
    } else if (b.kind === 'category') {
      // Red circled-arrow bullet + bold red category label.
      doc.font(FONT_BOLD).fontSize(ANSWER_SIZE).fillColor(RED);
      doc.text('\u2283', x, cy + 1, { lineBreak: false });
      drawTokenLinesColored(doc, b.lines, x + 14, cy, ANSWER_SIZE, LINE_HEIGHT_A, RED);
    } else {
      drawTokenLines(doc, b.lines, x + indent, cy, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.kind === 'bullet') {
        doc.save();
        doc.fillColor(TEAL);
        doc.circle(x + 4, cy + 6, 2.2).fill();
        doc.restore();
      } else if (b.kind === 'check') {
        doc.save();
        doc.font(FONT_BOLD).fontSize(ANSWER_SIZE).fillColor(GREEN);
        doc.text('\u2713', x, cy - 1, { lineBreak: false });
        doc.restore();
      }
    }
    cy += b.height + PARA_GAP;
  });
}

// Same as drawTokenLines but forces every token (highlighted or not) to
// a single fixed color — used for category-label lines, where the whole
// line reads as one bold red term even if the author didn't wrap it in
// *asterisks*.
function drawTokenLinesColored(doc, lines, x, y, size, lineHeight, color) {
  lines.forEach((line, i) => {
    let cx = x;
    const ly = y + i * lineHeight;
    line.forEach((tok) => {
      doc.font(FONT_BOLD).fontSize(size).fillColor(color);
      doc.text(tok.shaped, cx, ly, { lineBreak: false });
      cx += doc.widthOfString(tok.shaped) + doc.widthOfString(' ');
    });
  });
}

// ---------------------------------------------------------------------
// Comparison tables — the reference sheet's "Graphs" indicator table:
// solid teal header row with white text, thin light-tan row rules, and
// alternating white/cream row fills.
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;
const TABLE_HEADER_GAP = 0;
const TABLE_RADIUS = 6;
const TABLE_ROW_ALT = '#FBF6E6';

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
    doc.font(FONT_ARABIC_REGULAR).fontSize(size);
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

function drawArabicHighlightedLines(doc, lines, x, y, width, size, lineHeight, forceRed) {
  doc.font(FONT_ARABIC_REGULAR).fontSize(size);
  const spaceWidth = doc.widthOfString(' ');

  lines.forEach((line, i) => {
    const runs = buildArabicHighlightedRuns(line).map((r) => {
      doc.font(FONT_ARABIC_REGULAR).fontSize(size);
      return { ...r, w: doc.widthOfString(r.shaped) };
    });
    const totalWidth = runs.reduce((sum, r) => sum + r.w, 0) + spaceWidth * Math.max(0, runs.length - 1);

    const ly = y + i * lineHeight;
    let cx = x + Math.max(0, width - totalWidth);
    [...runs].reverse().forEach((r) => {
      doc.font(FONT_ARABIC_REGULAR).fontSize(size).fillColor(forceRed || r.bold ? RED : TEXT_INK);
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

function drawHeaderCellText(doc, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, '#FFFFFF');
  } else {
    doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor('#FFFFFF');
    cell.lines.forEach((line, i) => {
      doc.text(line, innerX, y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H, { width: innerWidth, lineBreak: false });
    });
  }
}

function drawBodyCellText(doc, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicHighlightedLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, false);
  } else {
    cell.lines.forEach((line, i) => {
      let cx = innerX;
      const ly = y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H;
      line.forEach((tok) => {
        doc.font(tokenFont(tok)).fontSize(TABLE_FONT_SIZE);
        const spaceWidth = doc.widthOfString(' ');
        doc.fillColor(tok.bold ? RED : TEXT_INK);
        doc.text(tok.shaped, cx, ly, { lineBreak: false });
        cx += doc.widthOfString(tok.shaped) + spaceWidth;
      });
    });
  }
}

function drawComparisonTable(doc, measured, x, y, width) {
  const { colWidths, headerCells, headerHeight, bodyRows } = measured;

  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).fill(CARD_BG);
  doc.save();
  doc.strokeColor(CARD_BORDER).lineWidth(1);
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).stroke();
  doc.restore();

  // Solid teal header band (clipped to the table's rounded top corners).
  doc.save();
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).clip();
  doc.rect(x, y, width, headerHeight).fill(TEAL);
  doc.restore();

  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  let ry = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x + 1, ry, width - 2, row.height).fill(ridx % 2 === 0 ? CARD_BG : TABLE_ROW_ALT);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    doc.save();
    doc.strokeColor(CARD_BORDER).lineWidth(0.6);
    doc.moveTo(x + 6, ry).lineTo(x + width - 6, ry).stroke();
    doc.restore();
    ry += row.height;
  });

  doc.save();
  doc.strokeColor(CARD_BORDER).lineWidth(1);
  doc.roundedRect(x, y, width, measured.height, TABLE_RADIUS).stroke();
  doc.restore();
}

// Returns { firstBlocks, restBlocks }: everything that fits within
// maxHeight goes in firstBlocks (in original order), everything else —
// including the tail of a block that only PARTIALLY fit — goes in
// restBlocks (also in original order). Highlight-chip blocks are never
// split mid-block (their height model differs from LINE_HEIGHT_A), so a
// chip that doesn't fully fit moves to restBlocks whole.
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

    if (b.kind === 'highlight') {
      restBlocks.push(b);
      splitDone = true;
      return;
    }

    const availableForBlock = maxHeight - usedHeight - gap;
    const linesThatFit = Math.max(0, Math.floor(availableForBlock / LINE_HEIGHT_A));

    if (linesThatFit > 0 && linesThatFit < b.lines.length) {
      firstBlocks.push({ ...b, lines: b.lines.slice(0, linesThatFit), height: linesThatFit * LINE_HEIGHT_A });
      restBlocks.push({ ...b, lines: b.lines.slice(linesThatFit), height: (b.lines.length - linesThatFit) * LINE_HEIGHT_A });
    } else {
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

function drawAnswerBody(doc, body, x, y, width) {
  let cy = y;
  if (body.kind === 'table') {
    if (body.intro) {
      drawAnswer(doc, body.intro, x, cy, width);
      cy += body.intro.height + PARA_GAP;
    }
    drawComparisonTable(doc, body.measured, x, cy, width);
  } else {
    drawAnswer(doc, body.measured, x, y, width);
  }
}

// Divider — a thin teal rule with a small solid teal square tucked at
// its left end, echoing the reference sheet's section rules.
function drawDivider(doc, x, y, width) {
  doc.save();
  doc.fillColor(TEAL);
  doc.rect(x, y - 2, 10, 4).fill();
  doc.restore();

  doc.save();
  doc.strokeColor(CARD_BORDER).lineWidth(1);
  doc.moveTo(x + 16, y).lineTo(x + width, y).stroke();
  doc.restore();
}

// Chapter/section header — a teal capsule pill that HUGS its own text
// width, centered on the page, with a small decorative "pencil" mark —
// this is the direct match for the reference sheet's "Definition" /
// "Complete" / "Ultrashort" / "Graphs" banner pills.
const CHAPTER_HEADER_SIZE = HEADING_SIZE - 2;
const CHAPTER_HEADER_MIN_SIZE = 9;
const CHAPTER_HEADER_PAD_X = 24;
const CHAPTER_HEADER_PAD_Y = 10;
const CHAPTER_HEADER_GAP = 16;

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
  const maxTextW = pageContentWidth - CHAPTER_HEADER_PAD_X * 2 - 26;
  const arabic = isMostlyArabic(chapterText);

  let fitted;
  if (arabic) {
    const shaped = shapeArabicLine(chapterText);
    fitted = fitChapterText(doc, FONT_ARABIC_BOLD, shaped, maxTextW, CHAPTER_HEADER_SIZE, CHAPTER_HEADER_MIN_SIZE);
  } else {
    fitted = fitChapterText(doc, FONT_HEADING, chapterText, maxTextW, CHAPTER_HEADER_SIZE, CHAPTER_HEADER_MIN_SIZE, {
      characterSpacing: 0.3,
    });
  }

  const capsuleW = fitted.width + CHAPTER_HEADER_PAD_X * 2 + 26;
  const capsuleH = fitted.size + CHAPTER_HEADER_PAD_Y * 2;
  return { arabic, fitted, capsuleW, capsuleH };
}

function drawChapterHeader(doc, measured, pageContentX, y, pageContentWidth) {
  const { arabic, fitted, capsuleW, capsuleH } = measured;
  const cx = pageContentX + pageContentWidth / 2;
  const capsuleX = cx - capsuleW / 2;
  const r = capsuleH / 2;

  doc.roundedRect(capsuleX, y, capsuleW, capsuleH, r).fill(TEAL);

  // Tiny "pencil" mark: a short diagonal line with a dot tip, on the
  // pill's right end — a light decorative nod to the reference sheet's
  // pencil icon next to each banner.
  const iconCx = capsuleX + capsuleW - 20;
  const iconCy = y + capsuleH / 2;
  doc.save();
  doc.strokeColor('#FFFFFF').lineWidth(2).lineCap('round');
  doc.moveTo(iconCx - 6, iconCy + 6).lineTo(iconCx + 6, iconCy - 6).stroke();
  doc.restore();
  doc.save();
  doc.fillColor('#FFFFFF');
  doc.circle(iconCx + 7, iconCy - 7, 1.6).fill();
  doc.restore();

  const textX = capsuleX + (capsuleW - 26 - fitted.width) / 2 + 4;
  const textY = y + (capsuleH - fitted.size) / 2 - 1;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(fitted.size).fillColor('#FFFFFF');
  doc.text(fitted.text, textX, textY, {
    lineBreak: false,
    ...(arabic ? {} : { characterSpacing: 0.3 }),
  });
}

// Header — intentionally blank (no hairline, no running title): the
// reference sheet has no page header, just content starting at the
// margin, with everything communicated via the section pills instead.
function drawHeader() {}

const DEFAULT_BOOK_NAME = 'Ultra-short';
const DEFAULT_FOOTER_BRAND = 'ANSWER KEY';
const FOOTER_CIRCLE_D = 26;

// Footer — a pale-blue bar spanning the page width, with a navy
// page-number circle centered between a left book-name label and a
// right brand label. This mirrors the reference sheet's footer row
// exactly: "<bookName>  (n)  <footerBrand>". Pass meta.bookName /
// meta.footerBrand to reproduce the reference's own "Ultra-short" /
// "Victorio Team" text if you want it verbatim.
function drawFooter(doc, pageNum, pageWidth, pageHeight, bookName, footerBrand) {
  const barY = pageHeight - FOOTER_H;
  doc.rect(0, barY, pageWidth, FOOTER_H).fill(FOOTER_BG);

  const rowY = barY + (FOOTER_H - 12) / 2;
  const cx = pageWidth / 2;

  doc.font(FONT_BOLD).fontSize(11).fillColor(FOOTER_NAVY);
  const leftText = bookName || DEFAULT_BOOK_NAME;
  doc.text(leftText, PAGE_MARGIN, rowY, { lineBreak: false });

  const rightText = footerBrand || DEFAULT_FOOTER_BRAND;
  const rightW = doc.widthOfString(rightText);
  doc.text(rightText, pageWidth - PAGE_MARGIN - rightW, rowY, { lineBreak: false });

  const circleY = barY + FOOTER_H / 2;
  doc.save();
  doc.fillColor(FOOTER_NAVY);
  doc.circle(cx, circleY, FOOTER_CIRCLE_D / 2).fill();
  doc.restore();
  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(11).fillColor('#FFFFFF');
  const pw = doc.widthOfString(pageNumText);
  doc.text(pageNumText, cx - pw / 2, circleY - 6, { lineBreak: false });
}

// Card frame — a plain white rounded card with a thin warm-tan border
// (no accent bar) — the reference sheet reads as one continuous flowing
// page rather than boxed cards, so the frame here is kept quiet.
function drawCardFrame(doc, x, y, w, h) {
  doc.roundedRect(x, y, w, h, CARD_RADIUS).fill(CARD_BG);
  doc.save();
  doc.strokeColor(CARD_BORDER).lineWidth(1);
  doc.roundedRect(x, y, w, h, CARD_RADIUS).stroke();
  doc.restore();
}

// Badge — a solid red circle holding the question number, matching the
// reference sheet's red accent color used for its numbered/lettered
// markers.
const BADGE_SIZE = 24;

function drawBadge(doc, idx, x, y) {
  const cx = x + BADGE_SIZE / 2;
  const cy = y + BADGE_SIZE / 2;
  doc.save();
  doc.fillColor(RED);
  doc.circle(cx, cy, BADGE_SIZE / 2).fill();
  doc.restore();

  const numText = String(idx + 1);
  doc.font(FONT_HEADING).fontSize(10).fillColor('#FFFFFF');
  doc.text(numText, x, cy - 5, { width: BADGE_SIZE, align: 'center', lineBreak: false });
}

// Hero title box — drawn once, at the top of page 1, when meta.title is
// given: a pale-yellow band with a centered red rounded box holding the
// title in the Cooper-Black-style heading face, white text — a direct
// match for the reference sheet's cover title treatment.
function drawHero(doc, title, pageWidth) {
  doc.rect(0, 0, pageWidth, HERO_BAND_H).fill(HERO_BAND_BG);

  const maxBoxW = pageWidth - PAGE_MARGIN * 2 - 40;
  doc.font(FONT_HEADING).fontSize(22);
  let size = 22;
  let width = doc.widthOfString(title);
  while (width > maxBoxW - 40 && size > 12) {
    size -= 1;
    width = doc.fontSize(size).widthOfString(title);
  }
  const boxW = Math.min(pageWidth - PAGE_MARGIN * 2, width + 60);
  const boxX = (pageWidth - boxW) / 2;
  const boxY = (HERO_BAND_H - HERO_BOX_H) / 2;

  doc.roundedRect(boxX, boxY, boxW, HERO_BOX_H, HERO_BOX_H / 2.4).fill(RED);
  doc.save();
  doc.strokeColor('#FFFFFF').lineWidth(3);
  doc.roundedRect(boxX + 4, boxY + 4, boxW - 8, HERO_BOX_H - 8, (HERO_BOX_H - 8) / 2.4).stroke();
  doc.restore();

  doc.font(FONT_HEADING).fontSize(size).fillColor('#FFFFFF');
  doc.text(title, boxX, boxY + (HERO_BOX_H - size) / 2 - 2, { width: boxW, align: 'center', lineBreak: false });
}

// results: [{ question, answer, page, isError, chapter }] — see
// lib/pdfGenerator.js's header comment for the chapter-banner contract.
// meta: { title, bookName, footerBrand, colorKey } — colorKey is
// accepted for call-site compatibility with the other designs but is
// NOT used here (see the palette note above); title (if given) draws
// the page-1 hero box; bookName/footerBrand feed the footer row.
function generateAnswersPdf(results, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      // Accepted for signature parity with design_1–design_5 (some call
      // sites pass colorKey unconditionally); intentionally unused here.
      void getColorTheme(meta.colorKey || DEFAULT_PDF_COLOR);

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
      let heroDrawnOnPage1 = false;

      function startPage() {
        doc.rect(0, 0, pageWidth, pageHeight).fill(PAGE_BG);
        drawHeader();
        if (pageNum === 1 && meta.title && !heroDrawnOnPage1) {
          drawHero(doc, meta.title, pageWidth);
          heroDrawnOnPage1 = true;
          y = HERO_BAND_H + 18;
        } else {
          y = PAGE_CONTENT_TOP;
        }
      }

      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) {
          drawFooter(doc, pageNum, pageWidth, pageHeight, meta.bookName, meta.footerBrand);
          doc.addPage();
          pageNum += 1;
          startPage();
        }
      }

      startPage();

      let lastChapter = null;

      results.forEach((r, idx) => {
        if (r.chapter && r.chapter !== lastChapter) {
          if (y > PAGE_CONTENT_TOP && !(pageNum === 1 && heroDrawnOnPage1 && y <= HERO_BAND_H + 20)) {
            drawFooter(doc, pageNum, pageWidth, pageHeight, meta.bookName, meta.footerBrand);
            doc.addPage();
            pageNum += 1;
            startPage();
          }
          const chMeasured = measureChapterHeader(doc, r.chapter, contentWidth);
          drawChapterHeader(doc, chMeasured, contentX, y, contentWidth);
          y += chMeasured.capsuleH + CHAPTER_HEADER_GAP;
          lastChapter = r.chapter;
        }

        const textColX = contentX + CARD_PADDING + BADGE_COL_W;
        const textColWidth = contentWidth - CARD_PADDING * 2 - BADGE_COL_W;
        const fullTextWidth = contentWidth - CARD_PADDING * 2;

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        const aBody = measureAnswerBody(doc, r, fullTextWidth);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const innerHeight =
          qMeasured.height +
          10 +
          8 +
          LABEL_SIZE +
          6 +
          aBody.height +
          (pageNoteText ? 16 : 0);
        const cardHeight = innerHeight + CARD_PADDING * 2 + 6;
        const answerX = contentX + CARD_PADDING;

        function drawFullCard() {
          ensureSpace(cardHeight + CARD_GAP);
          const cardY = y;
          drawCardFrame(doc, contentX, cardY, contentWidth, cardHeight);

          drawBadge(doc, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 3);

          let curY = cardY + CARD_PADDING;
          drawQuestion(doc, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
          curY += qMeasured.height + 10;

          drawDivider(doc, textColX, curY, textColWidth);
          curY += 12;

          doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(TEAL);
          doc.text('ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
          curY += LABEL_SIZE + 8;

          drawAnswerBody(doc, aBody, answerX, curY, fullTextWidth);
          curY += aBody.height;

          if (pageNoteText) {
            curY += 4;
            doc.font(FONT_REGULAR).fontSize(9).fillColor(TEXT_GRAY);
            const w = doc.widthOfString(pageNoteText);
            doc.text(pageNoteText, contentX + contentWidth - CARD_PADDING - w, curY, { lineBreak: false });
          }

          y = cardY + cardHeight + CARD_GAP;
        }

        function drawSplitHalf(boxY, boxHeight) {
          doc.rect(contentX, boxY, contentWidth, boxHeight).fill(CARD_BG);
          doc.save();
          doc.strokeColor(CARD_BORDER).lineWidth(1);
          doc.rect(contentX, boxY, contentWidth, boxHeight).stroke();
          doc.restore();
          doc.rect(contentX, boxY, 4, boxHeight).fill(RED);
        }

        const availableOnPage = pageHeight - FOOTER_H - 14 - y;

        if (cardHeight <= availableOnPage || aBody.kind !== 'text') {
          drawFullCard();
        } else {
          const headerHeight = qMeasured.height + 10 + 12 + LABEL_SIZE + 8;
          const spaceForAnswerHere = availableOnPage - CARD_PADDING - headerHeight - CONTINUATION_NOTE_H - 6;

          const { firstBlocks, restBlocks } =
            spaceForAnswerHere >= MIN_SPLIT_ANSWER_LINES * LINE_HEIGHT_A
              ? splitAnswerBlocksForHeight(aBody.measured.blocks, spaceForAnswerHere)
              : { firstBlocks: [], restBlocks: [] };

          if (firstBlocks.length === 0 || restBlocks.length === 0) {
            drawFullCard();
          } else {
            const firstAnswerHeight =
              firstBlocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, firstBlocks.length - 1);
            const firstPartHeight = CARD_PADDING + headerHeight + firstAnswerHeight + CONTINUATION_NOTE_H + CARD_PADDING;

            const cardY = y;
            drawSplitHalf(cardY, firstPartHeight);
            drawBadge(doc, idx, contentX + CARD_PADDING, cardY + CARD_PADDING - 3);

            let curY = cardY + CARD_PADDING;
            drawQuestion(doc, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
            curY += qMeasured.height + 10;

            drawDivider(doc, textColX, curY, textColWidth);
            curY += 12;

            doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(TEAL);
            doc.text('ANSWER', textColX, curY, { lineBreak: false, characterSpacing: 1 });
            curY += LABEL_SIZE + 8;

            drawAnswer(doc, { blocks: firstBlocks }, answerX, curY, fullTextWidth);
            curY += firstAnswerHeight + 4;

            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(TEXT_GRAY);
            doc.text(`▾ Q${idx + 1} continues on next page…`, answerX, curY, { width: fullTextWidth });

            y = cardY + firstPartHeight;

            drawFooter(doc, pageNum, pageWidth, pageHeight, meta.bookName, meta.footerBrand);
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
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(TEXT_GRAY);
            doc.text(`↳ Q${idx + 1} (continued):`, answerX, curY2, { width: fullTextWidth });
            curY2 += CONTINUATION_NOTE_H;

            drawAnswer(doc, { blocks: restBlocks }, answerX, curY2, fullTextWidth);
            curY2 += restAnswerHeight;

            if (pageNoteText) {
              curY2 += 4;
              doc.font(FONT_REGULAR).fontSize(9).fillColor(TEXT_GRAY);
              const w = doc.widthOfString(pageNoteText);
              doc.text(pageNoteText, contentX + contentWidth - CARD_PADDING - w, curY2, { lineBreak: false });
            }

            y = cardY2 + secondPartHeight + CARD_GAP;
          }
        }
      });

      drawFooter(doc, pageNum, pageWidth, pageHeight, meta.bookName, meta.footerBrand);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAnswersPdf };
