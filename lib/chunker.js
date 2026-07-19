// Splits each page's text into ~chunkWords-word chunks with overlap,
// tagging every chunk with its source page number.
// Word-count is used as a cheap proxy for tokens (Arabic/English
// mixed text runs roughly 1.3-1.6 tokens per word).
function chunkPages(pages, { chunkWords = 450, overlapWords = 60 } = {}) {
  const chunks = [];

  for (const page of pages) {
    const words = page.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    let start = 0;
    while (start < words.length) {
      const end = Math.min(start + chunkWords, words.length);
      const content = words.slice(start, end).join(' ').trim();
      if (content) {
        chunks.push({ content, page_number: page.page_number });
      }
      if (end === words.length) break;
      start = end - overlapWords;
    }
  }

  return chunks;
}

module.exports = { chunkPages };
