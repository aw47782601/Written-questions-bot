// Renders a batch of {question, answer, page, chapter} results as a styled
// PDF — "design_7" (see lib/pdfDesigns.js for the design registry). This
// is a re-skin of design_6's code structure (same feature set, same
// per-question flow/measure/draw plumbing) built to match a second
// reference sheet the user supplied ("TEMPLATE_2.pdf"): a white page, a
// purple "chapter cover" header on page 1 (a big soft-purple decorative
// circle behind a small doodle icon in the top-left corner, with an
// oversized drop-cap "C" + bold indigo "hapter name" heading next to it),
// lavender chevron/ribbon section+chapter banners with a salmon arrow
// notch on the left (the reference's "COMPLETE" / "WRITTEN QS" /
// "COMPARE QS" banners), red bold category labels, green checkmark
// bullet items, a pale-yellow highlight chip for callout headings, and a
// plain bold page number centered on a light-gray wavy band at the very
// bottom of the page (the reference has no footer brand text on page 1 —
// just the number).
//
// Per-question layout is *unboxed*, same as design_6: no card/border
// around each question+answer pair, separated only by vertical gap
// (CARD_GAP) and a thin purple-accented divider between the question and
// its answer. Each question renders inside its own pale-yellow highlight
// chip, matching the reference's yellow callout-bar headings (e.g. "No
// role of using enhancement of elimination").
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
const { isMostlyArabic, hasGreek, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
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

// Neither Adlam Display, Fraunces, nor Tajawal/Noto Naskh carry Greek
// letters (α β γ ...) or the arrows/math-operator symbol ranges (→ ↑ ↓
// ← ± × ÷ ≤ ≥ √ ∞ ∑ ...) — confirmed via font cmap inspection, same as
// the other designs (see lib/pdfGenerator.js's FONT_GREEK comment).
// Without this fallback, any question or answer using those symbols
// silently drew as a blank/missing-glyph box. Lato has the widest
// coverage of the bundled fonts for these ranges, so it's registered
// here purely as a per-word fallback — see tokenFont()/questionTokenFont()
// below and hasGreek()'s definition in textShaping.js for exactly which
// ranges trigger it.
const FONT_GREEK_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_GREEK_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_GREEK_REGULAR = 'Lato-Regular';
const FONT_GREEK_BOLD = 'Lato-Bold';

// None of the above (nor Fraunces/AdlamDisplay) carry a ✓ (U+2713)
// glyph either — confirmed via font cmap inspection. Spectral is the
// only bundled font that does, so it's registered purely as the
// checkmark glyph fallback for the "√ "/"✓ " answer-bullet style and
// the Note-box checkbox tick (see FONT_CHECK usages below).
const FONT_CHECK_PATH = path.join(__dirname, '../assets/fonts/Spectral-Bold.ttf');
const FONT_CHECK = 'Spectral-Bold';

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 40;

// Requested type sizes: headline face at 18pt, body face at 14pt.
const HEADING_SIZE = 18;
const BODY_SIZE = 14;

// Fixed reference-sheet palette (TEMPLATE_2.pdf) — a clean white page, a
// red accent for badges/category labels/underlined key terms, a purple
// accent (chapter-cover circle, chevron banners, dividers) with a salmon
// chevron-notch accent, a soft yellow highlight chip, a green checkmark,
// and a plain page number on a light-gray wavy footer band. Deliberately
// NOT derived from meta.colorKey the way design_1–design_5 derive their
// single accent — the reference sheet is a fixed multi-accent brand look,
// not a single hue that can be re-tinted.
const PAGE_BG = '#FFFFFF';
const CARD_BG = '#FFFFFF';
const CARD_BORDER = '#E4DDF2';
const TEXT_INK = '#232323';
const TEXT_GRAY = '#7A7167';

const RED = '#C0272D';
const RED_DARK = '#8E1D22';
// "TEAL"/"TEAL_DARK" names kept (rather than renamed to PURPLE) so every
// downstream reference below — banners, dividers, table headers, the
// ANSWER label — repaints purple without needing its own find/replace.
const TEAL = '#8E5FD1';
const TEAL_DARK = '#3D1E66';
const YELLOW_BG = '#FFF3B0';
const YELLOW_BORDER = '#EBD97A';
const GREEN = '#2F8F46';
const CHEVRON_NOTCH = '#F5A3A0';
const HERO_CIRCLE = '#C9A9F5';
const HERO_TITLE_COLOR = '#3D1E66';
const FOOTER_WAVE_BG = '#E3E3E3';

const HEADER_H = 14;
const PAGE_CONTENT_TOP = HEADER_H + 16;

const FOOTER_H = 46;

const CARD_PADDING = 18;
const CARD_GAP = 16;
const CARD_RADIUS = 10;
const BADGE_COL_W = 34;
const QUESTION_SIZE = HEADING_SIZE;
const LABEL_SIZE = 9.5;
const ANSWER_SIZE = BODY_SIZE;
const LINE_HEIGHT_Q = 22;
const LINE_HEIGHT_A = 19;

// Chapter-cover header (drawn once, at the top of page 1, when meta.title
// is given) — the reference sheet's big purple decorative circle + doodle
// icon in the top-left corner with an oversized drop-cap "C" + bold
// indigo title text beside/below it.
const HERO_BAND_H = 150;
const HERO_CIRCLE_D = 190;
const HERO_DROPCAP_SIZE = 92;
const HERO_TITLE_SIZE = 34;

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
        tokens.push({ text: words[i], shaped: words[i], arabic: false, greek: hasGreek(words[i]), bold });
        i++;
      }
    }
  });
  return tokens;
}

function tokenFont(tok) {
  if (tok.arabic) return FONT_ARABIC_REGULAR;
  if (tok.greek) return tok.bold ? FONT_GREEK_BOLD : FONT_GREEK_REGULAR;
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

// Highlighted (*bold*) inline terms render in the red accent, underlined
// — matching the reference sheet's red underlined key-term styling
// ("hunger", "satiety") inside body copy.
function drawTokenLines(doc, lines, x, y, size, lineHeight) {
  lines.forEach((line, i) => {
    let cx = x;
    const ly = y + i * lineHeight;
    line.forEach((tok) => {
      doc.font(tokenFont(tok)).fontSize(size);
      const spaceWidth = doc.widthOfString(' ');
      const tokW = doc.widthOfString(tok.shaped);
      doc.fillColor(tok.bold ? RED : TEXT_INK);
      doc.text(tok.shaped, cx, ly, { lineBreak: false });
      if (tok.bold) {
        doc.save();
        doc.strokeColor(RED).lineWidth(1);
        doc.moveTo(cx, ly + size + 1).lineTo(cx + tokW, ly + size + 1).stroke();
        doc.restore();
      }
      cx += tokW + spaceWidth;
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

// Question text renders as plain text with a pale-yellow highlighter
// strip drawn behind each line (tight to that line's own text width,
// no border, no full-width box) — a marker-pen callout rather than a
// filled chip. Measurement still returns fixed wrapped lines (not
// doc.heightOfString), the same way the 'highlight' answer-paragraph
// blocks above do, since the padding constants are reused for layout
// spacing even though drawQuestion no longer paints a box with them.
const QUESTION_CHIP_PAD_X = 12;
const QUESTION_CHIP_PAD_Y = 9;

// Question-text tokenizer — same Arabic-run-grouping + Greek/symbol
// fallback as tokenizeHighlighted above, minus the *highlight* markup
// parsing (a question has no bold/plain distinction of its own — every
// word draws in the same RED_DARK color and FONT_HEADING weight, except
// for the Arabic/Greek font swap below).
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
      tokens.push({ text: joined, shaped: shapeArabicLine(joined), arabic: true });
      i = j;
    } else {
      tokens.push({ text: words[i], shaped: words[i], arabic: false, greek: hasGreek(words[i]) });
      i++;
    }
  }
  return tokens;
}

function questionTokenFont(tok) {
  if (tok.arabic) return FONT_ARABIC_BOLD;
  if (tok.greek) return FONT_GREEK_BOLD;
  return FONT_HEADING;
}

function wrapQuestionTokens(doc, tokens, size, maxWidth) {
  doc.font(FONT_HEADING).fontSize(size);
  const spaceWidth = doc.widthOfString(' ');
  const lines = [];
  let current = [];
  let currentWidth = 0;

  tokens.forEach((tok) => {
    doc.font(questionTokenFont(tok)).fontSize(size);
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

// Total rendered width of one wrapped question line, measured per-token
// (a line can mix FONT_HEADING/FONT_GREEK_BOLD/FONT_ARABIC_BOLD tokens),
// so the highlight strip drawn behind it is sized correctly.
function questionLineWidth(doc, line, size) {
  const spaceWidth = doc.font(FONT_HEADING).fontSize(size).widthOfString(' ');
  let w = 0;
  line.forEach((tok, i) => {
    doc.font(questionTokenFont(tok)).fontSize(size);
    w += doc.widthOfString(tok.shaped);
    if (i < line.length - 1) w += spaceWidth;
  });
  return w;
}

function measureQuestion(doc, question, width) {
  const innerWidth = width - QUESTION_CHIP_PAD_X * 2;
  if (isMostlyArabic(question)) {
    const lines = wrapArabicPlain(doc, question, FONT_ARABIC_BOLD, QUESTION_SIZE, innerWidth);
    return { arabic: true, lines, height: lines.length * LINE_HEIGHT_Q + QUESTION_CHIP_PAD_Y * 2 };
  }
  // Per-word Arabic-run/Greek-symbol fallback (see tokenizeQuestionWords)
  // instead of a single flat wrapWordsByWidth(FONT_HEADING) call, so
  // α β γ / → ± × ÷ etc. inside a question no longer draw as a blank
  // missing-glyph box (neither Fraunces nor Adlam Display carry them).
  const tokens = tokenizeQuestionWords(question);
  const lines = wrapQuestionTokens(doc, tokens, QUESTION_SIZE, innerWidth);
  return { arabic: false, lines, height: Math.max(lines.length, 1) * LINE_HEIGHT_Q + QUESTION_CHIP_PAD_Y * 2 };
}

// Highlighter pad — how far the yellow strip extends past the text's
// own bounding box on each side, so it reads as a marker stroke behind
// the words rather than a drawn box.
const QUESTION_HILITE_PAD_X = 4;
const QUESTION_HILITE_PAD_Y = 2;

function drawQuestion(doc, measured, x, y, width) {
  const textX = x + QUESTION_CHIP_PAD_X;
  const textY = y + QUESTION_CHIP_PAD_Y;
  const innerWidth = width - QUESTION_CHIP_PAD_X * 2;

  if (measured.arabic) {
    // Right-aligned per line (matching drawArabicLines' own alignment),
    // so the highlight strip has to be measured per line rather than
    // drawn as one full-width band.
    doc.font(FONT_ARABIC_BOLD).fontSize(QUESTION_SIZE);
    doc.save();
    doc.fillColor(YELLOW_BG);
    measured.lines.forEach((line, i) => {
      const shaped = shapeArabicLine(line);
      const w = doc.widthOfString(shaped);
      const lx = textX + Math.max(0, innerWidth - w);
      const ly = textY + i * LINE_HEIGHT_Q;
      doc.rect(
        lx - QUESTION_HILITE_PAD_X,
        ly - QUESTION_HILITE_PAD_Y,
        w + QUESTION_HILITE_PAD_X * 2,
        QUESTION_SIZE + QUESTION_HILITE_PAD_Y * 2
      ).fill();
    });
    doc.restore();
    drawArabicLines(doc, measured.lines, textX, textY, innerWidth, FONT_ARABIC_BOLD, QUESTION_SIZE, LINE_HEIGHT_Q, RED_DARK);
  } else {
    // Highlight strip first — one rect per line, sized to that line's
    // actual (per-token) rendered width.
    doc.save();
    doc.fillColor(YELLOW_BG);
    measured.lines.forEach((line, i) => {
      const w = questionLineWidth(doc, line, QUESTION_SIZE);
      const ly = textY + i * LINE_HEIGHT_Q;
      doc.rect(
        textX - QUESTION_HILITE_PAD_X,
        ly - QUESTION_HILITE_PAD_Y,
        w + QUESTION_HILITE_PAD_X * 2,
        QUESTION_SIZE + QUESTION_HILITE_PAD_Y * 2
      ).fill();
    });
    doc.restore();

    // Then the text itself, token by token, so each word can use its
    // own font (heading / Greek-fallback / Arabic) while staying
    // uniformly RED_DARK.
    measured.lines.forEach((line, i) => {
      let cx = textX;
      const ly = textY + i * LINE_HEIGHT_Q;
      line.forEach((tok) => {
        doc.font(questionTokenFont(tok)).fontSize(QUESTION_SIZE).fillColor(RED_DARK);
        const spaceWidth = doc.widthOfString(' ');
        doc.text(tok.shaped, cx, ly, { lineBreak: false });
        cx += doc.widthOfString(tok.shaped) + spaceWidth;
      });
    });
  }
}

// Bullet markers a line can start with, mirroring TEMPLATE_2.pdf's list
// styles:
//   "» " / "> "  -> category label line (red circled-arrow bullet, bold
//                   red text).
//   "✓ " / "√ "  -> checkmark item (green check, plain text) — the
//                   reference's "√ Atropine" style lines.
//   "# "         -> a dashed-border "Note" callout box (checkbox + text)
//                   — the reference's yellow "Note" speech-bubble boxes.
//   "- " / "• " / "■ " -> plain sub-bullet (solid black square) — the
//                   reference's "■ The person usually loses..." lines.
const CATEGORY_RE = /^[»>]\s+/;
const CHECK_RE = /^[✓√]\s+/;
const HIGHLIGHT_RE = /^#\s+/;
const BULLET_RE = /^[-•■]\s+/;
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

const NOTE_PAD_X = 16;
const NOTE_TOP_MARGIN = 12;
const NOTE_PAD_Y_TOP = 32;
const NOTE_PAD_Y_BOTTOM = 14;
const NOTE_TAG_W = 54;
const NOTE_TAG_H = 22;
const NOTE_CHECK_SIZE = 14;
const NOTE_BG = '#FCEFC7';
const NOTE_BORDER = '#3A2A55';
const NOTE_TAG_BG = '#F2A93B';

// The "# " block renders as a dashed-border "Note" callout box — a
// pale-yellow speech-bubble with a small "Note" tag chip and a
// checkbox + text line — the direct match for TEMPLATE_2.pdf's
// "Satiety center and hunger center work in different mechanisms"
// note boxes. NOTE_TOP_MARGIN pads the reported height so the tag
// chip (which pokes above the box's own top edge) never collides with
// whatever paragraph came before it.
function measureAnswer(doc, answer, width) {
  const paragraphs = splitParagraphs(answer);
  const blocks = paragraphs.map((raw) => {
    const { kind, text: p } = classifyParagraph(raw);
    const indent = kind === 'bullet' || kind === 'check' ? BULLET_INDENT : 0;
    const innerWidth = width - indent;

    if (kind === 'highlight') {
      const words = String(p).replace(/\*/g, '').split(/\s+/).filter(Boolean);
      const textMaxWidth = width - NOTE_PAD_X * 2 - NOTE_CHECK_SIZE - 10;
      const lines = wrapWordsByWidth(doc, words, FONT_BOLD, ANSWER_SIZE, textMaxWidth);
      const h = NOTE_TOP_MARGIN + NOTE_PAD_Y_TOP + lines.length * LINE_HEIGHT_A + NOTE_PAD_Y_BOTTOM;
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
      const boxY = cy + NOTE_TOP_MARGIN;
      const h = b.height - NOTE_TOP_MARGIN;

      doc.save();
      doc.roundedRect(x, boxY, w, h, 10).fill(NOTE_BG);
      doc.dash(4, { space: 3 });
      doc.strokeColor(NOTE_BORDER).lineWidth(1.2);
      doc.roundedRect(x, boxY, w, h, 10).stroke();
      doc.undash();
      doc.restore();

      // "Note" tag chip, top-left, overlapping the dashed border.
      const tagX = x + 14;
      const tagY = boxY - 8;
      doc.save();
      doc.roundedRect(tagX, tagY, NOTE_TAG_W, NOTE_TAG_H, 5).fill(NOTE_TAG_BG);
      doc.strokeColor(NOTE_BORDER).lineWidth(1);
      doc.roundedRect(tagX, tagY, NOTE_TAG_W, NOTE_TAG_H, 5).stroke();
      doc.restore();
      doc.font(FONT_BOLD).fontSize(10).fillColor(NOTE_BORDER);
      doc.text('Note', tagX, tagY + (NOTE_TAG_H - 10) / 2, { width: NOTE_TAG_W, align: 'center', lineBreak: false });

      // Checkbox + note text. The checkmark glyph is drawn with
      // FONT_CHECK (Spectral) — none of the other bundled faces carry
      // a ✓ glyph (see the FONT_CHECK comment near the top of the
      // file).
      const checkX = x + NOTE_PAD_X;
      const checkY = boxY + NOTE_PAD_Y_TOP;
      doc.save();
      doc.strokeColor(NOTE_BORDER).lineWidth(1.3);
      doc.rect(checkX, checkY, NOTE_CHECK_SIZE, NOTE_CHECK_SIZE).stroke();
      doc.font(FONT_CHECK).fontSize(11).fillColor(NOTE_BORDER);
      doc.text('\u2713', checkX + 1.5, checkY - 1, { lineBreak: false });
      doc.restore();

      const textX = checkX + NOTE_CHECK_SIZE + 10;
      doc.font(FONT_BOLD).fontSize(ANSWER_SIZE).fillColor(TEXT_INK);
      b.lines.forEach((line, i) => {
        doc.text(line, textX, checkY - 1 + i * LINE_HEIGHT_A, { lineBreak: false });
      });

      cy += b.height + PARA_GAP;
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
        // Solid black/ink square bullet — matching the reference
        // sheet's "■ The person usually loses..." list marker.
        doc.save();
        doc.fillColor(TEXT_INK);
        doc.rect(x, cy + 4, 6, 6).fill();
        doc.restore();
      } else if (b.kind === 'check') {
        // Checkmark glyph via FONT_CHECK (Spectral) — see the
        // FONT_CHECK comment near the top of the file.
        doc.save();
        doc.font(FONT_CHECK).fontSize(ANSWER_SIZE).fillColor(GREEN);
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
// Comparison tables — TEMPLATE_2.pdf's "COMPARE QS" grid: a solid
// purple header row with white text, square black-bordered grid lines,
// and a shaded lavender first ("aspect") column running the full
// height of the table.
// ---------------------------------------------------------------------
const TABLE_FONT_SIZE = 9.5;
const TABLE_ROW_LINE_H = 13;
const TABLE_CELL_PAD = 6;
const TABLE_HEADER_GAP = 0;

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
      const isRed = forceRed || r.bold;
      doc.font(FONT_ARABIC_REGULAR).fontSize(size).fillColor(isRed ? RED : TEXT_INK);
      doc.text(r.shaped, cx, ly, { lineBreak: false });
      if (r.bold && !forceRed) {
        doc.save();
        doc.strokeColor(RED).lineWidth(1);
        doc.moveTo(cx, ly + size + 1).lineTo(cx + r.w, ly + size + 1).stroke();
        doc.restore();
      }
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
  const totalH = measured.height;

  // Square-corner grid table with solid black borders and a shaded
  // first ("aspect") column running the full height — the direct
  // match for the reference sheet's "COMPARE QS" table.
  doc.rect(x, y, width, totalH).fill(CARD_BG);

  doc.rect(x, y, width, headerHeight).fill(TEAL);
  let cx = x;
  headerCells.forEach((cell, i) => {
    drawHeaderCellText(doc, cell, cx, y, colWidths[i]);
    cx += colWidths[i];
  });

  let ry = y + headerHeight + TABLE_HEADER_GAP;
  bodyRows.forEach((row) => {
    let rx = x;
    row.cells.forEach((cell, i) => {
      doc.rect(rx, ry, colWidths[i], row.height).fill(i === 0 ? HERO_CIRCLE : CARD_BG);
      drawBodyCellText(doc, cell, rx, ry, colWidths[i]);
      rx += colWidths[i];
    });
    ry += row.height;
  });

  doc.save();
  doc.strokeColor('#000000').lineWidth(1.3);
  doc.rect(x, y, width, totalH).stroke();
  let gx = x;
  colWidths.forEach((cw, i) => {
    gx += cw;
    if (i < colWidths.length - 1) {
      doc.moveTo(gx, y).lineTo(gx, y + totalH).stroke();
    }
  });
  let gy = y + headerHeight;
  doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
  bodyRows.forEach((row) => {
    gy += row.height;
    doc.moveTo(x, gy).lineTo(x + width, gy).stroke();
  });
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
// full content width, a lavender chevron/ribbon banner with a salmon
// arrow-notch cut into its left edge — the direct match for the
// reference sheet's "COMPLETE" / "WRITTEN QS" / "COMPARE QS" banners.
const CHAPTER_HEADER_SIZE = HEADING_SIZE - 2;
const CHAPTER_HEADER_MIN_SIZE = 9;
const CHAPTER_HEADER_PAD_X = 24;
const CHAPTER_HEADER_H = 40;
const CHAPTER_HEADER_NOTCH_W = 46;
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
  const maxTextW = pageContentWidth - CHAPTER_HEADER_PAD_X * 2 - CHAPTER_HEADER_NOTCH_W;
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

  // capsuleW/capsuleH names kept for call-site compatibility with the
  // shared per-question loop below (see `chMeasured.capsuleH`) — here
  // they describe the full-width ribbon banner's box, not a shrink-to-
  // fit pill.
  const capsuleW = pageContentWidth;
  const capsuleH = CHAPTER_HEADER_H;
  return { arabic, fitted, capsuleW, capsuleH };
}

function drawChapterHeader(doc, measured, pageContentX, y, pageContentWidth) {
  const { arabic, fitted } = measured;
  const barH = CHAPTER_HEADER_H;
  const barW = pageContentWidth;
  const barX = pageContentX;
  const radius = 8;

  // Lavender ribbon bar, full content width.
  doc.roundedRect(barX, y, barW, barH, radius).fill(TEAL);

  // Salmon chevron/arrow notch on the left edge — an arrow-tipped flag
  // shape overlapping the bar's left end, matching the reference
  // sheet's "COMPLETE" / "WRITTEN QS" banner accent.
  const notchW = CHAPTER_HEADER_NOTCH_W;
  const tipX = barX + notchW;
  doc.save();
  doc.moveTo(barX + radius, y)
    .lineTo(tipX, y)
    .lineTo(tipX + 14, y + barH / 2)
    .lineTo(tipX, y + barH)
    .lineTo(barX + radius, y + barH)
    .lineTo(barX, y + barH - radius)
    .lineTo(barX, y + radius)
    .closePath()
    .fill(CHEVRON_NOTCH);
  doc.strokeColor('#2A1A40').lineWidth(1.2);
  doc.moveTo(tipX, y).lineTo(tipX + 14, y + barH / 2).lineTo(tipX, y + barH).stroke();
  doc.restore();

  const textAreaX = barX + notchW + 14;
  const textAreaW = barW - notchW - 14 - CHAPTER_HEADER_PAD_X;
  const textY = y + (barH - fitted.size) / 2 - 1;
  doc.font(arabic ? FONT_ARABIC_BOLD : FONT_HEADING).fontSize(fitted.size).fillColor(HERO_TITLE_COLOR);
  doc.text(fitted.text, textAreaX, textY, {
    width: textAreaW,
    align: 'center',
    lineBreak: false,
    ...(arabic ? {} : { characterSpacing: 0.3 }),
  });
}

// Header — intentionally blank (no hairline, no running title): the
// reference sheet has no page header, just content starting at the
// margin, with everything communicated via the section pills instead.
function drawHeader() {}

// Footer — a light-gray wavy band spanning the full page width at the
// very bottom, with a bold page number centered on it and the fixed
// "Victorio Team" brand label on the left (the reference sheet itself
// carries no footer brand text, but the user asked for it here — unlike
// design_6, this always shows the same fixed label; meta.footerBrand is
// not wired up).
const WAVE_AMPLITUDE = 10;

const DEFAULT_FOOTER_BRAND = 'Victorio Team';

function drawFooter(doc, pageNum, pageWidth, pageHeight) {
  const waveTop = pageHeight - FOOTER_H;
  doc.save();
  doc.moveTo(0, waveTop + WAVE_AMPLITUDE);
  doc.bezierCurveTo(
    pageWidth * 0.25, waveTop - WAVE_AMPLITUDE,
    pageWidth * 0.75, waveTop + WAVE_AMPLITUDE * 2,
    pageWidth, waveTop
  );
  doc.lineTo(pageWidth, pageHeight);
  doc.lineTo(0, pageHeight);
  doc.closePath();
  doc.fill(FOOTER_WAVE_BG);
  doc.restore();

  const rowY = pageHeight - FOOTER_H / 2 - 6;

  doc.font(FONT_BOLD).fontSize(10).fillColor(TEXT_GRAY);
  doc.text(DEFAULT_FOOTER_BRAND, PAGE_MARGIN, rowY, { lineBreak: false });

  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(16).fillColor(TEXT_INK);
  const pw = doc.widthOfString(pageNumText);
  doc.text(pageNumText, pageWidth / 2 - pw / 2, pageHeight - FOOTER_H / 2 - 8, { lineBreak: false });
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

// Small decorative open-book doodle drawn with basic vector curves —
// an original stand-in for the reference sheet's stationery clip-art
// icon (that exact raster icon isn't something we can license/ship, so
// this is a hand-drawn approximation of the same "school supplies"
// motif sitting on the purple circle).
function drawDoodleIcon(doc, cx, cy) {
  const w = 62;
  const h = 30;
  const x = cx - w / 2;
  const y = cy - h / 2 + 6;
  doc.save();
  doc.lineWidth(1.6).strokeColor('#2A1A40');
  doc.moveTo(x + w / 2, y + 6)
    .quadraticCurveTo(x, y - 8, x, y + h)
    .quadraticCurveTo(x + w / 2 - 4, y + h - 8, x + w / 2, y + h + 8)
    .closePath()
    .fillAndStroke('#FFFFFF', '#2A1A40');
  doc.moveTo(x + w / 2, y + 6)
    .quadraticCurveTo(x + w, y - 8, x + w, y + h)
    .quadraticCurveTo(x + w / 2 + 4, y + h - 8, x + w / 2, y + h + 8)
    .closePath()
    .fillAndStroke('#FFFFFF', '#2A1A40');
  doc.moveTo(x + w / 2, y + 6).lineTo(x + w / 2, y + h + 8).stroke();
  doc.restore();
}

// Chapter-cover header — drawn once, at the top of page 1, when
// meta.title is given: a big soft-purple circle bleeding off the
// top-left corner with a small doodle icon on it, and the title set as
// an oversized drop-cap first letter followed by the rest of the title
// in bold indigo — a direct match for the reference sheet's cover-page
// treatment ("Chapter name" with a giant "C").
function drawHero(doc, title, pageWidth) {
  const circleCx = 78;
  const circleCy = 74;
  const circleR = HERO_CIRCLE_D / 2;

  doc.save();
  doc.fillColor(HERO_CIRCLE);
  doc.circle(circleCx, circleCy, circleR).fill();
  doc.restore();

  drawDoodleIcon(doc, circleCx, circleCy - 8);

  const safeTitle = String(title || 'Chapter name').trim() || 'Chapter name';
  const firstChar = safeTitle.charAt(0);
  const rest = safeTitle.slice(1);

  const textLeft = circleCx + circleR - 18;
  const baselineY = HERO_BAND_H - 38;

  doc.font(FONT_HEADING).fontSize(HERO_DROPCAP_SIZE).fillColor(HERO_TITLE_COLOR);
  doc.text(firstChar, textLeft, baselineY - HERO_DROPCAP_SIZE + 20, { lineBreak: false });
  const capW = doc.widthOfString(firstChar);

  const restX = textLeft + capW + 6;
  const maxRestW = pageWidth - restX - PAGE_MARGIN;
  let restSize = HERO_TITLE_SIZE;
  doc.font(FONT_HEADING).fontSize(restSize);
  let restW = doc.widthOfString(rest);
  while (restW > maxRestW && restSize > 14) {
    restSize -= 1;
    restW = doc.fontSize(restSize).widthOfString(rest);
  }
  doc.font(FONT_HEADING).fontSize(restSize).fillColor(HERO_TITLE_COLOR);
  doc.text(rest, restX, baselineY - restSize + 8, { width: maxRestW, lineBreak: false });
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
      doc.registerFont(FONT_GREEK_REGULAR, FONT_GREEK_REGULAR_PATH);
      doc.registerFont(FONT_GREEK_BOLD, FONT_GREEK_BOLD_PATH);
      doc.registerFont(FONT_CHECK, FONT_CHECK_PATH);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentX = PAGE_MARGIN;
      const contentWidth = pageWidth - PAGE_MARGIN * 2;

      // When every result shares the same single chapter (or no chapter
      // grouping was used at all), the page-1 hero shows that chapter's
      // title instead of the generic "Chapter name" — there's no point
      // repeating the chapter name in its own banner right below a hero
      // that just says the brand name.
      const uniqueChapters = Array.from(new Set(results.map((r) => r.chapter).filter(Boolean)));
      const heroTitle = uniqueChapters.length === 1 ? uniqueChapters[0] : (meta.title || 'Chapter name');
      // With a single chapter, its name is already shown in the page-1
      // hero above — the per-chapter banner pill would just repeat it,
      // so skip drawing that banner entirely in this case.
      const singleChapterMode = uniqueChapters.length === 1;

      let pageNum = 1;
      let y;
      let heroDrawnOnPage1 = false;

      function startPage() {
        doc.rect(0, 0, pageWidth, pageHeight).fill(PAGE_BG);
        drawHeader();
        if (pageNum === 1 && meta.title && !heroDrawnOnPage1) {
          // Design 7's first-page hero shows meta.title (falling back
          // to "Chapter name") as the drop-cap cover title. When the
          // whole batch is a single chapter, heroTitle
          // is that chapter's own title instead (see above).
          drawHero(doc, heroTitle, pageWidth);
          heroDrawnOnPage1 = true;
          y = HERO_BAND_H + 18;
        } else {
          y = PAGE_CONTENT_TOP;
        }
      }

      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) {
          drawFooter(doc, pageNum, pageWidth, pageHeight);
          doc.addPage();
          pageNum += 1;
          startPage();
        }
      }

      startPage();

      let lastChapter = null;

      results.forEach((r, idx) => {
        if (r.chapter && r.chapter !== lastChapter) {
          if (singleChapterMode) {
            // Already shown as the page-1 hero title — just track it so
            // this branch doesn't re-trigger for the same chapter.
            lastChapter = r.chapter;
          } else {
            if (y > PAGE_CONTENT_TOP && !(pageNum === 1 && heroDrawnOnPage1 && y <= HERO_BAND_H + 20)) {
              drawFooter(doc, pageNum, pageWidth, pageHeight);
              doc.addPage();
              pageNum += 1;
              startPage();
            }
            const chMeasured = measureChapterHeader(doc, r.chapter, contentWidth);
            drawChapterHeader(doc, chMeasured, contentX, y, contentWidth);
            y += chMeasured.capsuleH + CHAPTER_HEADER_GAP;
            lastChapter = r.chapter;
          }
        }

        // No per-question box/card anymore — content flows directly on
        // the page background, the way the reference sheet reads as one
        // continuous page rather than boxed cards. The badge sits to the
        // left; the yellow question chip and the answer share one left
        // edge just past it.
        const textColX = contentX + BADGE_COL_W;
        const textColWidth = contentWidth - BADGE_COL_W;
        const fullTextWidth = textColWidth;
        const answerX = textColX;

        const qMeasured = measureQuestion(doc, `Q${idx + 1}: ${r.question}`, textColWidth);
        const aBody = measureAnswerBody(doc, r, fullTextWidth);
        const pageNoteText = r.page ? `(page ${r.page})` : null;

        const itemHeight =
          qMeasured.height +
          10 +
          12 +
          LABEL_SIZE +
          8 +
          aBody.height +
          (pageNoteText ? 16 : 0) +
          4;

        function drawFullItem() {
          ensureSpace(itemHeight + CARD_GAP);
          const itemY = y;

          drawBadge(doc, idx, contentX, itemY + 3);

          let curY = itemY;
          drawQuestion(doc, qMeasured, textColX, curY, textColWidth);
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
            doc.text(pageNoteText, textColX + textColWidth - w, curY, { lineBreak: false });
          }

          y = itemY + itemHeight + CARD_GAP;
        }

        const availableOnPage = pageHeight - FOOTER_H - 14 - y;

        if (itemHeight <= availableOnPage || aBody.kind !== 'text') {
          drawFullItem();
        } else {
          const headerHeight = qMeasured.height + 10 + 12 + LABEL_SIZE + 8;
          const spaceForAnswerHere = availableOnPage - headerHeight - CONTINUATION_NOTE_H - 6;

          const { firstBlocks, restBlocks } =
            spaceForAnswerHere >= MIN_SPLIT_ANSWER_LINES * LINE_HEIGHT_A
              ? splitAnswerBlocksForHeight(aBody.measured.blocks, spaceForAnswerHere)
              : { firstBlocks: [], restBlocks: [] };

          if (firstBlocks.length === 0 || restBlocks.length === 0) {
            drawFullItem();
          } else {
            const firstAnswerHeight =
              firstBlocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, firstBlocks.length - 1);

            const itemY = y;
            drawBadge(doc, idx, contentX, itemY + 3);

            let curY = itemY;
            drawQuestion(doc, qMeasured, textColX, curY, textColWidth);
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

            drawFooter(doc, pageNum, pageWidth, pageHeight);
            doc.addPage();
            pageNum += 1;
            startPage();

            const restAnswerHeight =
              restBlocks.reduce((sum, b) => sum + b.height, 0) + PARA_GAP * Math.max(0, restBlocks.length - 1);

            const itemY2 = y;
            let curY2 = itemY2;
            doc.font(FONT_REGULAR).fontSize(8.5).fillColor(TEXT_GRAY);
            doc.text(`↳ Q${idx + 1} (continued):`, answerX, curY2, { width: fullTextWidth });
            curY2 += CONTINUATION_NOTE_H;

            drawAnswer(doc, { blocks: restBlocks }, answerX, curY2, fullTextWidth);
            curY2 += restAnswerHeight;

            if (pageNoteText) {
              curY2 += 4;
              doc.font(FONT_REGULAR).fontSize(9).fillColor(TEXT_GRAY);
              const w = doc.widthOfString(pageNoteText);
              doc.text(pageNoteText, textColX + textColWidth - w, curY2, { lineBreak: false });
            }

            y = itemY2 + (curY2 - itemY2) + CARD_GAP;
          }
        }
      });

      drawFooter(doc, pageNum, pageWidth, pageHeight);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateAnswersPdf };
