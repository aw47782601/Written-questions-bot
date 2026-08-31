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
// answer (and an Arabic comparison-table cell) is split into RUNS of
// consecutive highlighted/non-highlighted words, each run shaped +
// reordered on its own, then the runs are drawn in reversed order,
// right-aligned — see tokenizeArabicHighlightedWords /
// drawArabicHighlightedLines below — so a *highlighted* term still comes
// out in the accent color instead of the whole paragraph collapsing to
// one flat color. A predominantly non-Arabic (e.g. English/formula-heavy)
// answer is tokenized word-by-word instead, so highlighted terms can be
// bolded/colored; each individual token is still checked and, if it's
// Arabic, shaped + reordered on its own — so a stray Arabic word or
// phrase inside an otherwise-English answer still renders connected and
// in the right order instead of as disconnected, reversed letters.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, hasGreek, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
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

// Comic Neue has zero Greek glyph coverage and only patchy coverage of
// arrows/math operators/other symbol blocks (confirmed via font cmap
// inspection), so any answer using math/science symbols like α β γ δ or
// arrows/operators like → ↑ ↓ ← ± × ÷ ≤ ≥ √ ∞ ∑ silently drew as
// blank/missing-glyph boxes. Lato has by far the widest coverage of the
// bundled fonts for these ranges, so it's registered here purely as a
// per-word fallback — see tokenFont() below and hasGreek()'s definition
// in textShaping.js for exactly which ranges trigger it — without
// changing the design's normal Comic Neue look for everything else.
const FONT_GREEK_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_GREEK_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_GREEK_REGULAR = 'Lato-Regular';
const FONT_GREEK_BOLD = 'Lato-Bold';

// assets/fonts/Fredoka-Bold.ttf is mislabeled — it's internally "Fredoka
// Light" despite its filename (confirmed via the font's own name table;
// see the identical fix/comment in lib/pdfDesignMcq.js), so it never
// actually rendered bold here. Fredoka-Bold-700.ttf is the real bold
// weight and is what the footer "BY M.E.M" wordmark below is meant to use.
const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/Fredoka-Bold-700.ttf');
const FONT_HEADING = 'Fredoka-Bold';

const PAGE_MARGIN = 36;
const CHECKER_SIZE = 28; // larger checker squares for both header and footer bands

// Header: two stacked checkerboard rows, no title/banner — same visual
// language as the footer border, just at the top of the page.
const HEADER_H = CHECKER_SIZE * 2;

// Where page content (first card / chapter banner) starts, right under
// the header band — matches startPage()'s `y = HEADER_H + 22` inside
// generateAnswersPdf. Used to detect whether we're already sitting at the
// top of a fresh page (see the chapter-header handling below) without
// duplicating the "+22" offset in two places.
const PAGE_CONTENT_TOP = HEADER_H + 22;

// Footer: exactly two plain checkerboard rows, flush with the bottom
// edge. The "BY M.E.M" brand wordmark and the page number both sit
// inside the upper checker row itself (not floating above the rows).
const FOOTER_CHECKER_H = CHECKER_SIZE * 2;
const FOOTER_TOP_PAD = 10; // breathing room between page content and the footer band
const FOOTER_H = FOOTER_TOP_PAD + FOOTER_CHECKER_H;

const CARD_PADDING = 16;
const CARD_GAP = 16;
const BADGE_R = 15;
const BADGE_COL_W = 40; // space reserved for the numbered badge + gutter
const QUESTION_SIZE = 16; // was 12.5 → 14 → 16 — larger, more horizontal footprint
const LABEL_SIZE = 10.5;
const ANSWER_SIZE = 14; // was 10.5 → 12 → 14
const LINE_HEIGHT_Q = 19; // was 16 → 17 — kept tight relative to the font-size jump on purpose
const LINE_HEIGHT_A = 18; // was 15 → 16

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
        tokens.push({ text: words[i], shaped: words[i], arabic: false, greek: hasGreek(words[i]), bold });
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
  if (tok.greek) return tok.bold ? FONT_GREEK_BOLD : FONT_GREEK_REGULAR;
  return tok.bold ? FONT_BOLD : FONT_REGULAR;
}

// Question-text tokenizer — same Arabic-run-grouping + Greek/symbol
// fallback as tokenizeHighlighted above, minus the *highlight* markup
// parsing (a question has no bold/plain distinction of its own — the
// whole line is uniformly bold, so every token is marked bold=true).
// Deliberately NOT implemented as tokenizeHighlighted(`*${question}*`)
// — wrapping the raw question in asterisks would mis-split any question
// that already contains a literal '*' (e.g. "5*3=15").
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
  // Same per-word Arabic-run/Greek-symbol fallback as the answer body's
  // tokenizeHighlighted/tokenFont above — question text used to be drawn
  // with one flat doc.text(FONT_BOLD) call, so any α β γ or → ± × ÷ etc.
  // inside a question (Comic Neue has no glyphs for them — see hasGreek's
  // definition in textShaping.js) silently drew as a blank box. Every
  // word here is marked bold=true (the question's fixed weight), so
  // tokenFont()/drawTokenLines() pick FONT_BOLD/FONT_GREEK_BOLD per word
  // and still color the whole line colors.orangeDark like before.
  const tokens = tokenizeQuestionWords(question);
  const lines = wrapTokens(doc, tokens, QUESTION_SIZE, width);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_Q };
}

function drawQuestion(doc, colors, measured, question, x, y, width) {
  if (measured.arabic) {
    drawArabicLines(doc, measured.lines, x, y, width, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, colors.orangeDark);
  } else {
    drawTokenLines(doc, colors, measured.lines, x, y, QUESTION_SIZE, LINE_HEIGHT_Q);
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
      // Same *highlighted*-keyword-aware renderer used for Arabic
      // comparison-table cells (see tokenizeArabicHighlightedWords et al.
      // below) — previously this path went through wrapArabicPlain, which
      // strips asterisks and drew the whole paragraph in one flat color,
      // so a *highlighted* term in a normal (non-comparison) Arabic
      // answer never actually showed up in the accent color.
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
      // RTL: text stays right-aligned within the narrowed width, leaving
      // the indent gap on the right where the bullet marker is drawn —
      // i.e. the "start" of an RTL line, visually. Highlighted words
      // are colored via drawArabicHighlightedLines (see below).
      drawArabicHighlightedLines(doc, colors, b.lines, x, cy, innerWidth, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.circle(x + width - 5, cy + 5, 2).fill(colors.orangeDark);
    } else {
      drawTokenLines(doc, colors, b.lines, b.bullet ? x + BULLET_INDENT : x, cy, ANSWER_SIZE, LINE_HEIGHT_A);
      if (b.bullet) doc.circle(x + 4, cy + 5, 2).fill(colors.orangeDark);
    }
    cy += b.height + PARA_GAP;
  });
}

// Splits a measureAnswer() result's `blocks` array in two at LINE
// granularity (not just paragraph/block granularity) so a long answer
// can continue onto a fresh page instead of the entire question+answer
// card being pushed there as one atomic unit, leaving whatever space was
// left on the current page permanently blank (see generateAnswersPdf's
// card-layout loop below, the actual "dynamic page fill" this enables).
//
// Each block's `lines` array is exactly what drawArabicHighlightedLines/
// drawTokenLines iterate line-by-line already (see drawAnswer above), so
// slicing a block's `lines` array and recomputing its `height` from the
// slice length is a safe, self-contained split — no re-measuring or
// re-wrapping text is needed, and both the Arabic and non-Arabic line
// representations use the same one-entry-per-visual-line shape.
//
// Returns { firstBlocks, restBlocks }: everything that fits within
// maxHeight goes in firstBlocks (in original order), everything else —
// including the tail of a block that only PARTIALLY fit — goes in
// restBlocks (also in original order). A block only ever gets split
// once, never left with zero lines on either side, so re-drawing either
// half with drawAnswer() never draws an empty/degenerate paragraph.
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

// A mostly-Arabic comparison-table cell previously lost its *highlighted*
// keyword markup entirely (see wrapArabicPlain, which strips asterisks) —
// unlike a mostly-non-Arabic cell/answer, whose highlighted terms DO get
// colored via tokenizeHighlighted+wrapTokens+drawTokenLines. The
// functions below extend that same *term* highlighting to Arabic cells.
//
// A whole-line bidi reorder (shapeArabicLine, used for the plain Arabic
// paragraph path) can't simply be colored per-word afterward: Arabic
// ligatures (e.g. lam-alef) can merge two source characters into one
// presentation glyph, so there's no simple index mapping from the
// reordered visual string back to which original word(s) it came from.
// Instead: split the (already word-wrapped) line into RUNS of consecutive
// same-highlighted-or-not words, shape+bidi-reorder each run on its own
// (correct in isolation), then draw the runs in REVERSED order,
// right-aligned — the first logical run ends up rightmost, the last ends
// up leftmost, matching how the sentence reads right-to-left overall.
// (Verified equivalent to a single whole-line shapeArabicLine call for
// ordinary space-separated Arabic text — reversing the already-shaped
// runs and concatenating them produces the same visual string as shaping
// the full line at once.)
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

// Greedy word-wrap for {word, bold} tokens — same shape as
// wrapWordsByWidth in lib/textShaping.js, but per-word width is measured
// with the bold or regular Arabic font depending on the word's highlight
// state, and wrapping happens on the RAW (unshaped) word, same as the
// plain-Arabic path: shaping/reordering only happens per-line/per-run
// afterwards, once each line's final word set is known.
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

// Groups one wrapped line's words into consecutive same-bold runs
// (preserving reading order), then shapes + bidi-reorders each run's
// joined text on its own.
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

    // Reversed run order == right-to-left reading order (see comment
    // above) — draw left to right through the reversed array so the
    // FIRST logical run lands rightmost.
    const ly = y + i * lineHeight;
    let cx = x + Math.max(0, width - totalWidth);
    [...runs].reverse().forEach((r) => {
      doc.font(r.bold ? FONT_ARABIC_BOLD : FONT_ARABIC_REGULAR).fontSize(size).fillColor(r.bold ? colors.orangeDark : colors.text);
      doc.text(r.shaped, cx, ly, { lineBreak: false });
      cx += r.w + spaceWidth;
    });
  });
}

// Greedy word-wrap for comparison-table column headers. Unlike
// wrapTokens/wrapArabicHighlightedWords, a header cell has no
// bold/plain distinction of its own (drawHeaderCellText draws every
// line in one shot with a single FONT_BOLD call — see below), so this
// returns plain joined-line strings rather than per-word token arrays.
// Each word is still measured with the Greek/symbol fallback font when
// needed (hasGreek) so wrapping widths stay accurate for a header like
// "ΔG" or "→ Product", matching the same fallback used for question/
// answer body text elsewhere in this file.
function wrapBoldGreekWords(doc, words, size, maxWidth) {
  doc.font(FONT_BOLD).fontSize(size);
  const spaceWidth = doc.widthOfString(' ');
  const lines = [];
  let current = [];
  let currentWidth = 0;

  words.forEach((word) => {
    doc.font(hasGreek(word) ? FONT_GREEK_BOLD : FONT_BOLD).fontSize(size);
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
  });
  if (current.length > 0) lines.push(current.join(' '));
  return lines;
}

function measureHeaderCell(doc, text, colWidth) {
  const innerWidth = colWidth - TABLE_CELL_PAD * 2;
  if (isMostlyArabic(text)) {
    const lines = wrapArabicPlain(doc, text, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, innerWidth);
    return { arabic: true, lines, height: Math.max(lines.length, 1) * TABLE_ROW_LINE_H };
  }
  // Comparison-table column headers (e.g. Gemini might label a column
  // "ΔG" or "→ Product") are answer content too — same Greek/symbol
  // fallback as the question/answer body, just kept bold throughout
  // (header cells have no highlighted/plain distinction of their own).
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = wrapBoldGreekWords(doc, words, TABLE_FONT_SIZE, innerWidth);
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
    drawArabicHighlightedLines(doc, colors, cell.lines, innerX, y + TABLE_CELL_PAD, innerWidth, TABLE_FONT_SIZE, TABLE_ROW_LINE_H);
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

// Chapter header — a solid orange banner drawn once, right before the
// first card of a new chapter's set of questions (see the AI extraction
// in lib/questionExtractor.js, which tags each question with the chapter
// name it found immediately preceding it, if any). Consecutive questions
// sharing the same chapter name don't repeat the banner.
//
// The banner used to be a fixed CHAPTER_HEADER_H (38) with lineBreak:
// false, so a chapter title too long for one line at CHAPTER_HEADER_SIZE
// just got silently cut off mid-word (English) or overflowed past the
// banner's edge with no wrap at all (the Arabic branch, which manually
// centered a single shaped line and never checked it against `width`).
// measureChapterHeader() now wraps the title onto as many lines as it
// needs (same greedy-wrap-then-shape approach used for questions/answers
// elsewhere in this file) and returns the resulting box height;
// drawChapterHeader() draws the banner at THAT height instead of the old
// constant, so a two-line — or longer — title gets a taller banner
// instead of getting clipped.
const CHAPTER_HEADER_SIZE = 15;
const CHAPTER_HEADER_LINE_H = 19;
const CHAPTER_HEADER_PAD_Y = 11; // top+bottom breathing room inside the banner
const CHAPTER_HEADER_PAD_X = 16; // left+right inset so wrapped lines don't touch the banner edge
const CHAPTER_HEADER_GAP = 14; // space between the banner and the first card under it

function measureChapterHeader(doc, chapterText, pageContentWidth) {
  const maxTextW = Math.max(10, pageContentWidth - CHAPTER_HEADER_PAD_X * 2);
  const arabic = isMostlyArabic(chapterText);
  const font = arabic ? FONT_ARABIC_BOLD : FONT_BOLD;
  const words = String(chapterText || '').split(/\s+/).filter(Boolean);
  const lines = wrapWordsByWidth(doc, words, font, CHAPTER_HEADER_SIZE, maxTextW);
  const shapedLines = arabic ? lines.map((l) => shapeArabicLine(l)) : lines;
  const textHeight = Math.max(lines.length, 1) * CHAPTER_HEADER_LINE_H;
  const height = textHeight + CHAPTER_HEADER_PAD_Y * 2;
  return { arabic, lines: shapedLines, textHeight, height, maxTextW };
}

function drawChapterHeader(doc, colors, measured, x, y, width) {
  const { arabic, lines, textHeight, height } = measured;
  doc.roundedRect(x, y, width, height, 8).fill(colors.orange);
  const textStartY = y + (height - textHeight) / 2;
  const textX = x + CHAPTER_HEADER_PAD_X;
  const textW = width - CHAPTER_HEADER_PAD_X * 2;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_BOLD).fontSize(CHAPTER_HEADER_SIZE).fillColor(colors.white);
  lines.forEach((line, i) => {
    const w = doc.widthOfString(line);
    const lineY = textStartY + i * CHAPTER_HEADER_LINE_H;
    doc.text(line, textX + Math.max(0, (textW - w) / 2), lineY, { lineBreak: false });
  });
}

// Alternating accent/white squares, e.g. the checkerboard strip framing
// the footer of every page. rowIndex offsets the starting color by one
// square so stacked rows form a true diagonal/interlocking checkerboard
// instead of matching vertical stripes.
function drawCheckerStrip(doc, colors, x, y, width, squareSize, rowIndex = 0, gaps = []) {
  const cols = Math.ceil(width / squareSize);
  doc.save();
  for (let i = 0; i < cols; i++) {
    const sx = x + i * squareSize;
    const sx2 = sx + squareSize;
    // Skip any square that overlaps a gap range so the row appears cut
    // open there (label/page-number text sits in the plain page
    // background instead of on top of a colored square).
    const inGap = gaps.some((g) => sx < g.x2 && sx2 > g.x1);
    if (inGap) continue;
    doc.rect(sx, y, squareSize, squareSize).fill((i + rowIndex) % 2 === 0 ? colors.orange : colors.white);
  }
  doc.restore();
}

// Header: two stacked checkerboard rows — same visual language as the
// footer border, just at the top of the page. No title, no band, no icon.
function drawHeader(doc, colors, pageWidth) {
  drawCheckerStrip(doc, colors, 0, 0, pageWidth, CHECKER_SIZE, 0);
  drawCheckerStrip(doc, colors, 0, CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);
}

// Brand text ("BY M.E.M") and the page number both live inside the
// upper footer checkerboard row. Rather than overlay semi-transparent
// text on top of the squares, the squares that would sit under the text
// are skipped entirely (see drawCheckerStrip's `gaps` param), so the row
// reads as if it's been cut open there, with plain solid text sitting in
// the gap. Kept as a constant (rather than derived from meta.title)
// since it's a fixed brand tag, not per-document content; override via
// meta.footerBrand if a caller ever needs a different tag.
const DEFAULT_FOOTER_BRAND = 'BY M.E.M';
const FOOTER_WATERMARK_SIZE = 30; // sized to comfortably fill a 5-box-wide gap
const FOOTER_PAGE_NUM_SIZE = 13;
const FOOTER_GAP_PAD = 6; // breathing room used only to decide how many boxes the gap needs
const FOOTER_BRAND_GAP_BOXES = 5; // brand gap is always exactly 5 checker boxes wide

// Checkerboard squares strictly alternate orange/white, so the square
// immediately before a gap and the one immediately after only land on
// the SAME color when the gap spans an odd number of boxes (even counts
// flip the parity and put opposite colors on each side). Always sizing
// gaps to an odd box count is what keeps the cut symmetric — no need to
// force colors afterward.
function oddBoxCountFor(width, squareSize) {
  let n = 1;
  while (n * squareSize < width) n += 2;
  return n;
}

// Returns the [x1, x2) grid-aligned gap that is exactly `boxes` checker
// squares wide, positioned as close as possible to the given ideal
// center x-coordinate.
function gridGapCenteredAt(centerX, boxes, squareSize) {
  const startCol = Math.round(centerX / squareSize - boxes / 2);
  return { x1: startCol * squareSize, x2: (startCol + boxes) * squareSize };
}

function drawFooter(doc, colors, pageNum, pageWidth, pageHeight, brand) {
  const checkerY = pageHeight - FOOTER_CHECKER_H;
  const upperRowY = checkerY; // top of the two checkerboard rows

  // Brand wordmark — always a fixed 5-box gap, centered on the page.
  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  const brandW = doc.widthOfString(brandText);
  const brandGap = gridGapCenteredAt(pageWidth / 2, FOOTER_BRAND_GAP_BOXES, CHECKER_SIZE);
  const brandX = brandGap.x1 + ((brandGap.x2 - brandGap.x1) - brandW) / 2;

  // Page number — smallest odd box count that fits it, right-aligned
  // near the usual margin.
  const pageNumText = String(pageNum);
  doc.font(FONT_BOLD).fontSize(FOOTER_PAGE_NUM_SIZE);
  const numW = doc.widthOfString(pageNumText);
  const numBoxes = oddBoxCountFor(numW + FOOTER_GAP_PAD * 2, CHECKER_SIZE);
  const numGap = gridGapCenteredAt(pageWidth - PAGE_MARGIN - numW / 2, numBoxes, CHECKER_SIZE);
  const numX1 = numGap.x1 + ((numGap.x2 - numGap.x1) - numW) / 2;

  // Two checkerboard rows, flush with the bottom edge. CHECKER_SIZE (the
  // square dimensions) is untouched — only the upper row has squares cut
  // out where the brand text / page number sit.
  drawCheckerStrip(doc, colors, 0, checkerY, pageWidth, CHECKER_SIZE, 0, [brandGap, numGap]);
  drawCheckerStrip(doc, colors, 0, checkerY + CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);

  // Text sits in the cut-open gap (plain page background behind it, no
  // squares). Solid fill using the same orange as the checker boxes, so
  // the brand text reads as "colored like the boxes" rather than hollow.
  const brandY = upperRowY + (CHECKER_SIZE - FOOTER_WATERMARK_SIZE) / 2 - 6;
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  doc.fillColor(colors.orange).strokeColor(colors.orangeDark).lineWidth(0.5);
  doc.text(brandText, brandX, brandY, { lineBreak: false, characterSpacing: 1.5, fill: true, stroke: true });

  const numY = upperRowY + (CHECKER_SIZE - FOOTER_PAGE_NUM_SIZE) / 2;
  doc.font(FONT_BOLD).fontSize(FOOTER_PAGE_NUM_SIZE).fillColor(colors.orangeDark);
  doc.text(pageNumText, numX1, numY, { lineBreak: false });
}



// results: [{ question, answer, page, isError, chapter }] — chapter is the
// chapter/section name (or null) that lib/questionExtractor.js's AI-based
// extraction found immediately preceding that question in the original
// input; a banner is drawn before the first question of each new chapter.
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

      // Tracks the most recently drawn chapter banner so consecutive
      // questions sharing the same chapter (r.chapter) don't repeat it —
      // only an actual change to a new, truthy chapter name draws a new
      // banner. Questions with no chapter (null/undefined) just continue
      // under whatever banner (if any) came before them.
      let lastChapter = null;

      results.forEach((r, idx) => {
        if (r.chapter && r.chapter !== lastChapter) {
          // Every chapter header now always opens its own page. If we're
          // not already sitting at the top of a fresh page (e.g. earlier
          // untagged questions, or the previous chapter's cards, are
          // still on this page), force a page break first instead of
          // just checking whether the banner happens to fit where we
          // are. If we ARE already at the top (this is page 1's very
          // first item, or ensureSpace already rolled us onto a new page
          // for the previous card), no extra blank page is inserted.
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

        // Draws the normal, single-page card exactly as before this
        // dynamic-fill feature existed — used both for the common
        // "fits on this page" case and as the fallback whenever
        // splitting isn't possible/worthwhile (comparison tables, or
        // too little space left to make splitting worth it).
        function drawFullCard() {
          ensureSpace(cardHeight + CARD_GAP);
          const cardY = y;
          doc.roundedRect(contentX, cardY, contentWidth, cardHeight, 10).fillAndStroke(colors.cream, colors.border);

          const badgeCx = contentX + CARD_PADDING + BADGE_R;
          const badgeCy = cardY + CARD_PADDING + BADGE_R - 2;
          doc.circle(badgeCx, badgeCy, BADGE_R).fill(colors.orange);
          doc.font(FONT_BOLD).fontSize(12).fillColor(colors.white);
          doc.text(String(idx + 1), badgeCx - BADGE_R, badgeCy - 6, { width: BADGE_R * 2, align: 'center' });

          let curY = cardY + CARD_PADDING;
          drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
          curY += qMeasured.height + 8;

          drawDivider(doc, colors, textColX, curY, textColWidth);
          curY += 12;

          doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.text);
          doc.text('ANSWER:', contentX + CARD_PADDING, curY, { lineBreak: false });
          curY += LABEL_SIZE + 6;

          drawAnswerBody(doc, colors, aBody, contentX + CARD_PADDING, curY, contentWidth - CARD_PADDING * 2);
          curY += aBody.height;

          if (pageNoteText) {
            curY += 4;
            doc.font(FONT_REGULAR).fontSize(9).fillColor(colors.gray);
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
          // permanently blank — the actual cause of pages with only one
          // short question and a lot of empty space below it — see if
          // splitting the answer TEXT itself across the page boundary is
          // worthwhile: draw the question + as much of the answer as
          // fits here, continue the rest at the top of the next page.
          //
          // headerHeight mirrors the exact curY increments drawFullCard
          // uses before the answer body starts (question + 8, divider +
          // 12, label + 6) — how much of a split card's first half is
          // taken up by the non-splittable header (question/divider/
          // label), before any answer-line space.
          const headerHeight = qMeasured.height + 8 + 12 + LABEL_SIZE + 6;
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
            // Plain (non-rounded) box for a split card half — a rounded
            // bottom edge would visually read as "the box closes here",
            // which is misleading when the answer actually continues
            // onto the next page.
            doc.rect(contentX, cardY, contentWidth, firstPartHeight).fillAndStroke(colors.cream, colors.border);

            const badgeCx = contentX + CARD_PADDING + BADGE_R;
            const badgeCy = cardY + CARD_PADDING + BADGE_R - 2;
            doc.circle(badgeCx, badgeCy, BADGE_R).fill(colors.orange);
            doc.font(FONT_BOLD).fontSize(12).fillColor(colors.white);
            doc.text(String(idx + 1), badgeCx - BADGE_R, badgeCy - 6, { width: BADGE_R * 2, align: 'center' });

            let curY = cardY + CARD_PADDING;
            drawQuestion(doc, colors, qMeasured, `Q${idx + 1}: ${r.question}`, textColX, curY, textColWidth);
            curY += qMeasured.height + 8;

            drawDivider(doc, colors, textColX, curY, textColWidth);
            curY += 12;

            doc.font(FONT_BOLD).fontSize(LABEL_SIZE).fillColor(colors.text);
            doc.text('ANSWER:', contentX + CARD_PADDING, curY, { lineBreak: false });
            curY += LABEL_SIZE + 6;

            drawAnswer(doc, colors, { blocks: firstBlocks }, contentX + CARD_PADDING, curY, contentWidth - CARD_PADDING * 2);
            curY += firstAnswerHeight + 4;

            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(colors.gray);
            doc.text(`▾ Q${idx + 1} continues on next page…`, contentX + CARD_PADDING, curY, {
              width: contentWidth - CARD_PADDING * 2,
            });

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
            doc.rect(contentX, cardY2, contentWidth, secondPartHeight).fillAndStroke(colors.cream, colors.border);

            let curY2 = cardY2 + CARD_PADDING;
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(colors.gray);
            doc.text(`↳ Q${idx + 1} (continued):`, contentX + CARD_PADDING, curY2, {
              width: contentWidth - CARD_PADDING * 2,
            });
            curY2 += CONTINUATION_NOTE_H;

            drawAnswer(doc, colors, { blocks: restBlocks }, contentX + CARD_PADDING, curY2, contentWidth - CARD_PADDING * 2);
            curY2 += restAnswerHeight;

            if (pageNoteText) {
              curY2 += 4;
              doc.font(FONT_REGULAR).fontSize(9).fillColor(colors.gray);
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
