// Renders a full MCQ "bank" — { meta, chapters[] } shaped exactly like
// converter.py's MCQBank pydantic schema / template.html's Jinja2 render
// context — as a styled PDF.
//
// This REPLACES the old single-flat-array pdfDesignMcq.js design (one
// continuous `questions` list, cards with the correct option highlighted
// inline, no cover/howto/answer-key). That design and this one are not
// visually compatible, so this file targets converter.py's HTML/Playwright
// design 100%, reproduced in PDFKit primitives instead of Chromium:
//
//   1. Cover page          (.cover)               — title/subtitle/pill
//   2. "How to read" box   (.howto)                — 4 legend lines
//   3. Chapter banner      (.chapter-banner)       — page-break-before
//   4. Subchapter banner   (.subchapter-banner)    — inline, on change
//   5. Question card       (.qcard-wrap/.qcard)    — numbered badge,
//      VIP pill, plain lettered option circles (NOT highlighted — the
//      template never marks the correct option inside the card itself)
//   6. Flag note           (.flag)
//   7. Per-chapter answer key table (table.akey)   — Q# / Correct / Exp,
//      with subchapter divider sub-rows
//
// Header/footer chrome (two checkerboard bands + "BY M.E.M" wordmark +
// page number) is drawn natively in PDFKit per page — visually equivalent
// to converter.py's post-render PyMuPDF stamping step
// (_stamp_checker_bands), just done inline instead of as a second pass.
//
// Color system mirrors converter.py's resolve_theme()/build_theme_from_hex()
// exactly (same COLOR_THEMES table + same hex-derivation formula), NOT the
// old pdfDesignMcq.js orange/coral palette — key names match template.html's
// `c.*` Jinja variables one-for-one: primary, primary_dark, vip_bg,
// vip_text, opt_bg, row_alt, correct_text.
//
// Input shape — data: { meta: { title, subtitle, total_questions,
// total_chapters }, chapters: [ { name, questions: [ { number, text,
// subchapter, vip, flag, options: [{letter, text}], unanswered,
// correct_letter, correct_text, explanation } ] } ] } — i.e. exactly the
// JSON a "questions_*.json" MCQBank file from the extraction pipeline
// contains. meta (2nd arg): { colorKey, footerBrand } — colorKey is a
// COLOR_THEMES key ('blue'|'green'|'purple'|'red'|'dark') or a custom hex
// string, resolved the same way converter.py's resolve_theme() does.
const PDFDocument = require('pdfkit');
const path = require('path');
const { isMostlyArabic, shapeArabicLine, wrapWordsByWidth } = require('./textShaping');

// --- Fonts -------------------------------------------------------------
// template.html's primary face is "Childos Arabic SemiBold" with
// "Integrated Fallback" (Fredoka) / system-UI fonts behind it. Only the
// Arabic-Naskh + ComicNeue + Fredoka trio ship as real font files in this
// repo's assets, so — same as the old pdfDesignMcq.js — those are what
// get registered and used; PDFKit has no CSS font-stack fallback, so this
// is the closest 1:1 substitution available for the shipped asset set.
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

// --- Color themes — verbatim port of converter.py's COLOR_THEMES table +
// build_theme_from_hex()/resolve_theme() derivation logic --------------
const COLOR_THEMES = {
  blue: {
    primary: '#2563eb', primary_dark: '#1e3a8a',
    vip_bg: '#f59e0b', vip_text: '#ffffff',
    opt_bg: '#dbeafe', row_alt: '#eff6ff', correct_text: '#1e3a8a',
  },
  green: {
    primary: '#16a34a', primary_dark: '#14532d',
    vip_bg: '#f59e0b', vip_text: '#ffffff',
    opt_bg: '#dcfce7', row_alt: '#f0fdf4', correct_text: '#15803d',
  },
  purple: {
    primary: '#7c3aed', primary_dark: '#4c1d95',
    vip_bg: '#f59e0b', vip_text: '#ffffff',
    opt_bg: '#ede9fe', row_alt: '#f5f3ff', correct_text: '#6d28d9',
  },
  red: {
    primary: '#dc2626', primary_dark: '#7f1d1d',
    vip_bg: '#111827', vip_text: '#fbbf24',
    opt_bg: '#fee2e2', row_alt: '#fef2f2', correct_text: '#b91c1c',
  },
  dark: {
    primary: '#334155', primary_dark: '#0f172a',
    vip_bg: '#f59e0b', vip_text: '#111827',
    opt_bg: '#e2e8f0', row_alt: '#f8fafc', correct_text: '#0f172a',
  },
};
const DEFAULT_PDF_COLOR = 'blue';

const HEX_RE = /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/;
function isValidHexColor(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}
function expandShorthandHex(v) {
  if (typeof v !== 'string') return '#2563eb';
  let s = v.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return '#' + s;
}
function hexToRgb(hex) {
  if (typeof hex !== 'string') return [37, 99, 235];
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length !== 6) return [37, 99, 235];
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return [37, 99, 235];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function mix(rgb, target, amount) {
  return rgb.map((c, i) => c + (target[i] - c) * amount);
}
function relativeLuminance([r, g, b]) {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
}
function buildThemeFromHex(hexColor) {
  const hex = expandShorthandHex(hexColor);
  const primaryRgb = hexToRgb(hex);
  const primaryDarkRgb = mix(primaryRgb, [0, 0, 0], 0.45);
  const optBgRgb = mix(primaryRgb, [255, 255, 255], 0.85);
  const rowAltRgb = mix(primaryRgb, [255, 255, 255], 0.94);
  const light = relativeLuminance(primaryRgb) < 0.25;
  return {
    primary: rgbToHex(primaryRgb),
    primary_dark: rgbToHex(primaryDarkRgb),
    vip_bg: light ? '#111827' : '#f59e0b',
    vip_text: light ? '#fbbf24' : '#ffffff',
    opt_bg: rgbToHex(optBgRgb),
    row_alt: rgbToHex(rowAltRgb),
    correct_text: rgbToHex(primaryDarkRgb),
  };
}
function resolveTheme(colorSpec) {
  if (colorSpec && COLOR_THEMES[colorSpec]) return COLOR_THEMES[colorSpec];
  if (isValidHexColor(colorSpec)) return buildThemeFromHex(colorSpec);
  return COLOR_THEMES[DEFAULT_PDF_COLOR];
}

// Fixed neutral tones the HTML template hardcodes outside the `c.*` theme
// object (body text color, card fill/border, table row border, gray text).
const NEUTRAL = {
  bodyText: '#1f2937',
  cardFill: '#F1EAD0',
  cardBorder: '#e2dac0',
  howtoBorder: '#e5e7eb',
  howtoBg: '#fafafa',
  howtoText: '#374151',
  flagText: '#b45309',
  tableBorder: '#e5e7eb',
  tableExpText: '#4b5563',
  white: '#ffffff',
};

// --- Layout constants ----------------------------------------------------
const PAGE_MARGIN = 36;
const CHECKER_SIZE = 28;

const HEADER_H = CHECKER_SIZE * 2;
const PAGE_CONTENT_TOP = HEADER_H + 22;

const FOOTER_CHECKER_H = CHECKER_SIZE * 2;
const FOOTER_TOP_PAD = 10;
const FOOTER_H = FOOTER_TOP_PAD + FOOTER_CHECKER_H;

const COVER_PAD_X = 26;
const COVER_PAD_Y = 22;
const COVER_TITLE_SIZE = 22;
const COVER_SUB_SIZE = 12.5;
const COVER_GAP = 12;
const COVER_PILL_SIZE = 12;

const HOWTO_PAD_X = 18;
const HOWTO_PAD_Y = 14;
const HOWTO_TITLE_SIZE = 13.5;
const HOWTO_LINE_SIZE = 11.5;
const HOWTO_LINE_H = 15;

const CHAPTER_BANNER_PAD_X = 18;
const CHAPTER_BANNER_PAD_Y = 12;
const CHAPTER_TITLE_SIZE = 16;
const CHAPTER_COUNT_SIZE = 11.5;

const SUBCHAPTER_PAD_X = 14;
const SUBCHAPTER_PAD_Y = 8;
const SUBCHAPTER_SIZE = 13;
const SUBCHAPTER_MARGIN_TOP = 18;
const SUBCHAPTER_MARGIN_BOTTOM = 12;
const SUBCHAPTER_ACCENT_W = 4;

const CARD_MARGIN_L = 14;
const CARD_MARGIN_R = 12;
const CARD_MARGIN_BOTTOM = 14;
const CARD_PAD_TOP = 13;
const CARD_PAD_RIGHT = 18;
const CARD_PAD_BOTTOM = 13;
const CARD_PAD_LEFT = 42; // room for the overlapping qnum badge
const QNUM_R = 14;
const QTEXT_SIZE = 13.5;
const QTEXT_LINE_H = 17;
const VIP_SIZE = 9.5;
const OPTION_SIZE = 12.5;
const OPTION_LINE_H = 16;
const OLETTER_R = 10.5;
const OLETTER_GAP = 8;
const OPTION_ROW_GAP = 5;
const FLAG_SIZE = 11.5;
const QHEAD_GAP = 8;
const OPTS_BLOCK_GAP = 8;

const TABLE_ROW_PAD_X = 10;
const TABLE_ROW_PAD_Y = 8;
const TABLE_HEADER_SIZE = 12;
const TABLE_CELL_SIZE = 11.5;
const TABLE_CELL_LINE_H = 14;
const TABLE_SUB_SIZE = 11.5;
const TABLE_MARGIN_TOP = 14;
const TABLE_MARGIN_BOTTOM = 24;
// column widths as fractions of content width: Q# 8%, Answer 24%, Exp 68%
const COL_NUM = 0.08;
const COL_ANS = 0.24;
const COL_EXP = 0.68;

// ---------------------------------------------------------------------
// Text measuring / drawing helpers (generic wrap+shape, no run-level
// bold-tracking — none of this design's text needs it).
// ---------------------------------------------------------------------
function wrapPlain(doc, text, font, arabicFont, size, lineHeight, maxWidth) {
  const raw = String(text == null ? '' : text);
  const arabic = isMostlyArabic(raw);
  const words = raw.split(/\s+/).filter(Boolean);
  const lines = wrapWordsByWidth(doc, words, arabic ? arabicFont : font, size, maxWidth);
  const shapedLines = arabic ? lines.map((l) => shapeArabicLine(l)) : lines;
  return { arabic, lines: shapedLines, height: Math.max(shapedLines.length, 1) * lineHeight };
}

function drawWrapped(doc, measured, x, y, width, font, arabicFont, size, lineHeight, color, align) {
  doc.font(measured.arabic ? arabicFont : font).fontSize(size).fillColor(color);
  measured.lines.forEach((line, i) => {
    const ly = y + i * lineHeight;
    if (measured.arabic) {
      const w = doc.widthOfString(line);
      const rightAlignX = x + Math.max(0, width - w);
      doc.text(line, align === 'center' ? x + Math.max(0, (width - w) / 2) : rightAlignX, ly, { lineBreak: false });
    } else if (align === 'center') {
      doc.text(line, x, ly, { width, align: 'center', lineBreak: false });
    } else {
      doc.text(line, x, ly, { lineBreak: false });
    }
  });
}

function cleanCell(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return (s === '' || s === 'None' || s === 'none' || s === 'null') ? '' : s;
}

// --- Header/footer chrome (checkerboard + "BY M.E.M" + page number) —
// equivalent to converter.py's post-render PyMuPDF _stamp_checker_bands,
// drawn natively per-page instead of stamped as a second pass. ----------
function drawCheckerStrip(doc, color, x, y, width, squareSize, rowIndex = 0, gaps = []) {
  const cols = Math.ceil(width / squareSize);
  doc.save();
  for (let i = 0; i < cols; i++) {
    const sx = x + i * squareSize;
    const sx2 = sx + squareSize;
    const inGap = gaps.some((g) => sx < g.x2 && sx2 > g.x1);
    if (inGap) continue;
    if ((i + rowIndex) % 2 === 0) {
      doc.rect(sx, y, squareSize, squareSize).fill(color);
    }
  }
  doc.restore();
}

function drawHeader(doc, colors, pageWidth) {
  drawCheckerStrip(doc, colors.primary, 0, 0, pageWidth, CHECKER_SIZE, 0);
  drawCheckerStrip(doc, colors.primary, 0, CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);
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

function drawFooter(doc, colors, pageNum, pageWidth, pageHeight, brand) {
  const checkerY = pageHeight - FOOTER_CHECKER_H;
  const upperRowY = checkerY;

  const brandText = (brand || DEFAULT_FOOTER_BRAND).toUpperCase();
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  const brandW = doc.widthOfString(brandText);
  const brandGap = gridGapCenteredAt(pageWidth / 2, FOOTER_BRAND_GAP_BOXES, CHECKER_SIZE);
  const brandX = brandGap.x1 + ((brandGap.x2 - brandGap.x1) - brandW) / 2;

  const pageNumText = String(pageNum);
  doc.font(FONT_BOLD).fontSize(FOOTER_PAGE_NUM_SIZE);
  const numW = doc.widthOfString(pageNumText);
  const numBoxes = oddBoxCountFor(numW + FOOTER_GAP_PAD * 2, CHECKER_SIZE);
  const numGap = gridGapCenteredAt(pageWidth - PAGE_MARGIN - numW / 2, numBoxes, CHECKER_SIZE);
  const numX1 = numGap.x1 + ((numGap.x2 - numGap.x1) - numW) / 2;

  drawCheckerStrip(doc, colors.primary, 0, checkerY, pageWidth, CHECKER_SIZE, 0, [brandGap, numGap]);
  drawCheckerStrip(doc, colors.primary, 0, checkerY + CHECKER_SIZE, pageWidth, CHECKER_SIZE, 1);

  const brandY = upperRowY + (CHECKER_SIZE - FOOTER_WATERMARK_SIZE) / 2 - 6;
  doc.font(FONT_HEADING).fontSize(FOOTER_WATERMARK_SIZE);
  doc.fillColor(colors.primary).strokeColor(colors.primary_dark).lineWidth(0.5);
  doc.text(brandText, brandX, brandY, { lineBreak: false, characterSpacing: 1.5, fill: true, stroke: true });

  const numY = upperRowY + (CHECKER_SIZE - FOOTER_PAGE_NUM_SIZE) / 2;
  doc.font(FONT_BOLD).fontSize(FOOTER_PAGE_NUM_SIZE).fillColor(colors.primary_dark);
  doc.text(pageNumText, numX1, numY, { lineBreak: false });
}

// --- .cover ---------------------------------------------------------------
function drawCover(doc, colors, meta, x, y, width) {
  const titleM = wrapPlain(doc, meta.title || 'MCQ Bank', FONT_HEADING, FONT_ARABIC_BOLD, COVER_TITLE_SIZE, COVER_TITLE_SIZE + 4, width - COVER_PAD_X * 2);
  const subM = meta.subtitle ? wrapPlain(doc, meta.subtitle, FONT_REGULAR, FONT_ARABIC_REGULAR, COVER_SUB_SIZE, COVER_SUB_SIZE + 4, width - COVER_PAD_X * 2) : null;

  const pillText = `${meta.total_questions || 0} Questions | ${meta.total_chapters || 0} Chapters`;
  doc.font(FONT_BOLD).fontSize(COVER_PILL_SIZE);
  const pillTextW = doc.widthOfString(pillText);
  const pillH = COVER_PILL_SIZE + 12;
  const pillW = pillTextW + 28;

  const innerH = titleM.height + 4 + (subM ? subM.height + COVER_GAP : COVER_GAP) + pillH;
  const coverH = innerH + COVER_PAD_Y * 2;

  doc.roundedRect(x, y, width, coverH, 10).fill(colors.primary);

  let cy = y + COVER_PAD_Y;
  drawWrapped(doc, titleM, x + COVER_PAD_X, cy, width - COVER_PAD_X * 2, FONT_HEADING, FONT_ARABIC_BOLD, COVER_TITLE_SIZE, COVER_TITLE_SIZE + 4, NEUTRAL.white);
  cy += titleM.height + 4;
  if (subM) {
    doc.save();
    doc.fillOpacity(0.92);
    drawWrapped(doc, subM, x + COVER_PAD_X, cy, width - COVER_PAD_X * 2, FONT_REGULAR, FONT_ARABIC_REGULAR, COVER_SUB_SIZE, COVER_SUB_SIZE + 4, NEUTRAL.white);
    doc.restore();
    cy += subM.height + COVER_GAP;
  } else {
    cy += COVER_GAP;
  }

  doc.save();
  doc.fillOpacity(0.2);
  doc.roundedRect(x + COVER_PAD_X, cy, pillW, pillH, pillH / 2).fill(NEUTRAL.white);
  doc.restore();
  doc.roundedRect(x + COVER_PAD_X, cy, pillW, pillH, pillH / 2).lineWidth(1).strokeOpacity(0.4).stroke(NEUTRAL.white);
  doc.font(FONT_BOLD).fontSize(COVER_PILL_SIZE).fillColor(NEUTRAL.white);
  doc.text(pillText, x + COVER_PAD_X, cy + (pillH - COVER_PILL_SIZE) / 2 - 1, { width: pillW, align: 'center', lineBreak: false });

  return coverH;
}

// --- .howto -----------------------------------------------------------
const HOWTO_LINES = [
  ['\u2460', 'Question Badge', '\u2014 Sequential continuous order across the bank'],
  ['\u2460(A)', 'Option Badge', '\u2014 Original choice preserved and normalized'],
  ['\u2B50', 'VIP MCQS', '\u2014 High-yield exam priority marker'],
  ['\uD83D\uDCD6', 'Answer & Explanation Table', '\u2014 Provided systematically after every chapter'],
];

function drawHowto(doc, colors, x, y, width) {
  const innerW = width - HOWTO_PAD_X * 2;
  const boxH = HOWTO_PAD_Y * 2 + HOWTO_TITLE_SIZE + 8 + HOWTO_LINES.length * HOWTO_LINE_H;

  doc.roundedRect(x, y, width, boxH, 10).fillAndStroke(NEUTRAL.howtoBg, NEUTRAL.howtoBorder);

  let ly = y + HOWTO_PAD_Y;
  doc.font(FONT_BOLD).fontSize(HOWTO_TITLE_SIZE).fillColor(colors.primary_dark);
  doc.text('HOW TO READ THIS BANK', x + HOWTO_PAD_X, ly, { lineBreak: false });
  ly += HOWTO_TITLE_SIZE + 8;

  HOWTO_LINES.forEach(([icon, label, rest]) => {
    doc.font(FONT_BOLD).fontSize(HOWTO_LINE_SIZE).fillColor(NEUTRAL.howtoText);
    doc.text(`${icon} `, x + HOWTO_PAD_X, ly, { continued: true, lineBreak: false, width: innerW });
    doc.font(FONT_BOLD).text(`${label} `, { continued: true, lineBreak: false });
    doc.font(FONT_REGULAR).text(rest, { lineBreak: false });
    ly += HOWTO_LINE_H;
  });

  return boxH;
}

// --- .chapter-banner ----------------------------------------------------
function drawChapterBanner(doc, colors, chapter, x, y, width) {
  const nameM = wrapPlain(doc, chapter.name, FONT_BOLD, FONT_ARABIC_BOLD, CHAPTER_TITLE_SIZE, CHAPTER_TITLE_SIZE + 3, width - CHAPTER_BANNER_PAD_X * 2);
  const countText = `${(chapter.questions || []).length} Questions`;
  const h = CHAPTER_BANNER_PAD_Y * 2 + nameM.height + 4 + CHAPTER_COUNT_SIZE;

  doc.roundedRect(x, y, width, h, 8).fill(colors.primary_dark);
  let ly = y + CHAPTER_BANNER_PAD_Y;
  drawWrapped(doc, nameM, x + CHAPTER_BANNER_PAD_X, ly, width - CHAPTER_BANNER_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, CHAPTER_TITLE_SIZE, CHAPTER_TITLE_SIZE + 3, NEUTRAL.white);
  ly += nameM.height + 4;
  doc.save();
  doc.fillOpacity(0.88);
  doc.font(FONT_REGULAR).fontSize(CHAPTER_COUNT_SIZE).fillColor(NEUTRAL.white);
  doc.text(countText, x + CHAPTER_BANNER_PAD_X, ly, { lineBreak: false });
  doc.restore();

  return h;
}

// --- .subchapter-banner ---------------------------------------------------
function measureSubchapterBanner(doc, colors, name, width) {
  const m = wrapPlain(doc, name, FONT_BOLD, FONT_ARABIC_BOLD, SUBCHAPTER_SIZE, SUBCHAPTER_SIZE + 3, width - SUBCHAPTER_PAD_X * 2);
  return { m, height: SUBCHAPTER_PAD_Y * 2 + m.height };
}
function drawSubchapterBanner(doc, colors, measured, x, y, width) {
  doc.roundedRect(x, y, width, measured.height, 6).fill(colors.opt_bg);
  doc.rect(x, y, SUBCHAPTER_ACCENT_W, measured.height).fill(colors.primary);
  drawWrapped(doc, measured.m, x + SUBCHAPTER_PAD_X, y + SUBCHAPTER_PAD_Y, width - SUBCHAPTER_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, SUBCHAPTER_SIZE, SUBCHAPTER_SIZE + 3, colors.primary_dark);
}

// --- .qcard / .qnum / .opt (plain, un-highlighted — matches template) --
function measureOption(doc, letter, text, width) {
  const textX = OLETTER_R * 2 + OLETTER_GAP;
  const textWidth = Math.max(10, width - textX);
  const m = wrapPlain(doc, text, FONT_REGULAR, FONT_ARABIC_REGULAR, OPTION_SIZE, OPTION_LINE_H, textWidth);
  return { ...m, letter, textX, textWidth, height: Math.max(m.height, OLETTER_R * 2) };
}
function drawOption(doc, colors, measured, x, y, width) {
  const markerCx = x + OLETTER_R;
  const markerCy = y + measured.height / 2;
  doc.circle(markerCx, markerCy, OLETTER_R).fill(colors.opt_bg);
  doc.font(FONT_BOLD).fontSize(10.5).fillColor(colors.primary_dark);
  doc.text(measured.letter, markerCx - OLETTER_R, markerCy - 5, { width: OLETTER_R * 2, align: 'center', lineBreak: false });

  drawWrapped(
    doc, measured,
    x + measured.textX, y + (measured.height - measured.lines.length * OPTION_LINE_H) / 2,
    measured.textWidth, FONT_REGULAR, FONT_ARABIC_REGULAR, OPTION_SIZE, OPTION_LINE_H, NEUTRAL.bodyText,
  );
}

function measureQCard(doc, colors, q, contentWidth) {
  const textColWidth = contentWidth - CARD_MARGIN_L - CARD_MARGIN_R - CARD_PAD_LEFT - CARD_PAD_RIGHT;
  const qtextM = wrapPlain(doc, q.text, FONT_BOLD, FONT_ARABIC_BOLD, QTEXT_SIZE, QTEXT_LINE_H, textColWidth);

  const optionsWidth = contentWidth - CARD_MARGIN_L - CARD_MARGIN_R - CARD_PAD_LEFT - CARD_PAD_RIGHT;
  const options = Array.isArray(q.options) ? q.options : [];
  const optMeasured = options.map((o) => measureOption(doc, o.letter, o.text, optionsWidth));
  const optionsHeight = optMeasured.reduce((sum, o, i) => sum + o.height + (i > 0 ? OPTION_ROW_GAP : 0), 0);

  const flagM = q.flag ? wrapPlain(doc, `\u26A0 ${q.flag}`, FONT_REGULAR, FONT_ARABIC_REGULAR, FLAG_SIZE, FLAG_SIZE + 3, textColWidth) : null;

  const innerHeight = qtextM.height + QHEAD_GAP + OPTS_BLOCK_GAP + optionsHeight + (flagM ? 5 + flagM.height : 0);
  const cardHeight = innerHeight + CARD_PAD_TOP + CARD_PAD_BOTTOM;

  return { qtextM, optMeasured, flagM, textColWidth, optionsWidth, cardHeight };
}

function drawQCard(doc, colors, q, measured, x, y, contentWidth) {
  const cardX = x + CARD_MARGIN_L;
  const cardWidth = contentWidth - CARD_MARGIN_L - CARD_MARGIN_R;
  const cardHeight = measured.cardHeight;

  doc.roundedRect(cardX, y, cardWidth, cardHeight, 6).fillAndStroke(NEUTRAL.cardFill, NEUTRAL.cardBorder);
  // 4px accent strip standing in for the CSS `border-left: 4px solid`
  doc.rect(cardX, y, 4, cardHeight).fill(colors.primary);

  const textColX = cardX + CARD_PAD_LEFT;
  const textColWidth = measured.textColWidth;

  // qnum badge — absolutely positioned, overlapping the card's top-left
  // edge, with a white ring, exactly like `.qnum { left: -14px; }`
  const badgeCx = cardX;
  const badgeCy = y + CARD_PAD_TOP + QNUM_R - 2;
  doc.circle(badgeCx, badgeCy, QNUM_R + 3).fill(NEUTRAL.white);
  doc.circle(badgeCx, badgeCy, QNUM_R).fill(colors.primary);
  doc.font(FONT_BOLD).fontSize(12).fillColor(NEUTRAL.white);
  doc.text(String(q.number), badgeCx - QNUM_R, badgeCy - 6, { width: QNUM_R * 2, align: 'center', lineBreak: false });

  let curY = y + CARD_PAD_TOP;

  // qhead: question text + optional VIP pill to the right
  let qtextWidth = textColWidth;
  if (q.vip) {
    doc.font(FONT_BOLD).fontSize(VIP_SIZE);
    const vipText = 'VIP MCQS';
    const vipTextW = doc.widthOfString(vipText);
    const vipW = vipTextW + 18;
    const vipH = VIP_SIZE + 8;
    qtextWidth = textColWidth - vipW - 10;
    doc.roundedRect(textColX + textColWidth - vipW, curY, vipW, vipH, vipH / 2).fill(colors.vip_bg);
    doc.font(FONT_BOLD).fontSize(VIP_SIZE).fillColor(colors.vip_text);
    doc.text(vipText, textColX + textColWidth - vipW, curY + (vipH - VIP_SIZE) / 2 - 1, { width: vipW, align: 'center', lineBreak: false });
  }
  drawWrapped(doc, measured.qtextM, textColX, curY, qtextWidth, FONT_BOLD, FONT_ARABIC_BOLD, QTEXT_SIZE, QTEXT_LINE_H, colors.primary_dark);
  curY += measured.qtextM.height + QHEAD_GAP + OPTS_BLOCK_GAP;

  measured.optMeasured.forEach((om) => {
    drawOption(doc, colors, om, textColX, curY, measured.optionsWidth);
    curY += om.height + OPTION_ROW_GAP;
  });
  if (measured.optMeasured.length > 0) curY -= OPTION_ROW_GAP;

  if (measured.flagM) {
    curY += 5;
    drawWrapped(doc, measured.flagM, textColX, curY, textColWidth, FONT_REGULAR, FONT_ARABIC_REGULAR, FLAG_SIZE, FLAG_SIZE + 3, NEUTRAL.flagText);
  }

  return cardHeight + CARD_MARGIN_BOTTOM;
}

// --- table.akey (per-chapter answer key) --------------------------------
function measureAnswerRow(doc, colors, q, colWidths) {
  const unanswered = q.unanswered || !q.correct_letter;
  let ansM = null;
  let expM = null;
  if (!unanswered) {
    const correctText = cleanCell(q.correct_text);
    const ansText = correctText ? `${q.correct_letter}) ${correctText}` : `${q.correct_letter})`;
    ansM = wrapPlain(doc, ansText, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_CELL_SIZE, TABLE_CELL_LINE_H, colWidths.ans - TABLE_ROW_PAD_X * 2);
    const expText = cleanCell(q.explanation) || '\u2014';
    expM = wrapPlain(doc, expText, FONT_REGULAR, FONT_ARABIC_REGULAR, TABLE_CELL_SIZE, TABLE_CELL_LINE_H, colWidths.exp - TABLE_ROW_PAD_X * 2);
  }
  const lines = unanswered ? 1 : Math.max(ansM.lines.length, expM.lines.length, 1);
  const height = lines * TABLE_CELL_LINE_H + TABLE_ROW_PAD_Y * 2;
  return { unanswered, ansM, expM, height };
}

function drawAnswerHeaderRow(doc, colors, x, y, colWidths) {
  const h = TABLE_HEADER_SIZE + TABLE_ROW_PAD_Y * 2 - 2;
  doc.rect(x, y, colWidths.num + colWidths.ans + colWidths.exp, h).fill(colors.primary_dark);
  doc.font(FONT_BOLD).fontSize(TABLE_HEADER_SIZE).fillColor(NEUTRAL.white);
  doc.text('Q#', x + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y - 2, { lineBreak: false });
  doc.text('Correct Answer', x + colWidths.num + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y - 2, { lineBreak: false });
  doc.text('Explanation', x + colWidths.num + colWidths.ans + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y - 2, { lineBreak: false });
  return h;
}

function drawAnswerSubRow(doc, colors, subName, x, y, width) {
  const m = wrapPlain(doc, subName, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_SUB_SIZE, TABLE_SUB_SIZE + 2, width - TABLE_ROW_PAD_X * 2);
  const h = m.height + TABLE_ROW_PAD_Y * 1.75;
  doc.rect(x, y, width, h).fill(colors.opt_bg);
  doc.rect(x, y + h - 2, width, 2).fill(colors.primary);
  drawWrapped(doc, m, x + TABLE_ROW_PAD_X, y + (h - m.height) / 2, width - TABLE_ROW_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_SUB_SIZE, TABLE_SUB_SIZE + 2, colors.primary_dark);
  return h;
}

function drawAnswerRow(doc, colors, q, measured, x, y, colWidths, rowIndex) {
  const totalW = colWidths.num + colWidths.ans + colWidths.exp;
  if (rowIndex % 2 === 1) doc.rect(x, y, totalW, measured.height).fill(colors.row_alt);

  doc.font(FONT_BOLD).fontSize(TABLE_CELL_SIZE).fillColor(NEUTRAL.bodyText);
  doc.text(String(q.number), x + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y, { lineBreak: false });

  if (measured.unanswered) {
    doc.font(FONT_REGULAR).fontSize(TABLE_CELL_SIZE).fillColor(NEUTRAL.tableExpText);
    doc.text('\u2014', x + colWidths.num + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y, { lineBreak: false });
    doc.text('\u2014', x + colWidths.num + colWidths.ans + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y, { lineBreak: false });
  } else {
    drawWrapped(doc, measured.ansM, x + colWidths.num + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y, colWidths.ans - TABLE_ROW_PAD_X * 2, FONT_BOLD, FONT_ARABIC_BOLD, TABLE_CELL_SIZE, TABLE_CELL_LINE_H, colors.correct_text);
    drawWrapped(doc, measured.expM, x + colWidths.num + colWidths.ans + TABLE_ROW_PAD_X, y + TABLE_ROW_PAD_Y, colWidths.exp - TABLE_ROW_PAD_X * 2, FONT_REGULAR, FONT_ARABIC_REGULAR, TABLE_CELL_SIZE, TABLE_CELL_LINE_H, NEUTRAL.tableExpText);
  }

  doc.moveTo(x, y + measured.height).lineTo(x + totalW, y + measured.height).lineWidth(1).stroke(NEUTRAL.tableBorder);
}

// questions/meta: see the file header comment for the exact MCQBank shape.
// meta2: { colorKey, footerBrand }
function generateMcqBankPdf(data, meta2 = {}) {
  return new Promise((resolve, reject) => {
    try {
      const colors = resolveTheme(meta2.colorKey || DEFAULT_PDF_COLOR);
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
      function newPage() {
        drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta2.footerBrand);
        doc.addPage();
        pageNum += 1;
        startPage();
      }
      function ensureSpace(neededHeight) {
        if (y + neededHeight > pageHeight - FOOTER_H - 14) newPage();
      }

      startPage();

      const meta = (data && data.meta) || {};
      const chapters = (data && data.chapters) || [];
      meta.total_questions = meta.total_questions || chapters.reduce((s, ch) => s + (ch.questions || []).length, 0);
      meta.total_chapters = meta.total_chapters || chapters.length;

      // .cover
      const coverH = drawCover(doc, colors, meta, contentX, y, contentWidth);
      y += coverH + 16;

      // .howto
      const howtoH = drawHowto(doc, colors, contentX, y, contentWidth);
      y += howtoH + 18;

      chapters.forEach((chapter, chIdx) => {
        // .chapter-banner — page-break-before: always, except :first-of-type
        if (chIdx > 0) newPage();
        else ensureSpace(60);
        const bannerH = drawChapterBanner(doc, colors, chapter, contentX, y, contentWidth);
        y += bannerH + 16;

        const questions = chapter.questions || [];
        let currentSub = null;
        questions.forEach((q) => {
          if (q.subchapter && q.subchapter !== currentSub) {
            currentSub = q.subchapter;
            const subMeasured = measureSubchapterBanner(doc, colors, q.subchapter, contentWidth);
            ensureSpace(subMeasured.height + SUBCHAPTER_MARGIN_TOP + SUBCHAPTER_MARGIN_BOTTOM);
            y += SUBCHAPTER_MARGIN_TOP;
            drawSubchapterBanner(doc, colors, subMeasured, contentX, y, contentWidth);
            y += subMeasured.height + SUBCHAPTER_MARGIN_BOTTOM;
          }

          const qMeasured = measureQCard(doc, colors, q, contentWidth);
          ensureSpace(qMeasured.cardHeight + CARD_MARGIN_BOTTOM);
          const advance = drawQCard(doc, colors, q, qMeasured, contentX, y, contentWidth);
          y += advance;
        });

        // table.akey — per-chapter answer key, header row repeats if the
        // table spans onto a new page (mirrors a printed HTML <thead>).
        y += TABLE_MARGIN_TOP;
        const colWidths = { num: contentWidth * COL_NUM, ans: contentWidth * COL_ANS, exp: contentWidth * COL_EXP };
        ensureSpace(40);
        let headerH = drawAnswerHeaderRow(doc, colors, contentX, y, colWidths);
        y += headerH;

        let ansSub = null;
        let rowIndex = 0;
        questions.forEach((q) => {
          if (q.subchapter && q.subchapter !== ansSub) {
            ansSub = q.subchapter;
            ensureSpace(30);
            if (y === PAGE_CONTENT_TOP) headerH = drawAnswerHeaderRow(doc, colors, contentX, y, colWidths) && (y += headerH);
            const subRowH = drawAnswerSubRow(doc, colors, q.subchapter, contentX, y, colWidths.num + colWidths.ans + colWidths.exp);
            y += subRowH;
          }
          const rMeasured = measureAnswerRow(doc, colors, q, colWidths);
          ensureSpace(rMeasured.height);
          if (y === PAGE_CONTENT_TOP) { drawAnswerHeaderRow(doc, colors, contentX, y, colWidths); y += headerH; }
          drawAnswerRow(doc, colors, q, rMeasured, contentX, y, colWidths, rowIndex);
          y += rMeasured.height;
          rowIndex += 1;
        });
        y += TABLE_MARGIN_BOTTOM;
      });

      drawFooter(doc, colors, pageNum, pageWidth, pageHeight, meta2.footerBrand);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateMcqBankPdf, resolveTheme, COLOR_THEMES };
