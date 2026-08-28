// Renders an MCQ bank as a styled PDF: a cover band, a "how to read this
// bank" legend, one page per chapter (each chapter's questions as numbered
// cards, followed by a striped answer-key table), with header/footer
// checkerboard chrome on every page.
//
// This is a port of the exam-bank design built in converter.py + the Jinja
// template it renders (HTML/CSS via Playwright+Chromium, then a PyMuPDF
// pass stamps the checkerboard header/footer bands + page numbers on top).
// This file reproduces that same visual design with PDFKit drawing calls
// instead of an HTML engine — there's no headless-browser dependency in
// this bot (see package.json), so the HTML/CSS template can't be rendered
// directly; every box, badge, and table row below is the hand-drawn
// equivalent of one of that template's CSS rules. Pixel-for-pixel parity
// isn't possible across two different rendering engines, but every
// section, color rule, and pagination behavior in the template is
// reproduced: cover band, how-to legend, per-chapter page breaks,
// subchapter dividers, question cards with an overflowing number badge,
// VIP tags, flag notes, and a post-chapter answer-key table with
// alternating rows and subchapter divider rows.
//
// Two deliberate departures from a literal 1:1 port, both explained where
// they're used below:
//   1. Icons in the "how to read this bank" legend and the flag note are
//      drawn as vector shapes (circles, a star, a warning triangle)
//      instead of the template's Unicode symbols (①⭐📖⚠), because emoji
//      aren't guaranteed to exist in the bundled TTFs — same reasoning the
//      rest of this codebase already uses for e.g. drawing the MCQ
//      correct-answer checkmark as a stroked path rather than a '✓' glyph.
//   2. Latin body/heading text uses Lato instead of this file's old
//      ComicNeue — the template's design is a clean, professional
//      exam-bank look (not the old "M.E.M design" cartoon style), and Lato
//      is the closer match to the template's own "Segoe UI, Tahoma, Arial"
//      font stack. Arabic stays on NotoNaskhArabic (see the Fonts section
//      below for why Tajawal doesn't work with this codebase's shaping
//      pipeline). The checkerboard footer keeps Fredoka-Bold for the
//      "BY M.E.M" wordmark, matching converter.py's own stamping step,
//      which also stamps that brand in Fredoka.
//
// This file deliberately does NOT require('./pdfGenerator'), same as
// before: it's standalone so this design can evolve independently.
//
// Input shape (see the /json_mcq command in api/telegram-webhook.js, which
// is the only caller): the `questions` array from a "questions_*.json"
// file — { question, options: string[], correctAnswerIndex, explanation,
// sectionTitle }. Each distinct sectionTitle becomes one "chapter" (in
// first-seen order), matching converter.py's chapter grouping. Optional
// forward-compatible fields are also honored if present on a question
// object: subchapter, vip, flag, unanswered, correctLetter/correctText —
// so this also accepts input shaped closer to converter.py's MCQBank
// schema without any change here.
// meta: { title, subtitle, colorKey, footerBrand } — colorKey is one of
// lib/pdfColors.js's PDF_COLOR_PRESETS keys or a custom hex; title/
// subtitle default to "MCQ Bank" / "" (same defaults as converter.py's
// MCQMeta). total_questions/total_chapters are always computed from the
// data, never taken from the caller.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');
const { PDF_COLOR_PRESETS, DEFAULT_PDF_COLOR, isHexColor, normalizeHex } = require('./pdfColors');

// --- Fonts -----------------------------------------------------------------
// Arabic uses NotoNaskhArabic, not Tajawal: the shaping pipeline
// (lib/textShaping.js's arabic-reshaper step) emits precomposed
// Arabic-Presentation-Forms codepoints, and Tajawal's cmap doesn't cover
// that block the way NotoNaskhArabic's does — confirmed by a render check
// while building this file; Tajawal silently drops to missing-glyph boxes
// for several contextual letter forms, NotoNaskhArabic renders correctly.
const FONT_ARABIC_REGULAR_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Regular.ttf');
const FONT_ARABIC_BOLD_PATH = path.join(__dirname, '../assets/fonts/NotoNaskhArabic-Bold.ttf');
const FONT_ARABIC_REGULAR = 'NotoNaskh-Regular';
const FONT_ARABIC_BOLD = 'NotoNaskh-Bold';

// Latin/English text uses Childos, matching template.html: its `body { }`
// / `* { }` rule puts "Childos Arabic SemiBold" first in the font-family
// stack for ALL text, not just badges. Despite the "Arabic" in its name,
// Childos is a 320-glyph Latin-only display face — checked its cmap with
// fonttools and it has zero codepoints in the Arabic block or the Arabic
// Presentation Forms blocks that lib/textShaping.js's reshaper emits. So
// in the browser it only ever actually paints Childos for Latin/digit
// runs; for Arabic runs the browser silently falls through the stack. It
// does cover 75/95 basic ASCII glyphs, which is enough for this content
// (English words, numbers, punctuation), so it's used here as the single
// font for both "regular" and "bold" Latin roles — same as the template,
// which only ever declares Childos at font-weight: normal and lets CSS
// font-weight on the elements request a synthetic bold the browser can
// fake; PDFKit can't synthesize bold, so bold Latin text below reuses
// these same glyphs at whatever weight the one shipped cut provides.
const FONT_REGULAR_PATH = path.join(__dirname, '../assets/fonts/ChildosFREEPERSONALUSE-SemiBold.otf');
const FONT_BOLD_PATH = path.join(__dirname, '../assets/fonts/ChildosFREEPERSONALUSE-SemiBold.otf');
const FONT_REGULAR = 'Childos-SemiBold';
const FONT_BOLD = 'Childos-SemiBold';

// Childos only covers ~75/95 basic ASCII glyphs (see above), so it has
// zero coverage of the Greek block (α β γ δ ...) and only patchy coverage
// of the general-punctuation/arrows/math-operator ranges (→ ↑ ↓ ← ± × ÷
// ≤ ≥ √ ∞ ∑ ...) that MCQ question/option/explanation text regularly
// uses for science and math content — those silently drew as
// blank/missing-glyph boxes. Lato has by far the widest coverage of the
// bundled fonts for these ranges (same fix already applied in
// lib/pdfGenerator.js — see its FONT_GREEK_* comment and hasGreek() in
// lib/textShaping.js for exactly which ranges trigger this), so it's
// registered here purely as a per-word fallback via tokenFont() below,
// without changing the normal Childos look for everything else.
const FONT_GREEK_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Lato-Regular.ttf');
const FONT_GREEK_BOLD_PATH = path.join(__dirname, '../assets/fonts/Lato-Bold.ttf');
const FONT_GREEK_REGULAR = 'Lato-Regular';
const FONT_GREEK_BOLD = 'Lato-Bold';

// Lato itself has gaps too — confirmed via the same cmap inspection (see
// the Symbol coverage section below): it's missing ■ ♡ ◇, three of the
// geometric/dingbat marks MCQ content occasionally uses as bullets or
// rating symbols. Spectral (already bundled) DOES carry those three, so
// it's registered as a second-tier fallback purely for them.
const FONT_SPECTRAL_REGULAR_PATH = path.join(__dirname, '../assets/fonts/Spectral-Regular.ttf');
const FONT_SPECTRAL_BOLD_PATH = path.join(__dirname, '../assets/fonts/Spectral-Bold.ttf');
const FONT_SPECTRAL_REGULAR = 'Spectral-Regular';
const FONT_SPECTRAL_BOLD = 'Spectral-Bold';

// Fredoka-Bold-700.ttf is the actual bold weight (the file previously used
// here, assets/fonts/Fredoka-Bold.ttf, is internally "Fredoka Light" despite
// its filename — confirmed via the font's own name table — so it never
// rendered bold). Unlike the change above, this one is NOT used for body
// headings anymore — template.html has no separate heading font-family at
// all (h1/h2 just inherit the same Childos-first body stack at a bigger
// size), so cover/chapter titles below now draw with FONT_BOLD (Childos)
// too, matching that. FONT_HEADING is kept only for the footer "BY M.E.M"
// wordmark AND the footer page number, because those come from a
// completely separate code path in converter.py — the PyMuPDF
// _stamp_checker_bands() post-process — which stamps both of those in
// Fredoka regardless of the HTML body's font-family.
const FONT_HEADING_PATH = path.join(__dirname, '../assets/fonts/Fredoka-Bold-700.ttf');
const FONT_HEADING = 'Fredoka-Bold';

// Same Childos file, registered again under its own name for the small
// circular badges (question-number badge, option-letter markers) and the
// subchapter banner — kept as a separate constant from FONT_REGULAR/BOLD
// above only for readability at the call sites; it's the identical font.
const FONT_CHILDOS_PATH = path.join(__dirname, '../assets/fonts/ChildosFREEPERSONALUSE-SemiBold.otf');
const FONT_CHILDOS = 'Childos-SemiBold';

// --- Page / header / footer chrome — identical geometry to before --------
const PAGE_MARGIN = 36;
const CHECKER_SIZE = 28;

const HEADER_H = CHECKER_SIZE * 2;
const PAGE_CONTENT_TOP = HEADER_H + 22;

const FOOTER_CHECKER_H = CHECKER_SIZE * 2;
const FOOTER_TOP_PAD = 10;
const FOOTER_H = FOOTER_TOP_PAD + FOOTER_CHECKER_H;

// --- Fixed (non-theme) card colors — same hardcoded values template.html
// uses for .qcard / .qcard border, independent of the accent theme -------
const CARD_BG = '#F1EAD0';
const CARD_BORDER = '#E2DAC0';
const BODY_TEXT = '#1F2937';
const MUTED_TEXT = '#4B5563';
const FLAG_TEXT = '#B45309';
const HOWTO_BORDER = '#E5E7EB';
const HOWTO_BG = '#FAFAFA';
const HOWTO_TEXT = '#374151';
const TABLE_BORDER = '#E5E7EB';

// ---------------------------------------------------------------------
// Theme: same derivation converter.py's build_theme_from_hex uses (a
// primary accent, darkened for headings/badges, tinted for option-marker
// and table-stripe backgrounds, plus a VIP-pill color picked for contrast
// against the accent's luminance). Applied to whichever base color this
// bot's existing /pdfcolor picker (lib/pdfColors.js) resolves — so every
// preset (coral, green, teal, purple, emerald, violet, red, blue) and any
// custom hex the user types keeps working, now run through this design's
// own palette math instead of the old M.E.M-design HSL formula.
// ---------------------------------------------------------------------
function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [37, 99, 235];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
function mixRgb(rgb, target, amount) {
  return rgb.map((v, i) => v + (target[i] - v) * amount);
}
function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildThemeFromHex(hex) {
  const primaryRgb = hexToRgb(hex);
  const primaryDarkRgb = mixRgb(primaryRgb, [0, 0, 0], 0.45);
  const optBgRgb = mixRgb(primaryRgb, [255, 255, 255], 0.85);
  const rowAltRgb = mixRgb(primaryRgb, [255, 255, 255], 0.94);
  const dark = relativeLuminance(primaryRgb) < 0.25;
  return {
    primary: rgbToHex(primaryRgb),
    primaryDark: rgbToHex(primaryDarkRgb),
    vipBg: dark ? '#111827' : '#F59E0B',
    vipText: dark ? '#FBBF24' : '#FFFFFF',
    optBg: rgbToHex(optBgRgb),
    rowAlt: rgbToHex(rowAltRgb),
    correctText: rgbToHex(primaryDarkRgb),
  };
}

function resolveTheme(colorKey) {
  const preset = PDF_COLOR_PRESETS[colorKey];
  if (preset) return buildThemeFromHex(preset.base);
  if (isHexColor(colorKey || '')) return buildThemeFromHex(normalizeHex(colorKey));
  return buildThemeFromHex(PDF_COLOR_PRESETS[DEFAULT_PDF_COLOR].base);
}

// ---------------------------------------------------------------------
// Input normalization — groups the flat `questions` array (with an
// optional sectionTitle) into converter.py's { meta, chapters[] } shape.
// Forward-compatible with a richer per-question shape (subchapter, vip,
// flag, explicit correctLetter/correctText, unanswered) if present.
// ---------------------------------------------------------------------
function cleanExplanationLike(value) {
  const v = value == null ? '' : String(value).trim();
  if (!v || v.toLowerCase() === 'none' || v.toLowerCase() === 'null') return '';
  return v;
}

function normalizeOptions(rawOptions) {
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  return list.map((opt, i) => {
    if (opt && typeof opt === 'object') {
      return { letter: String(opt.letter || String.fromCharCode(65 + i)), text: String(opt.text || '') };
    }
    return { letter: String.fromCharCode(65 + i), text: String(opt == null ? '' : opt) };
  });
}

function normalizeInput(questions, meta) {
  const list = Array.isArray(questions) ? questions : [];
  const chapterOrder = [];
  const chapterMap = new Map();
  let seq = 0;

  list.forEach((q) => {
    const chapterName = (q.sectionTitle && String(q.sectionTitle).trim()) || 'MCQs';
    if (!chapterMap.has(chapterName)) {
      chapterMap.set(chapterName, []);
      chapterOrder.push(chapterName);
    }
    seq += 1;

    const options = normalizeOptions(q.options);
    let unanswered = q.unanswered === true;
    let correctLetter = q.correctLetter || q.correct_letter || null;
    let correctText = q.correctText || q.correct_text || null;

    if (!correctLetter && !unanswered) {
      const idx = Number.isInteger(q.correctAnswerIndex) ? q.correctAnswerIndex : -1;
      if (idx >= 0 && options[idx]) {
        correctLetter = options[idx].letter;
        correctText = options[idx].text;
      } else {
        unanswered = true;
      }
    }

    chapterMap.get(chapterName).push({
      number: Number.isInteger(q.number) ? q.number : seq,
      text: String(q.question || q.text || ''),
      subchapter: q.subchapter ? String(q.subchapter) : null,
      vip: !!q.vip,
      flag: q.flag ? String(q.flag) : null,
      options,
      unanswered,
      correctLetter,
      correctText: cleanExplanationLike(correctText),
      explanation: cleanExplanationLike(q.explanation),
    });
  });

  const chapters = chapterOrder.map((name) => ({ name, questions: chapterMap.get(name) }));

  return {
    meta: {
      title: (meta && meta.title) || 'MCQ Bank',
      subtitle: (meta && meta.subtitle) || '',
      totalQuestions: seq,
      totalChapters: chapters.length,
    },
    chapters,
  };
}

// ---------------------------------------------------------------------
// Symbol coverage — which font actually has a glyph for a given
// character, for the punctuation/math/dingbat symbols MCQ content
// regularly contains (+ × ÷ = / _ € £ ¥ ₩ @ # $ % & * ( ) - ' " ; : ! ?
// , . ` ~ \ | < > { } [ ] ▪ ○ ● □ ■ ♤ ♡ ◇ ♧ ☆ ⊙ ° • ¤ 《 》 ¡ ¿ and more).
//
// The old check here (hasGreek() in lib/textShaping.js) only tested a
// character against a hardcoded Unicode *block* range (Greek + \u2000-
// \u2BFF) and assumed anything outside those blocks — i.e. all of ASCII
// and Latin-1 — was safely covered by Childos. That assumption is wrong:
// Childos is a 320-glyph display face (see the Fonts section above) that
// only actually contains 75 of the 95 printable ASCII glyphs and *none*
// of Latin-1 Supplement's punctuation (¡ ¿ « » etc.) or CJK punctuation
// (《 》). So common symbols like / _ # * ( ) - ' " ; : ! ? , . \ { } [ ]
// — none of them Greek, none of them in \u2000-\u2BFF — silently drew as
// blank/missing-glyph boxes.
//
// CHILDOS_RANGES below is that font's *actual* cmap (every codepoint it
// has a glyph for), dumped once via a direct fontTools inspection of
// ChildosFREEPERSONALUSE-SemiBold.otf and compressed into [start, end]
// pairs — ground truth instead of a block-range guess, so inCoverage()
// below correctly catches every character Childos is missing, not just
// the ones that happen to fall in the Greek/math-operator blocks.
const CHILDOS_RANGES = [
  [0, 0], [13, 13], [32, 32], [36, 38], [43, 43], [48, 57], [60, 62],
  [64, 90], [94, 94], [96, 122], [124, 124], [126, 126], [160, 160],
  [162, 170], [172, 172], [174, 182], [184, 186], [188, 190], [192, 382],
  [402, 402], [710, 711], [728, 733], [8224, 8225], [8240, 8240],
  [8260, 8260], [8364, 8364], [8482, 8482], [8592, 8601], [8722, 8722],
];

function inChildos(cp) {
  for (let i = 0; i < CHILDOS_RANGES.length; i++) {
    const [a, b] = CHILDOS_RANGES[i];
    if (cp >= a && cp <= b) return true;
    if (cp < a) break; // ranges are sorted ascending, so nothing further can match
  }
  return false;
}

// The Lato fallback (see Fonts section above) covers almost everything
// Childos is missing, but not everything: cmap inspection shows Lato
// itself has no glyph for ■ ♡ ◇. Spectral (already bundled) does carry
// all three, so a word containing one of these gets routed to Spectral
// instead of Lato.
const LATO_GAP_CHARS = new Set(['■', '♡', '◇']);

// A last category: characters with *zero* glyph coverage in any bundled
// font at all (checked every .ttf/.otf in assets/fonts) — same situation
// this file's Fonts-section comment already notes for arrow characters
// like ⇐⇑⇒⇓⇔. For 《 》 there's a same-meaning character every font here
// (including Childos itself) already has — the guillemets « » — so those
// two are just substituted outright. ⊙ (circled dot) substitutes to the
// closest available mark, a plain filled dot. The "emoji-style" operator
// glyphs below (➕ ➖ ➗ ⊕ ⊖ ⊗ ✖, and the CJK fullwidth ＋ ＝ －) are a
// separate but common case: content typed on a phone keyboard or copy-
// pasted from a chat app often uses these instead of plain "+ - ÷ ×",
// and — unlike plain "+" itself, which Childos already covers — NONE of
// the bundled fonts have a glyph for any of them, so an option like
// "CO2➕" silently dropped the "➕" entirely. Substituted to the
// equivalent plain-ASCII operator, which Childos already carries
// natively. ♤ ♧ ☆ have no reasonable text substitute (no bundled font
// has any card-suit or star glyph at all), so instead of a substitution
// they're drawn as small inline vector icons — see drawVectorGlyph()
// below, the same technique this file already uses for the how-to
// legend's icons (see file header).
const TEXT_SUBSTITUTES = {
  '《': '«', '》': '»', '⊙': '●',
  '➕': '+', '⊕': '+', '＋': '+',
  '➖': '-', '⊖': '-', '－': '-',
  '➗': '÷',
  '⊗': '×', '✖': '×',
  '＝': '=',
};
const VECTOR_GLYPHS = { '☆': 'star', '♤': 'spade', '♧': 'club' };

function applySymbolSubstitutions(text) {
  return text.replace(/[《》⊙➕⊕＋➖⊖－➗⊗✖＝]/g, (ch) => TEXT_SUBSTITUTES[ch]);
}

// Classifies one whitespace-delimited word for rendering: either a
// standalone vector-icon token (the common case for a bullet/rating mark
// like "☆" sitting on its own), or a text token tagged with which font
// tier actually has glyphs for every character in it.
function classifyWord(word) {
  if (VECTOR_GLYPHS[word]) return { text: word, vector: VECTOR_GLYPHS[word], tier: 'childos' };

  let text = '';
  let tier = 'childos';
  for (const ch of word) {
    // A vector-only character stuck inside a larger word (rare) can't be
    // drawn as an inline icon without a lot more plumbing, so it gets a
    // plain-text stand-in instead of a blank box.
    if (VECTOR_GLYPHS[ch]) {
      text += ch === '☆' ? '•' : '◇'; // ☆→bullet, ♤/♧→open diamond (both Lato-covered stand-ins)
      if (tier === 'childos') tier = 'lato';
      continue;
    }
    text += ch;
    if (tier !== 'spectral') {
      if (LATO_GAP_CHARS.has(ch)) tier = 'spectral';
      else if (tier === 'childos' && !inChildos(ch.codePointAt(0))) tier = 'lato';
    }
  }
  return { text, vector: null, tier };
}

function fontForTier(tier, bold) {
  if (tier === 'spectral') return bold ? FONT_SPECTRAL_BOLD : FONT_SPECTRAL_REGULAR;
  if (tier === 'lato') return bold ? FONT_GREEK_BOLD : FONT_GREEK_REGULAR;
  return bold ? FONT_BOLD : FONT_REGULAR;
}

function wordWidth(doc, word, isBold, size) {
  if (word.vector) return size; // reserve one "em" square for the icon
  doc.font(fontForTier(word.tier, isBold)).fontSize(size);
  return doc.widthOfString(word.text);
}

// Small inline vector icons for ☆ ♤ ♧ — the three characters with no
// glyph in any bundled font (see VECTOR_GLYPHS above). Drawn at roughly
// the line's cap-height/baseline so they sit like a normal glyph inside
// the surrounding text, in the same stroked/filled-shape style this file
// already uses for the how-to legend's star/warning icons.
function drawVectorGlyph(doc, kind, x, y, size, color) {
  const cx = x + size / 2;
  const baseline = y + size * 0.78;
  doc.save();
  if (kind === 'star') {
    drawStar(doc, cx, baseline - size * 0.32, size * 0.34, size * 0.15, color);
  } else {
    // Spade/club: a rounded lobe on a short stem — close-enough card-suit
    // silhouette given no bundled font has the real glyph to trace.
    const r = size * 0.2;
    const topY = baseline - size * 0.62;
    doc.fillColor(color);
    if (kind === 'spade') {
      doc.moveTo(cx, topY)
        .bezierCurveTo(cx - r * 1.7, topY + r * 1.8, cx - r * 1.9, topY + r * 3.4, cx, topY + r * 2.9)
        .bezierCurveTo(cx + r * 1.9, topY + r * 3.4, cx + r * 1.7, topY + r * 1.8, cx, topY)
        .closePath().fill(color);
    } else {
      doc.circle(cx - r * 0.85, topY + r * 1.6, r).fill(color);
      doc.circle(cx + r * 0.85, topY + r * 1.6, r).fill(color);
      doc.circle(cx, topY + r * 0.5, r).fill(color);
    }
    doc.moveTo(cx, topY + r * 2.4).lineTo(cx - r * 0.35, baseline).lineTo(cx + r * 0.35, baseline).closePath().fill(color);
  }
  doc.restore();
}

// ---------------------------------------------------------------------
// Text measure/draw helpers — generic wrap+shape, explicit line height.
//
// Non-Arabic lines are tokenized per word instead of kept as a single
// joined string, because `font` here is always Childos, which only
// covers a subset of ASCII (see the Symbol coverage section above) — any
// word containing a character Childos lacks a glyph for needs to fall
// back to Lato or Spectral (classifyWord()/fontForTier() above), or a
// vector icon (drawVectorGlyph()), or it silently draws as a blank
// missing-glyph box. measureText/drawText here are the single shared
// helper for question text, option text, AND the answer-key table's
// explanation column, so fixing it here covers all three at once.
function measureText(doc, text, font, arabicFont, size, maxWidth) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { arabic: false, lines: [] };
  const arabic = isMostlyArabic(raw);
  if (arabic) {
    const words = raw.split(/\s+/).filter(Boolean);
    const lines = wrapWordsByWidth(doc, words, arabicFont, size, maxWidth);
    return { arabic: true, lines: lines.map((l) => shapeArabicLine(l)) };
  }

  const isBold = font === FONT_BOLD;
  const words = applySymbolSubstitutions(raw).split(/\s+/).filter(Boolean).map(classifyWord);
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const spaceWidth = doc.font(font).fontSize(size).widthOfString(' ');
  words.forEach((word) => {
    const w = wordWidth(doc, word, isBold, size);
    const extra = current.length > 0 ? spaceWidth + w : w;
    if (current.length > 0 && currentWidth + extra > maxWidth) {
      lines.push(current);
      current = [word];
      currentWidth = w;
    } else {
      current.push(word);
      currentWidth += extra;
    }
  });
  if (current.length > 0) lines.push(current);
  return { arabic: false, lines };
}

function lineWidth(doc, line, isBold, size) {
  let width = 0;
  line.forEach((word, i) => {
    if (i > 0) width += doc.font(FONT_REGULAR).fontSize(size).widthOfString(' ');
    width += wordWidth(doc, word, isBold, size);
  });
  return width;
}

function drawText(doc, measured, x, y, width, font, arabicFont, size, lineHeight, color, align) {
  if (!measured || !measured.lines.length) return;
  doc.fillColor(color);
  if (measured.arabic) {
    const useAlign = align || 'right';
    doc.font(arabicFont).fontSize(size);
    measured.lines.forEach((line, i) => {
      const ly = y + i * lineHeight;
      const w = doc.widthOfString(line);
      if (useAlign === 'center') {
        doc.text(line, x + Math.max(0, (width - w) / 2), ly, { lineBreak: false });
      } else if (useAlign === 'right') {
        doc.text(line, x + Math.max(0, width - w), ly, { lineBreak: false });
      } else {
        doc.text(line, x, ly, { lineBreak: false });
      }
    });
    return;
  }

  const useAlign = align || 'left';
  const isBold = font === FONT_BOLD;
  const spaceWidth = doc.font(font).fontSize(size).widthOfString(' ');
  measured.lines.forEach((line, i) => {
    const ly = y + i * lineHeight;
    let cx = x;
    if (useAlign === 'center') {
      cx = x + Math.max(0, (width - lineWidth(doc, line, isBold, size)) / 2);
    } else if (useAlign === 'right') {
      cx = x + Math.max(0, width - lineWidth(doc, line, isBold, size));
    }
    line.forEach((word) => {
      if (word.vector) {
        drawVectorGlyph(doc, word.vector, cx, ly, size, color);
        cx += size + spaceWidth;
        return;
      }
      doc.font(fontForTier(word.tier, isBold)).fontSize(size).fillColor(color);
      doc.text(word.text, cx, ly, { lineBreak: false });
      cx += doc.widthOfString(word.text) + spaceWidth;
    });
  });
}

function textHeight(measured, lineHeight) {
  return Math.max(measured.lines.length, 1) * lineHeight;
}

// A filled circle with centered text — used for the question-number badge
// and the option-letter markers.
//
// Centering the text takes more than `cy - size/2`: PDFKit's default text
// anchor is ascender-based (it top-aligns the font's full em-box, not the
// glyph ink), so digits/letters — which have no descender — end up
// visibly sitting low in the circle. Instead we compute the actual visual
// midpoint of a cap-height glyph (ascender down to baseline, no
// descender) from the active font's own metrics and solve for the y that
// puts *that* midpoint on cy. This stays correct across every font/size
// combo used for badges (Childos for question/option badges), not just
// one hand-tuned constant.
function drawCircleBadge(doc, cx, cy, r, bg, text, textColor, font, size, ringColor) {
  if (ringColor) {
    doc.circle(cx, cy, r + 3).fill(ringColor);
  }
  doc.circle(cx, cy, r).fill(bg);
  if (text) {
    doc.font(font).fontSize(size).fillColor(textColor);
    const w = doc.widthOfString(text);
    const f = doc._font;
    const capHeight = f.capHeight || f.ascender * 0.7;
    const textY = cy - (f.ascender / 1000) * size + (capHeight / 1000) * size / 2;
    doc.text(text, cx - w / 2, textY, { lineBreak: false });
  }
}

// Small 5-point star, used for the VIP icon in the how-to legend (the
// on-card VIP tag itself is plain text, matching the template).
function drawStar(doc, cx, cy, outerR, innerR, color) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }
  doc.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) doc.lineTo(pts[i][0], pts[i][1]);
  doc.closePath().fill(color);
}

// Small warning triangle + "!" — vector replacement for the template's ⚠
// glyph (see file header for why icons here are drawn, not typed).
function drawWarningIcon(doc, cx, cy, size, color) {
  const h = size * 0.92;
  doc.moveTo(cx, cy - h / 2)
    .lineTo(cx + size / 2, cy + h / 2)
    .lineTo(cx - size / 2, cy + h / 2)
    .closePath()
    .fill(color);
  doc.font(FONT_BOLD).fontSize(size * 0.6).fillColor('#ffffff');
  const w = doc.widthOfString('!');
  doc.text('!', cx - w / 2, cy - size * 0.1, { lineBreak: false });
}

// Small table/grid icon for the "Answer & Explanation Table" legend row.
function drawTableIcon(doc, x, y, w, h, color) {
  doc.save();
  doc.lineWidth(1.2).strokeColor(color);
  doc.rect(x, y, w, h).stroke();
  doc.moveTo(x, y + h / 2).lineTo(x + w, y + h / 2).stroke();
  doc.moveTo(x + w / 2, y).lineTo(x + w / 2, y + h).stroke();
  doc.restore();
}

// ---------------------------------------------------------------------
// Cover band — mirrors template.html's .cover: title, subtitle, and a
// "N Questions | M Chapters" pill, on a filled accent-colored rounded box.
// ---------------------------------------------------------------------
const COVER_PAD_X = 20;
const COVER_PAD_Y = 18;
const COVER_TITLE_SIZE = 19;
const COVER_TITLE_LH = 23;
const COVER_SUB_SIZE = 11;
const COVER_SUB_LH = 15;
const COVER_PILL_H = 22;

function measureCover(doc, meta, width) {
  const innerWidth = width - COVER_PAD_X * 2;
  const titleM = measureText(doc, meta.title, FONT_BOLD, FONT_ARABIC_BOLD, COVER_TITLE_SIZE, innerWidth);
  const subM = meta.subtitle ? measureText(doc, meta.subtitle, FONT_REGULAR, FONT_ARABIC_REGULAR, COVER_SUB_SIZE, innerWidth) : null;
  const titleH = textHeight(titleM, COVER_TITLE_LH);
  const subH = subM ? textHeight(subM, COVER_SUB_LH) : 0;
  const height = COVER_PAD_Y * 2 + titleH + (subM ? subH + 8 : 0) + 10 + COVER_PILL_H;
  return { titleM, subM, titleH, subH, height };
}

function drawCover(doc, theme, meta, measured, x, y, width) {
  doc.roundedRect(x, y, width, measured.height, 10).fill(theme.primary);
  let cy = y + COVER_PAD_Y;
  drawText(doc, measured.titleM, x + COVER_PAD_X, cy, width - COVER_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, COVER_TITLE_SIZE, COVER_TITLE_LH, '#ffffff');
  cy += measured.titleH + 6;
  if (measured.subM) {
    drawText(doc, measured.subM, x + COVER_PAD_X, cy, width - COVER_PAD_X * 2, FONT_REGULAR, FONT_ARABIC_REGULAR, COVER_SUB_SIZE, COVER_SUB_LH, '#ffffff');
    cy += measured.subH + 10;
  } else {
    cy += 6;
  }
  // The "N Questions | M Chapters" pill — this used to measure/draw with
  // a raw doc.font()+doc.text() call, bypassing the classifyWord-based
  // Childos→Lato→Spectral fallback (and vector-icon path) that every
  // other text block in this file goes through. Harmless for today's
  // exact template string (digits/letters/space/"|" are all glyphs
  // Childos actually has), but it's the one place left that would
  // silently draw a blank box if that ever changed — routed through the
  // same measureText/drawText helpers as everything else now, so this
  // card gets the same coverage guarantees as the chapter/question cards.
  const pillText = `${meta.totalQuestions} Questions | ${meta.totalChapters} Chapters`;
  const pillFont = FONT_BOLD;
  const pillSize = 10.5;
  const pillM = measureText(doc, pillText, pillFont, FONT_ARABIC_BOLD, pillSize, 100000);
  const pillTextW = pillM.lines.length ? lineWidth(doc, pillM.lines[0], true, pillSize) : 0;
  const pillW = pillTextW + 26;
  doc.save().fillOpacity(0.2);
  doc.roundedRect(x + COVER_PAD_X, cy, pillW, COVER_PILL_H, COVER_PILL_H / 2).fill('#ffffff');
  doc.restore();
  drawText(doc, pillM, x + COVER_PAD_X + 13, cy + (COVER_PILL_H - pillSize) / 2 - 1, pillTextW, pillFont, FONT_ARABIC_BOLD, pillSize, pillSize + 2, '#ffffff');
}

// ---------------------------------------------------------------------
// How-to legend — mirrors template.html's .howto box, four rows, each an
// icon + a bold label + a description, matching the template's copy.
// ---------------------------------------------------------------------
const HOWTO_PAD_X = 18;
const HOWTO_PAD_Y = 14;
const HOWTO_TITLE_SIZE = 12.5;
const HOWTO_ROW_H = 20;
const HOWTO_ROW_TEXT_SIZE = 10.5;
const HOWTO_ICON_COL_W = 34;

const HOWTO_ROWS = [
  { label: 'Question Badge', desc: 'Sequential continuous order across the bank' },
  { label: 'Option Badge', desc: 'Original choice preserved and normalized' },
  { label: 'VIP MCQS', desc: 'High-yield exam priority marker' },
  { label: 'Answer & Explanation Table', desc: 'Provided systematically after every chapter' },
];

function measureHowto(width) {
  const height = HOWTO_PAD_Y * 2 + HOWTO_TITLE_SIZE + 10 + HOWTO_ROW_H * HOWTO_ROWS.length;
  return { height };
}

function drawHowtoIcon(doc, theme, rowIndex, cx, cy) {
  switch (rowIndex) {
    case 0:
      drawCircleBadge(doc, cx, cy, 8, theme.primary, '1', '#ffffff', FONT_BOLD, 9);
      break;
    case 1:
      drawCircleBadge(doc, cx - 4, cy, 7, theme.primary, '1', '#ffffff', FONT_BOLD, 8);
      drawCircleBadge(doc, cx + 6, cy, 7, theme.optBg, 'A', theme.primaryDark, FONT_BOLD, 8);
      break;
    case 2:
      drawStar(doc, cx, cy, 9, 4, theme.vipBg === '#111827' ? '#F59E0B' : theme.vipBg);
      break;
    default:
      drawTableIcon(doc, cx - 7, cy - 7, 14, 14, theme.primaryDark);
  }
}

function drawHowto(doc, theme, measured, x, y, width) {
  doc.save();
  doc.lineWidth(1).strokeColor(HOWTO_BORDER);
  doc.roundedRect(x, y, width, measured.height, 10).fillAndStroke(HOWTO_BG, HOWTO_BORDER);
  doc.restore();

  doc.font(FONT_BOLD).fontSize(HOWTO_TITLE_SIZE).fillColor(theme.primaryDark);
  doc.text('HOW TO READ THIS BANK', x + HOWTO_PAD_X, y + HOWTO_PAD_Y, { lineBreak: false });

  let ry = y + HOWTO_PAD_Y + HOWTO_TITLE_SIZE + 10;
  HOWTO_ROWS.forEach((row, i) => {
    const iconCx = x + HOWTO_PAD_X + 10;
    const iconCy = ry + HOWTO_ROW_H / 2 - 2;
    drawHowtoIcon(doc, theme, i, iconCx, iconCy);

    const textX = x + HOWTO_PAD_X + HOWTO_ICON_COL_W;
    doc.font(FONT_BOLD).fontSize(HOWTO_ROW_TEXT_SIZE).fillColor(theme.primaryDark);
    const labelW = doc.widthOfString(row.label);
    doc.text(row.label, textX, ry, { lineBreak: false });
    doc.font(FONT_REGULAR).fontSize(HOWTO_ROW_TEXT_SIZE).fillColor(HOWTO_TEXT);
    doc.text(` — ${row.desc}`, textX + labelW, ry, { lineBreak: false });
    ry += HOWTO_ROW_H;
  });
}

// ---------------------------------------------------------------------
// Chapter banner — mirrors .chapter-banner: filled primary-dark bar with
// the chapter name + question count. Page-break behavior (forced new page
// before every chapter except the first) is handled by the caller.
// ---------------------------------------------------------------------
const CHAPTER_PAD_X = 16;
const CHAPTER_PAD_Y = 11;
const CHAPTER_TITLE_SIZE = 15;
const CHAPTER_COUNT_SIZE = 10.5;

function measureChapterBanner(doc, chapter, width) {
  const titleM = measureText(doc, chapter.name, FONT_BOLD, FONT_ARABIC_BOLD, CHAPTER_TITLE_SIZE, width - CHAPTER_PAD_X * 2);
  const titleH = textHeight(titleM, CHAPTER_TITLE_SIZE + 3);
  const height = CHAPTER_PAD_Y * 2 + titleH + CHAPTER_COUNT_SIZE + 4;
  return { titleM, titleH, height };
}

function drawChapterBanner(doc, theme, chapter, measured, x, y, width) {
  doc.roundedRect(x, y, width, measured.height, 8).fill(theme.primaryDark);
  drawText(doc, measured.titleM, x + CHAPTER_PAD_X, y + CHAPTER_PAD_Y, width - CHAPTER_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, CHAPTER_TITLE_SIZE, CHAPTER_TITLE_SIZE + 3, '#ffffff');
  doc.font(FONT_REGULAR).fontSize(CHAPTER_COUNT_SIZE).fillColor('#ffffff').fillOpacity(0.88);
  doc.text(`${chapter.questions.length} Questions`, x + CHAPTER_PAD_X, y + CHAPTER_PAD_Y + measured.titleH + 2, { lineBreak: false });
  doc.fillOpacity(1);
}

// ---------------------------------------------------------------------
// Subchapter banner — mirrors .subchapter-banner: a left-accented tinted
// strip. Only drawn when a question carries a `subchapter` value.
// ---------------------------------------------------------------------
const SUBCH_PAD_X = 12;
const SUBCH_PAD_Y = 7;
const SUBCH_SIZE = 12;

function measureSubchapterBanner(doc, name, width) {
  const m = measureText(doc, name, FONT_BOLD, FONT_ARABIC_BOLD, SUBCH_SIZE, width - SUBCH_PAD_X * 2 - 4);
  return { m, height: SUBCH_PAD_Y * 2 + textHeight(m, SUBCH_SIZE + 2) };
}

function drawSubchapterBanner(doc, theme, measured, x, y, width) {
  doc.roundedRect(x, y, width, measured.height, 6).fill(theme.optBg);
  doc.rect(x, y, 4, measured.height).fill(theme.primary);
  drawText(doc, measured.m, x + SUBCH_PAD_X + 4, y + SUBCH_PAD_Y, width - SUBCH_PAD_X * 2 - 4, FONT_BOLD, FONT_ARABIC_BOLD, SUBCH_SIZE, SUBCH_SIZE + 2, theme.primaryDark);
}

// ---------------------------------------------------------------------
// Question card — mirrors .qcard-wrap/.qcard: cream card, accent left
// border, an overflowing circular number badge, question text + optional
// VIP tag, every option as a plain lettered-circle row (no highlighting —
// the correct answer only appears in the chapter's answer-key table,
// matching the template), and an optional flag note.
// ---------------------------------------------------------------------
// Density note: these were tightened from the original template values
// (CARD_PAD_Y 13, BADGE_R 14, QTEXT_SIZE 13/LH 17, OPT_MARKER_R 10,
// OPT_TEXT_SIZE 11.5/LH 15, OPT_ROW_GAP 6, FLAG_SIZE 10/LH 13) so that a
// typical 4-option MCQ card fits at least 6-7 questions per content page
// instead of ~3. All the ratios/behavior below are unchanged, only the
// absolute sizes are smaller.
const CARD_PAD_Y = 6;
const CARD_PAD_RIGHT = 12;
const CARD_PAD_LEFT = 24; // room for the badge overflowing the left edge
const BADGE_R = 10;
const QTEXT_SIZE = 10;
const QTEXT_LH = 12.5;
const VIP_SIZE = 7;
const VIP_PAD_X = 6;
const VIP_H = 12;
const OPT_MARKER_R = 7;
const OPT_MARKER_GAP = 5;
const OPT_TEXT_SIZE = 9;
const OPT_LH = 11;
const OPT_ROW_GAP = 2;
const FLAG_SIZE = 8.5;
const FLAG_LH = 10.5;

function measureCard(doc, q, width) {
  const innerWidth = width - CARD_PAD_LEFT - CARD_PAD_RIGHT;
  doc.font(FONT_BOLD).fontSize(QTEXT_SIZE);
  const vipW = q.vip ? doc.font(FONT_BOLD).fontSize(VIP_SIZE).widthOfString('VIP MCQS') + VIP_PAD_X * 2 : 0;
  const qtextWidth = q.vip ? Math.max(40, innerWidth - vipW - 10) : innerWidth;
  const qtextM = measureText(doc, q.text, FONT_BOLD, FONT_ARABIC_BOLD, QTEXT_SIZE, qtextWidth);
  const qtextH = Math.max(textHeight(qtextM, QTEXT_LH), q.vip ? VIP_H : 0);

  const optW = innerWidth - (OPT_MARKER_R * 2 + OPT_MARKER_GAP);
  const optsM = q.options.map((opt) => {
    const m = measureText(doc, opt.text, FONT_REGULAR, FONT_ARABIC_REGULAR, OPT_TEXT_SIZE, optW);
    const h = Math.max(textHeight(m, OPT_LH), OPT_MARKER_R * 2);
    return { m, h };
  });
  const optsHeight = optsM.reduce((sum, o) => sum + o.h, 0) + OPT_ROW_GAP * Math.max(0, optsM.length - 1);

  const flagM = q.flag ? measureText(doc, q.flag, FONT_REGULAR, FONT_ARABIC_REGULAR, FLAG_SIZE, innerWidth) : null;
  const flagH = flagM ? textHeight(flagM, FLAG_LH) : 0;

  const innerHeight = qtextH + 10 + optsHeight + (flagM ? 8 + flagH : 0);
  const height = innerHeight + CARD_PAD_Y * 2;
  return { qtextM, qtextH, qtextWidth, vipW, optsM, optsHeight, optW, flagM, flagH, height, innerWidth };
}

function drawCard(doc, theme, q, measured, x, y, width) {
  doc.save();
  doc.lineWidth(1).strokeColor(CARD_BORDER);
  doc.roundedRect(x, y, width, measured.height, 8).fillAndStroke(CARD_BG, CARD_BORDER);
  doc.restore();
  // Accent left border, matching .qcard's border-left: 4px solid primary.
  doc.rect(x, y + 2, 4, measured.height - 4).fill(theme.primary);

  // Number badge, overflowing the card's left edge (template: left:-14px).
  const badgeCx = x - 2;
  const badgeCy = y + CARD_PAD_Y + BADGE_R - 2;
  drawCircleBadge(doc, badgeCx, badgeCy, BADGE_R, theme.primary, String(q.number), '#ffffff', FONT_CHILDOS, 8, '#ffffff');

  const textX = x + CARD_PAD_LEFT;
  let cy = y + CARD_PAD_Y;

  drawText(doc, measured.qtextM, textX, cy, measured.qtextWidth, FONT_BOLD, FONT_ARABIC_BOLD, QTEXT_SIZE, QTEXT_LH, theme.primaryDark);
  if (q.vip) {
    const vipX = x + width - CARD_PAD_RIGHT - measured.vipW;
    doc.roundedRect(vipX, cy, measured.vipW, VIP_H, VIP_H / 2).fill(theme.vipBg);
    doc.font(FONT_BOLD).fontSize(VIP_SIZE).fillColor(theme.vipText);
    doc.text('VIP MCQS', vipX, cy + (VIP_H - VIP_SIZE) / 2 - 1, { width: measured.vipW, align: 'center', lineBreak: false });
  }
  cy += measured.qtextH + 10;

  measured.optsM.forEach((om, i) => {
    const letter = q.options[i].letter;
    const markerCx = textX + OPT_MARKER_R;
    const markerCy = cy + om.h / 2;
    drawCircleBadge(doc, markerCx, markerCy, OPT_MARKER_R, theme.optBg, letter, theme.primaryDark, FONT_CHILDOS, 7);
    const optTextX = textX + OPT_MARKER_R * 2 + OPT_MARKER_GAP;
    drawText(doc, om.m, optTextX, cy + (om.h - om.m.lines.length * OPT_LH) / 2, measured.optW, FONT_REGULAR, FONT_ARABIC_REGULAR, OPT_TEXT_SIZE, OPT_LH, BODY_TEXT);
    cy += om.h + OPT_ROW_GAP;
  });
  if (measured.optsM.length > 0) cy -= OPT_ROW_GAP;

  if (measured.flagM) {
    cy += 8;
    const iconCx = textX + 5;
    const iconCy = cy + FLAG_SIZE / 2 - 1;
    drawWarningIcon(doc, iconCx, iconCy, 10, FLAG_TEXT);
    doc.font(FONT_REGULAR).fontSize(FLAG_SIZE).fillColor(FLAG_TEXT);
    drawText(doc, measured.flagM, textX + 13, cy, measured.innerWidth - 13, FONT_REGULAR, FONT_ARABIC_REGULAR, FLAG_SIZE, FLAG_LH, FLAG_TEXT);
  }
}

// ---------------------------------------------------------------------
// Answer-key table — mirrors table.akey: header row (primary-dark bg,
// white text), a subchapter divider row whenever the subchapter changes,
// and one row per question (Q# / correct answer / explanation), striped
// every other data row. The header row is redrawn whenever the table
// continues onto a new page, matching an HTML <thead> repeating on print.
// ---------------------------------------------------------------------
const TABLE_HEADER_H = 22;
const TABLE_FONT_SIZE = 10;
const TABLE_LH = 13;
const TABLE_CELL_PAD_X = 9;
const TABLE_ROW_PAD_Y = 6;
const COL_Q_RATIO = 0.08;
const COL_ANS_RATIO = 0.26;

function tableCols(width) {
  const qW = width * COL_Q_RATIO;
  const ansW = width * COL_ANS_RATIO;
  const expW = width - qW - ansW;
  return { qW, ansW, expW, qX: 0, ansX: qW, expX: qW + ansW };
}

function drawTableHeader(doc, theme, x, y, width) {
  const cols = tableCols(width);
  doc.roundedRect(x, y, width, TABLE_HEADER_H, 0).fill(theme.primaryDark);
  doc.font(FONT_BOLD).fontSize(10.5).fillColor('#ffffff');
  doc.text('Q#', x + cols.qX + TABLE_CELL_PAD_X, y + (TABLE_HEADER_H - 10.5) / 2, { lineBreak: false });
  doc.text('Correct Answer', x + cols.ansX + TABLE_CELL_PAD_X, y + (TABLE_HEADER_H - 10.5) / 2, { lineBreak: false });
  doc.text('Explanation', x + cols.expX + TABLE_CELL_PAD_X, y + (TABLE_HEADER_H - 10.5) / 2, { lineBreak: false });
}

function measureAnswerRow(doc, q, width) {
  const cols = tableCols(width);
  const ansTextWidth = Math.max(20, cols.ansW - TABLE_CELL_PAD_X * 2);
  const expTextWidth = Math.max(20, cols.expW - TABLE_CELL_PAD_X * 2);

  let ansM;
  let expM;
  if (q.unanswered || !q.correctLetter) {
    ansM = measureText(doc, '—', FONT_BOLD, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, ansTextWidth);
    expM = measureText(doc, '—', FONT_REGULAR, FONT_ARABIC_REGULAR, TABLE_FONT_SIZE, expTextWidth);
  } else {
    const ansText = q.correctText ? `${q.correctLetter}) ${q.correctText}` : `${q.correctLetter})`;
    ansM = measureText(doc, ansText, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, ansTextWidth);
    expM = measureText(doc, q.explanation || '—', FONT_REGULAR, FONT_ARABIC_REGULAR, TABLE_FONT_SIZE, expTextWidth);
  }

  const rowHeight = Math.max(textHeight(ansM, TABLE_LH), textHeight(expM, TABLE_LH), TABLE_LH) + TABLE_ROW_PAD_Y * 2;
  return { ansM, expM, cols, ansTextWidth, expTextWidth, height: rowHeight };
}

function drawAnswerRow(doc, theme, q, measured, x, y, width, striped) {
  if (striped) {
    doc.rect(x, y, width, measured.height).fill(theme.rowAlt);
  }
  const numColor = theme.correctText || theme.primaryDark;
  doc.font(FONT_BOLD).fontSize(TABLE_FONT_SIZE).fillColor(BODY_TEXT);
  doc.text(String(q.number), x + measured.cols.qX + TABLE_CELL_PAD_X, y + TABLE_ROW_PAD_Y, { lineBreak: false });

  const ansColor = q.unanswered || !q.correctLetter ? MUTED_TEXT : theme.correctText;
  drawText(doc, measured.ansM, x + measured.cols.ansX + TABLE_CELL_PAD_X, y + TABLE_ROW_PAD_Y, measured.ansTextWidth, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_FONT_SIZE, TABLE_LH, ansColor);
  drawText(doc, measured.expM, x + measured.cols.expX + TABLE_CELL_PAD_X, y + TABLE_ROW_PAD_Y, measured.expTextWidth, FONT_REGULAR, FONT_ARABIC_REGULAR, TABLE_FONT_SIZE, TABLE_LH, MUTED_TEXT);

  doc.save().lineWidth(0.5).strokeColor(TABLE_BORDER);
  doc.moveTo(x, y + measured.height).lineTo(x + width, y + measured.height).stroke();
  doc.restore();
}

function measureSubRow(doc, name, width) {
  const m = measureText(doc, name, FONT_BOLD, FONT_ARABIC_BOLD, 10.5, width - TABLE_CELL_PAD_X * 2);
  return { m, height: 7 * 2 + textHeight(m, 13) };
}

function drawSubRow(doc, theme, measured, x, y, width) {
  doc.rect(x, y, width, measured.height).fill(theme.optBg);
  drawText(doc, measured.m, x + TABLE_CELL_PAD_X, y + 7, width - TABLE_CELL_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, 10.5, 13, theme.primaryDark);
  doc.save().lineWidth(2).strokeColor(theme.primary);
  doc.moveTo(x, y + measured.height).lineTo(x + width, y + measured.height).stroke();
  doc.restore();
}

// --- Header/footer chrome — unchanged checkerboard bands + brand/page# ---
function drawCheckerStrip(doc, theme, x, y, width, squareSize, rowIndex = 0, gaps = []) {
  const cols = Math.ceil(width / squareSize);
  doc.save();
  for (let i = 0; i < cols; i++) {
    const sx = x + i * squareSize;
    const sx2 = sx + squareSize;
    const inGap = gaps.some((g) => sx < g.x2 && sx2 > g.x1);
    if (inGap) continue;
    doc.rect(sx, y, squareSize, squareSize).fill((i + rowIndex) % 2 === 0 ? theme.primary : '#ffffff');
  }
  doc.restore();
}

function drawHeader(doc, theme, pageWidth) {
  drawCheckerStrip(doc, theme, 0, 0, pageWidth, CHECKER_SIZE, 0);
  drawCheckerStrip(doc, theme, 0, CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);
}

const DEFAULT_FOOTER_BRAND = 'BY M.E.M';
const FOOTER_WATERMARK_SIZE = 30;
const FOOTER_PAGE_NUM_SIZE = 13;
const FOOTER_GAP_PAD = 6;
const FOOTER_BRAND_GAP_BOXES = 5;

function oddBoxCountFor(width, squareSize) {
  let n = 1;
  while (n * squareSize < width) n += 2;
  return n;
}

function gridGapCenteredAt(centerX, boxes, squareSize) {
  const startCol = Math.round(centerX / squareSize - boxes / 2);
  return { x1: startCol * squareSize, x2: (startCol + boxes) * squareSize };
}

function drawFooter(doc, theme, pageNum, pageWidth, pageHeight, brand) {
  const checkerY = pageHeight - FOOTER_CHECKER_H;
  const upperRowY = checkerY;

  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  const brandW = doc.widthOfString(brandText);
  const brandGap = gridGapCenteredAt(pageWidth / 2, FOOTER_BRAND_GAP_BOXES, CHECKER_SIZE);
  const brandX = brandGap.x1 + ((brandGap.x2 - brandGap.x1) - brandW) / 2;

  const pageNumText = String(pageNum);
  doc.font(FONT_HEADING).fontSize(FOOTER_PAGE_NUM_SIZE);
  const numW = doc.widthOfString(pageNumText);
  const numBoxes = oddBoxCountFor(numW + FOOTER_GAP_PAD * 2, CHECKER_SIZE);
  const numGap = gridGapCenteredAt(pageWidth - PAGE_MARGIN - numW / 2, numBoxes, CHECKER_SIZE);
  const numX1 = numGap.x1 + ((numGap.x2 - numGap.x1) - numW) / 2;

  drawCheckerStrip(doc, theme, 0, checkerY, pageWidth, CHECKER_SIZE, 0, [brandGap, numGap]);
  drawCheckerStrip(doc, theme, 0, checkerY + CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);

  const brandY = upperRowY + (CHECKER_SIZE - FOOTER_WATERMARK_SIZE) / 2 - 6;
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  doc.fillColor(theme.primary).strokeColor(theme.primaryDark).lineWidth(0.5);
  doc.text(brandText, brandX, brandY, { lineBreak: false, characterSpacing: 1.5, fill: true, stroke: true });

  const numY = upperRowY + (CHECKER_SIZE - FOOTER_PAGE_NUM_SIZE) / 2;
  doc.font(FONT_HEADING).fontSize(FOOTER_PAGE_NUM_SIZE).fillColor(theme.primaryDark);
  doc.text(pageNumText, numX1, numY, { lineBreak: false });
}

// questions: [{ question, options: string[], correctAnswerIndex,
// explanation, sectionTitle }] — see the /json_mcq command in
// api/telegram-webhook.js for exactly what shape is passed in.
// meta: { colorKey, footerBrand, title, subtitle }
function generateMcqPdf(questions, meta = {}) {
  return new Promise((resolve, reject) => {
    try {
      const theme = resolveTheme(meta.colorKey || DEFAULT_PDF_COLOR);
      const data = normalizeInput(questions, meta);

      const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: false });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont(FONT_ARABIC_REGULAR, FONT_ARABIC_REGULAR_PATH);
      doc.registerFont(FONT_ARABIC_BOLD, FONT_ARABIC_BOLD_PATH);
      doc.registerFont(FONT_HEADING, FONT_HEADING_PATH);
      // FONT_REGULAR, FONT_BOLD, and FONT_CHILDOS are all the same name
      // ('Childos-SemiBold') pointing at the same file — see the Fonts
      // section above — so one registration covers all three constants.
      doc.registerFont(FONT_CHILDOS, FONT_CHILDOS_PATH);
      doc.registerFont(FONT_GREEK_REGULAR, FONT_GREEK_REGULAR_PATH);
      doc.registerFont(FONT_GREEK_BOLD, FONT_GREEK_BOLD_PATH);
      doc.registerFont(FONT_SPECTRAL_REGULAR, FONT_SPECTRAL_REGULAR_PATH);
      doc.registerFont(FONT_SPECTRAL_BOLD, FONT_SPECTRAL_BOLD_PATH);

      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const contentX = PAGE_MARGIN;
      const contentWidth = pageWidth - PAGE_MARGIN * 2;

      let pageNum = 1;
      let y;

      function startPage() {
        drawHeader(doc, theme, pageWidth);
        y = PAGE_CONTENT_TOP;
      }

      function newPage() {
        drawFooter(doc, theme, pageNum, pageWidth, pageHeight, meta.footerBrand);
        doc.addPage();
        pageNum += 1;
        startPage();
      }

      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) {
          newPage();
        }
      }

      startPage();

      // Cover — once, at the very top of the bank. (The "how to read this
      // bank" legend that used to follow the cover has been removed per
      // request; the first chapter banner now follows the cover directly.)
      const coverM = measureCover(doc, data.meta, contentWidth);
      ensureSpace(coverM.height);
      drawCover(doc, theme, data.meta, coverM, contentX, y, contentWidth);
      y += coverM.height + 18;

      data.chapters.forEach((chapter, chapterIdx) => {
        // page-break-before: always on every chapter banner except the
        // first (template's .chapter-banner:first-of-type override).
        if (chapterIdx > 0) newPage();

        const bannerM = measureChapterBanner(doc, chapter, contentWidth);
        ensureSpace(bannerM.height);
        drawChapterBanner(doc, theme, chapter, bannerM, contentX, y, contentWidth);
        y += bannerM.height + 10;

        let currentSub = null;
        chapter.questions.forEach((q) => {
          if (q.subchapter && q.subchapter !== currentSub) {
            currentSub = q.subchapter;
            const subM = measureSubchapterBanner(doc, q.subchapter, contentWidth);
            ensureSpace(subM.height + 8);
            drawSubchapterBanner(doc, theme, subM, contentX, y, contentWidth);
            y += subM.height + 8;
          }

          const cardM = measureCard(doc, q, contentWidth);
          ensureSpace(cardM.height + 6);
          drawCard(doc, theme, q, cardM, contentX, y, contentWidth);
          y += cardM.height + 6;
        });

        // Answer-key table for this chapter.
        y += 4;
        ensureSpace(TABLE_HEADER_H + 24);
        drawTableHeader(doc, theme, contentX, y, contentWidth);
        y += TABLE_HEADER_H;

        let ansSub = null;
        let stripe = false;
        chapter.questions.forEach((q) => {
          if (q.subchapter && q.subchapter !== ansSub) {
            ansSub = q.subchapter;
            const subM = measureSubRow(doc, q.subchapter, contentWidth);
            if (y + subM.height > pageHeight - FOOTER_H - 14) {
              newPage();
              ensureSpace(TABLE_HEADER_H);
              drawTableHeader(doc, theme, contentX, y, contentWidth);
              y += TABLE_HEADER_H;
            }
            drawSubRow(doc, theme, subM, contentX, y, contentWidth);
            y += subM.height;
            stripe = false;
          }

          const rowM = measureAnswerRow(doc, q, contentWidth);
          if (y + rowM.height > pageHeight - FOOTER_H - 14) {
            newPage();
            drawTableHeader(doc, theme, contentX, y, contentWidth);
            y += TABLE_HEADER_H;
          }
          drawAnswerRow(doc, theme, q, rowM, contentX, y, contentWidth, stripe);
          y += rowM.height;
          stripe = !stripe;
        });

        y += 24;
      });

      drawFooter(doc, theme, pageNum, pageWidth, pageHeight, meta.footerBrand);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateMcqPdf };
