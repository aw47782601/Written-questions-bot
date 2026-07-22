// Renders a batch of {question, answer, page} results as a styled PDF
// that mirrors the look of the reference curriculum-book template: a
// colored header/footer band, cream rounded "cards" (one per question)
// with a colored numbered badge, a colored bold question line, an
// "ANSWER:" label, and the answer body with its *highlighted* terms
// (single-asterisk markup, same convention Gemini is prompted to use for
// Telegram bold — see lib/batchAnswer.js) rendered in bold accent color
// instead of plain black, just like the key terms are highlighted in the
// original book's screenshots.
//
// This is the "design_1" template (see lib/pdfDesigns.js for the design
// registry future designs get added to). Its accent color is orange by
// default but fully selectable — see lib/pdfColors.js, which derives the
// whole palette (dark accent, cream card background, divider tint) from
// whichever single base color the caller passes in, so new color choices
// don't need their own hand-picked set of four/five hex values.
//
// All fixed design chrome (header title, footer page label, page-citation
// label) is plain English — only the dynamic content (questions/answers,
// and an optional Arabic book name) may contain Arabic.
//
// Arabic text (the "no answer found" fallback message, an Arabic-language
// book's answers, or a question typed in Arabic) is shaped + bidi
// reordered via lib/textShaping.js before drawing, since PDFKit itself has
// no Arabic contextual-shaping or bidi support. A predominantly-Arabic
// answer is wrapped and shaped line-by-line as a single plain-colored
// right-aligned paragraph (inline bold-highlighting isn't attempted there —
// accurately re-flowing per-word color spans through the bidi reorder step
// is a lot more work for little practical benefit). A predominantly
// non-Arabic (e.g. English/formula-heavy) answer is tokenized word-by-word
// instead, so highlighted terms can be bolded; each individual token is
// still checked and, if it's Arabic, shaped + reordered on its own — so a
// stray Arabic word or phrase inside an otherwise-English answer still
// renders connected and in the right order instead of as disconnected,
// reversed letters.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
const { getColorTheme, DEFAULT_PDF_COLOR } = require('./pdfColors');

// Two font families are registered:
//  - Arabic content (shaped/bidi-reordered text) always uses Noto Naskh
//    Arabic, since Comic Neue / Fredoka have no Arabic glyph coverage.
//  - Everything else (questions, ANSWER label, answer body, badges, page
//    labels) uses the casual/rounded Comic Neue family, matching the
//    reference template's Comic Sans MS / Chalkboard SE look.
//  - The header title (the big "METABOLISM"-style heading) uses Fredoka
//    Bold, a free stand-in for the extra-bold rounded display faces
//    (Bubblegum Sans / JACINDA) used for headings in the reference design.
const FONT_ARABIC_REGULAR_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
const FONT_ARABIC_BOLD_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Bold.ttf');
const FONT_ARABIC_REGULAR = 'NotoNaskh-Regular';
const FONT_ARABIC_BOLD = 'NotoNaskh-Bold';

const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/ComicNeue-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/ComicNeue-Bold.ttf');
const FONT_REGULAR = 'ComicNeue-Regular';
const FONT_BOLD = 'ComicNeue-Bold';

const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/Fredoka-Bold.ttf');
const FONT_HEADING = 'Fredoka-Bold';

const PAGE_MARGIN = 36;
const CHECKER_SIZE = 14; // matches the dense checker border in the reference template
const HEADER_H = 76 + CHECKER_SIZE;
const FOOTER_H = 30 + CHECKER_SIZE;
const CARD_PADDING = 16;
const CARD_GAP = 16;
const BADGE_R = 15;
const BADGE_COL_W = 40; // space reserved for the numbered badge + gutter
const QUESTION_SIZE = 12.5;
const LABEL_SIZE = 10.5;
const ANSWER_SIZE = 10.5;
const LINE_HEIGHT_Q = 16;
const LINE_HEIGHT_A = 15;

// ---------------------------------------------------------------------
// Small text-measuring/drawing helpers
// ---------------------------------------------------------------------

// Splits "some *highlighted term* more text" into a flat list of
// { text, shaped, arabic, bold } tokens (asterisks stripped). A token can
// be a single non-Arabic word, or a whole run of consecutive Arabic words.
//
// This path (used for answers that are NOT predominantly Arabic — e.g. an
// English/formula-heavy answer with a short Arabic phrase mixed in) used to
// draw every word's raw logical-order characters straight to the page. For
// plain English tokens that's fine, but any Arabic word passed through
// completely unshaped: no cursive joining (letters render disconnected)
// and no bidi reorder (the word reads back-to-front).
//
// A later fix shaped each word individually, which connects the letters
// correctly but is still wrong for a *multi-word* Arabic phrase: shaping
// word-by-word never reorders the words themselves, so a 3-word phrase's
// words stay in left-to-right storage order instead of flowing right-to-
// left — each word reads fine internally but the phrase as a whole reads
// back-to-front. Consecutive Arabic words (within the same bold/non-bold
// segment) are now grouped into a single run and shaped together — via
// the same reshape+bidi pipeline the mostly-Arabic paragraph path uses —
// so both the letter-joining *and* the word order come out right.
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

// A stray Arabic word/phrase inside an otherwise non-Arabic answer must
// still be drawn with the Arabic font (Comic Neue has no Arabic glyphs) —
// everything else uses the casual Comic Neue family.
function tokenFont(tok) {
  if (tok.arabic) return tok.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR;
  return tok.bold ? FONT_BOLD : FONT_REGULAR;
}

// Greedy word-wrap for tokens, measuring each word with its own font (bold
// words are a little wider than regular ones). Arabic tokens are measured
// by their shaped form since ligatures (e.g. lam-alef) can change width.
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
      doc.fillColor(tok.bold ? colors.orangeDark : colors.text);
      doc.text(tok.shaped, cx, ly, { lineBreak: false });
      cx += doc.widthOfString(tok.shaped) + spaceWidth;
    });
  });
}

// Arabic paragraphs: wrap logically (plain words, asterisks stripped),
// then shape + bidi-reorder + right-align each finished line.
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

// Gemini is prompted (see lib/batchAnswer.js) to separate distinct points
// with a newline and a leading "- " so a multi-point answer never arrives
// as one run-on paragraph. Each paragraph is measured/drawn as its own
// block (own Arabic-vs-not decision, own wrap), so a bulleted line gets
// its own visual line with a small marker in the margin, and a short
// lead-in sentence before the bullets stays a plain (non-bulleted) block.
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
      const lines = wrapArabicPlain(doc, p, FONT_ARABIC_REGULAR, ANSWER_SIZE, innerWidth);
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
      // RTL: text stays right-aligned within the narrowed width, leaving
      // the indent gap on the right where the bullet marker is drawn —
      // i.e. the "start" of an RTL line, visually.
      drawArabicLines(doc, b.lines, x, cy, innerWidth, FONT_ARABIC_REGULAR, ANSWER_SIZE, LINE_HEIGHT_A, colors.text);
      if (b.bullet) doc.circle(x + width - 5, cy + 5, 2).fill(colors.orangeDark);
    } else {
      drawTokenLines(doc, colors, b.lines, b.bullet ? x + BULLET_INDENT : x, cy, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.circle(x + 4, cy + 5, 2).fill(colors.orangeDark);
    }
    cy += b.height + PARA_GAP;
  });
}

// ---------------------------------------------------------------------
// Comparison tables — for questions Gemini identifies as "compare X and
// Y" style, the answer arrives as { columns, rows } instead of prose (see
// lib/batchAnswer.js), and gets drawn as an actual bordered table rather
// than a paragraph, so a side-by-side comparison is easy to scan.
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
    const lines = wrapArabicPlain(doc, text, FONT_ARABIC_REGULAR, TABLE_FONT_SIZE, innerWidth);
    return { arabic: true, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
  }
  const tokens = tokenizeHighlighted(text);
  const lines = wrapTokens(doc, tokens, TABLE_FONT_SIZE, innerWidth);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
}

// A comparison table built from an Arabic book's excerpts should read
// right-to-left overall — the aspect/feature label column on the right,
// then compared items proceeding right-to-left — not just have
// individually-shaped Arabic text stuck in an otherwise LTR grid.
// Gemini always puts the aspect label first and item columns after (see
// lib/batchAnswer.js), so a full reverse of both the columns array and
// every row's cells turns that into the correct RTL physical order
// (aspect ends up last == rightmost, since cells are drawn left-to-right
// in array order) while each cell's own text is still shaped normally.
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

function drawHeaderCellText(doc, colors, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, colors.white);
  } else {
    doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor(colors.white);
    cell.lines.forEach((line, i) => {
      doc.text(line, innerX, y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H, { width: innerWidth, lineBreak: false });
    });
  }
}

function drawBodyCellText(doc, colors, cell, x, y, colWidth) {
  const innerX = x + TABLE_CELL_PAD;
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (cell.arabic) {
    drawArabicLines(doc, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, FONT_ARABIC_REGULAR, TABLE_FONT_SIZE, TABLE_ROW_LINE_H, colors.text);
  } else {
    cell.lines.forEach((line, i) => {
      let cx = innerX;
      const ly = y + TABLE_CELL_PAD + i * TABLE_ROW_LINE_H;
      line.forEach((tok) => {
        doc.font(tokenFont(tok)).fontSize(TABLE_FONT_SIZE);
        const spaceWidth = doc.widthOfString(' ');
        doc.fillColor(tok.bold ? colors.orangeDark : colors.text);
        doc.text(tok.shaped, cx, ly, { lineBreak: false });
        cx += doc.widthOfString(tok.shaped) + spaceWidth;
      });
    });
  }
}

function drawComparisonTable(doc, colors, measured, x, y, width) {
  const { colWidths, headerCells, headerHeight, bodyRows } = measured;

  doc.rect(x, y, width, headerHeight).fill(colors.orange);
  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, colors, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  let ry = y + headerHeight;
  bodyRows.forEach((row, ridx) => {
    doc.rect(x, ry, width, row.height).fill(ridx % 2 === 0 ? colors.cream : colors.white);
    let rx = x;
    row.cells.forEach((cell, i) => {
      drawBodyCellText(doc, colors, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    ry += row.height;
  });

  // Grid lines drawn last, on top of the fills.
  doc.save();
  doc.strokeColor(colors.border).lineWidth(1);
  doc.rect(x, y, width, measured.height).stroke();
  let gx = x;
  colWidths.forEach((w, i) => {
    gx += w;
    if (i < colWidths.length - 1) doc.moveTo(gx, y).lineTo(gx, y + measured.height).stroke();
  });
  let gy = y + headerHeight;
  bodyRows.forEach((row) => {
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
    gy += row.height;
  });
  doc.restore();
}

// Picks the answer-body renderer for a result: a comparison table when
// Gemini flagged the question as a comparison (see lib/batchAnswer.js),
// otherwise the normal paragraph/bullet text renderer above. Unifying
// behind one { height, draw() }-shaped object keeps the main layout loop
// in generateAnswersPdf() from needing to branch on result type itself.
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

// Small "o——◆——o" separator under the question, echoing the reference
// template's section dividers.
function drawDivider(doc, colors, x, y, width) {
  const midX = x + width / 2;
  doc.save();
  doc.strokeColor(colors.divider).lineWidth(1);
  doc.moveTo(x, y).lineTo(midX - 8, y).stroke();
  doc.moveTo(midX + 8, y).lineTo(x + width, y).stroke();
  doc.circle(x, y, 2).fill(colors.divider);
  doc.circle(x + width, y, 2).fill(colors.divider);
  doc.restore();
  doc.save();
  doc.rotate(45, { origin: [midX, y] });
  doc.rect(midX - 4, y - 4, 8, 8).fill(colors.orange);
  doc.restore();
}

// Alternating accent/white squares, e.g. the checkerboard strip framing
// the top and bottom of every page in the reference template.
function drawCheckerStrip(doc, colors, x, y, width, squareSize) {
  const cols = Math.ceil(width / squareSize);
  doc.save();
  for (let i = 0; i < cols; i++) {
    doc.rect(x + i * squareSize, y, squareSize, squareSize).fill(i % 2 === 0 ? colors.orange : colors.white);
  }
  doc.restore();
}

function drawHeader(doc, colors, title, bookName, pageWidth) {
  drawCheckerStrip(doc, colors, 0, 0, pageWidth, CHECKER_SIZE);
  const bandY = CHECKER_SIZE;
  const bandH = HEADER_H - CHECKER_SIZE;
  doc.rect(0, bandY, pageWidth, bandH).fill(colors.orange);
  const titleArabic = isMostlyArabic(title);
  doc.fillColor(colors.white).font(titleArabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(19);
  const titleText = titleArabic ? shapeArabicLine(title) : title;
  doc.text(titleText, 0, bandY + 18, { width: pageWidth, align: 'center' });
  if (bookName) {
    const bnArabic = isMostlyArabic(bookName);
    doc.font(bnArabic ? FONT_ARABIC_REGULAR : FONT_REGULAR).fontSize(11);
    const bn = bnArabic ? shapeArabicLine(bookName) : bookName;
    doc.text(bn, 0, bandY + 45, { width: pageWidth, align: 'center' });
  }
}

function drawFooter(doc, colors, pageNum, pageWidth, pageHeight) {
  const bandH = FOOTER_H - CHECKER_SIZE;
  const bandY = pageHeight - FOOTER_H;
  doc.rect(0, bandY, pageWidth, bandH).fill(colors.orange);
  doc.fillColor(colors.white).font(FONT_BOLD).fontSize(10.5);
  doc.text(`Page ${pageNum}`, 0, bandY + 8, { width: pageWidth, align: 'center' });
  drawCheckerStrip(doc, colors, 0, bandY + bandH, pageWidth, CHECKER_SIZE);
}

// results: [{ question, answer, page, isError }]
// meta: { title, bookName, colorKey } — colorKey is one of
// lib/pdfColors.js's PDF_COLOR_PRESETS keys (defaults to orange).
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
      const title = meta.title || 'Question Answers';

      let pageNum = 1;
      let y;

      function startPage() {
        drawHeader(doc, colors, title, meta.bookName, pageWidth);
        y = HEADER_H + 22;
      }

      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) {
          drawFooter(doc, colors, pageNum, pageWidth, pageHeight);
          doc.addPage();
          pageNum += 1;
          startPage();
        }
      }

      startPage();

      results.forEach((r, idx) => {
        const textColX = contentX + CARD_PADDING + BADGE_COL_W;
        const textColWidth = contentWidth - CARD_PADDING * 2 - BADGE_COL_W;

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        const aBody = measureAnswerBody(doc, r, contentWidth - CARD_PADDING * 2);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const innerHeight =
          qMeasured.height +
          10 + // divider gap
          6 + // gap before ANSWER label
          LABEL_SIZE +
          6 +
          aBody.height +
          (pageNoteText ? 16 : 0);
        const cardHeight = innerHeight + CARD_PADDING * 2 + 6; // small safety buffer

        ensureSpace(cardHeight + CARD_GAP);

        const cardY = y;
        doc.roundedRect(contentX, cardY, contentWidth, cardHeight, 10).fillAndStroke(colors.cream, colors.border);

        // Numbered badge
        const badgeCx = contentX + CARD_PADDING + BADGE_R;
        const badgeCy = cardY + CARD_PADDING + BADGE_R - 2;
        doc.circle(badgeCx, badgeCy, BADGE_R).fill(colors.orange);
        doc.font(FONT_BOLD).fontSize(12).fillColor(colors.white);
        doc.text(String(idx + 1), badgeCx - BADGE_R, badgeCy - 6, { width: BADGE_R * 2, align: 'center' });

        // Question
        let curY = cardY + CARD_PADDING;
        drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
        curY += qMeasured.height + 8;

        // Divider — starts after the badge column so it never cuts through
        // the numbered circle (previously started at the card's left edge,
        // which ran the line straight through the badge whenever the
        // question was short enough that curY hadn't cleared the circle's
        // bottom yet).
        drawDivider(doc, colors, textColX, curY, textColWidth);
        curY += 12;

        // ANSWER label
        doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.text);
        doc.text('ANSWER:', contentX + CARD_PADDING, curY, { lineBreak: false });
        curY += LABEL_SIZE + 6;

        // Answer body
        drawAnswerBody(doc, colors, aBody, contentX + CARD_PADDING, curY, contentWidth - CARD_PADDING * 2);
        curY += aBody.height;

        // Page citation
        if (pageNoteText) {
          curY += 4;
          doc.font(FONT_REGULAR).fontSize(9).fillColor(colors.gray);
          const w = doc.widthOfString(pageNoteText);
          doc.text(pageNoteText, contentX + contentWidth - CARD_PADDING - w, curY, { lineBreak: false });
        }

        y = cardY + cardHeight + CARD_GAP;
      });

      drawFooter(doc, colors, pageNum, pageWidth, pageHeight);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAnswersPdf };
