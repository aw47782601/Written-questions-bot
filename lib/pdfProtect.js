// Copy-protection for PDFKit documents: the page looks identical, but
// selecting + copying text yields random symbols.
//
// How: every embedded font carries a /ToUnicode table that viewers use for
// copy/paste and text search (the glyph shapes themselves are never read).
// PDFKit builds that table from `font.unicode` (gid -> codepoints) right
// before writing the font, which happens inside doc.end(). protectPdf(doc)
// wraps doc.end() on THIS document instance only, so each embedded font's
// toUnicodeCmap() maps every glyph to a unique random symbol instead.
// Other designs are untouched. The mapping is regenerated per PDF.
//
// Limits: OCR / screenshots still work, and in-PDF text search stops working.

// ~1,400 symbols: math operators, misc technical, shapes, misc symbols, dingbats.
const POOL_RANGES = [
  [0x2200, 0x23ff],
  [0x25a0, 0x27bf],
];

function buildPool() {
  const pool = [];
  for (const [a, b] of POOL_RANGES) for (let c = a; c <= b; c++) pool.push(c);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function scrambleFont(font) {
  if (!font || typeof font.toUnicodeCmap !== 'function' || font.__pdfProtected) return;
  font.__pdfProtected = true;
  const orig = font.toUnicodeCmap.bind(font);
  font.toUnicodeCmap = function () {
    const pool = buildPool();
    let n = 0;
    this.unicode = this.unicode.map((cps, gid) => {
      if (gid === 0) return cps; // keep .notdef
      return [pool[n++ % pool.length]];
    });
    return orig();
  };
}

function protectPdf(doc) {
  const origEnd = doc.end.bind(doc);
  doc.end = function (...args) {
    try {
      new Set(Object.values(doc._fontFamilies || {})).forEach(scrambleFont);
    } catch (_) {
      // never break PDF delivery because of the protection layer
    }
    return origEnd(...args);
  };
  return doc;
}

module.exports = { protectPdf };
