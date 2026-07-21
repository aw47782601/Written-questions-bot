// Preset "main color" choices for the PDF design, plus a small HSL-based
// color engine that derives a full theme (dark accent for headings/badges,
// a pale cream card background, a soft divider tint, etc.) from a single
// base hex color.
//
// The original design only ever had one hand-picked palette (orange:
// #F2A93B for the accent, #D9791A for the darker accent text, #FBF3E0 for
// the card background, #DCCEA9 for the divider). Rather than hand-picking
// four more hex codes for every new color a user might want, the relationship
// between those four original values and the base orange was reverse
// -engineered once (see the tuning notes below) into fixed HSL offsets, so
// the same formula reproduces the original orange theme almost exactly and
// generalizes to any base color — adding a new preset is just one new hex
// value in PDF_COLOR_PRESETS, no new derived colors to invent by hand.
//
// text/gray (body copy + the small page-citation label) intentionally stay
// close to neutral across every theme — they're read as plain body text,
// not as the design's accent, so they shouldn't shift much with it.

// --- hex <-> HSL -----------------------------------------------------------

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

function rgbToHex(r, g, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  const toHex = (n) => clamp(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const delta = max - min;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = 60 * (((g - b) / delta) % 6);
        break;
      case g:
        h = 60 * ((b - r) / delta + 2);
        break;
      default:
        h = 60 * ((r - g) / delta + 4);
    }
  }
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

function hexToHsl(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

function hslToHex(h, s, l) {
  const { r, g, b } = hslToRgb(h, s, Math.max(0, Math.min(100, l)));
  return rgbToHex(r, g, b);
}

// --- theme derivation --------------------------------------------------

// Fixed HSL offsets tuned so base='#F2A93B' reproduces the original
// hand-picked orange theme (orangeDark #D9791A, cream #FBF3E0, divider
// #DCCEA9) closely.
function deriveTheme(baseHex) {
  const { h, s, l } = hexToHsl(baseHex);
  return {
    orange: baseHex.toUpperCase(),
    orangeDark: hslToHex(h, s * 0.9, Math.max(0, l - 12)),
    cream: hslToHex(h, s * 0.5, 93),
    border: baseHex.toUpperCase(),
    text: '#232323',
    gray: hslToHex(h, s * 0.11, 49),
    white: '#FFFFFF',
    divider: hslToHex(h, s * 0.48, 76),
  };
}

// --- presets -------------------------------------------------------------
// key -> { label, emoji, base }. `emoji` is the Telegram circle used as a
// quick visual swatch in the /pdfcolor picker keyboard.
const PDF_COLOR_PRESETS = {
  orange: { label: 'Orange', emoji: '🟠', base: '#F2A93B' },
  red: { label: 'Red', emoji: '🔴', base: '#E0403F' },
  gold: { label: 'Gold', emoji: '🟡', base: '#E0B400' },
  green: { label: 'Green', emoji: '🟢', base: '#3FA34D' },
  blue: { label: 'Blue', emoji: '🔵', base: '#3B82C4' },
  purple: { label: 'Purple', emoji: '🟣', base: '#8B5CF2' },
  brown: { label: 'Brown', emoji: '🟤', base: '#A9702F' },
  graphite: { label: 'Graphite', emoji: '⚫', base: '#4A4A4A' },
};

const DEFAULT_PDF_COLOR = 'orange';

function isValidPdfColor(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(PDF_COLOR_PRESETS, key);
}

function listPdfColors() {
  return Object.entries(PDF_COLOR_PRESETS).map(([key, v]) => ({ key, ...v }));
}

// Returns the full drawing-ready COLORS object (see lib/pdfGenerator.js)
// for a given preset key, falling back to the default color for an
// unknown/missing key. The default orange theme uses the original
// hand-picked values exactly (rather than the algorithmic approximation)
// so existing users see zero visual change; every other color is derived.
const ORIGINAL_ORANGE_THEME = {
  orange: '#F2A93B',
  orangeDark: '#D9791A',
  cream: '#FBF3E0',
  border: '#F2A93B',
  text: '#232323',
  gray: '#8A8272',
  white: '#FFFFFF',
  divider: '#DCCEA9',
};

function getColorTheme(key) {
  if (!key || key === DEFAULT_PDF_COLOR) return { ...ORIGINAL_ORANGE_THEME };
  const preset = PDF_COLOR_PRESETS[key];
  if (!preset) return { ...ORIGINAL_ORANGE_THEME };
  return deriveTheme(preset.base);
}

module.exports = {
  PDF_COLOR_PRESETS,
  DEFAULT_PDF_COLOR,
  isValidPdfColor,
  listPdfColors,
  getColorTheme,
  deriveTheme, // exported for testing
};
