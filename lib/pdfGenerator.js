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
// { text, shaped, arabic, bold } word tokens (asterisks stripped).
//
// This path (used for answers that are NOT predominantly Arabic — e.g. an
// English/formula-heavy answer with a short Arabic phrase mixed in) used to
// draw every word's raw logical-order characters straight to the page. For
// plain English tokens that's fine, but any Arabic word passed through
// completely unshaped: no cursive joining (letters render disconnected)
// and no bidi reorder (the word reads back-to-front). Each token is now
// individually shaped here — via the same reshape+bidi pipeline the
// mostly-Arabic paragraph path uses — so a stray Arabic word inside an
// otherwise-English answer still renders correctly.
function tokenizeHighlighted(text) {
  const parts = String(text || '').split(/\*([^*]+)\*/g);
  const tokens = [];
  parts.forEach((part, idx) => {
    if (!part) return;
    const bold = idx % 2 === 1;
    part
      .split(/\s+/)
      .filter(Boolean)
      .forEach((w) => {
        const arabic = isMostlyArabic(w);
        tokens.push({ text: w, shaped: arabic ? shapeArabicLine(w) : w, arabic, bold });
      });
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

function measureAnswer(doc, answer, width) {
  if (isMostlyArabic(answer)) {
    const lines = wrapArabicPlain(doc, answer, FONT_ARABIC_REGULAR, ANSWER_SIZE, width);
    return { arabic: true, lines, height: lines.length * LINE_HEIGHT_A };
  }
  const tokens = tokenizeHighlighted(answer);
  const lines = wrapTokens(doc, tokens, ANSWER_SIZE, width);
  return { arabic: false, lines, height: lines.length * LINE_HEIGHT_A };
}

function drawAnswer(doc, colors, measured, x, y, width) {
  if (measured.arabic) {
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_REGULAR, ANSWER_SIZE, LINE_HEIGHT_A, colors.text);
  } else {
    drawTokenLines(doc, colors, measured.lines, x, y, ANSWER_SIZE, LINE_HEIGHT_A);
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
        const aMeasured = measureAnswer(doc, r.answer, contentWidth - CARD_PADDING * 2);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const innerHeight =
          qMeasured.height +
          10 + // divider gap
          6 + // gap before ANSWER label
          LABEL_SIZE +
          6 +
          aMeasured.height +
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
        drawAnswer(doc, colors, aMeasured, contentX + CARD_PADDING, curY, contentWidth - CARD_PADDING * 2);
        curY += aMeasured.height;

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
