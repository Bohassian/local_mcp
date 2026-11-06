// Why chunk at all: see docs/HOW_IT_WORKS.md#chunks-and-tokens.
//
// Naive paragraph-aware chunker. Targets ~500 tokens per chunk with one
// paragraph of overlap between adjacent chunks. We approximate tokens as
// chars/4 — close enough for retrieval; precision doesn't matter here, the
// vec0 index doesn't care about chunk boundaries.
//
// Chunks are also hard-capped at 2x the target. Without the cap, one huge
// paragraph (RST grid tables, long code blocks) produced chunks of 60k+ chars:
// the embedding model only sees the first 2048 tokens of those, and returning
// a few of them from search_docs would swamp the generator's context window.

const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, targetTokens = 500): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const maxChars = targetChars * 2;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+$/g, ''))
    .filter((p) => p.trim().length > 0)
    .flatMap((p) => splitOversized(p, maxChars));

  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  // The chunk being built: its paragraphs, and their length once joined.
  let current: string[] = [];
  let currentLength = 0;
  // True while `current` holds only the overlap paragraph carried from the last emit.
  let currentIsOnlyOverlap = false;

  for (const paragraph of paragraphs) {
    // Emit before a paragraph that would push the chunk past the hard cap.
    if (current.length > 0 && currentLength + paragraph.length + 2 > maxChars) {
      if (!currentIsOnlyOverlap) chunks.push(current.join('\n\n'));
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraph.length + 2;
    currentIsOnlyOverlap = false;
    if (currentLength >= targetChars) {
      chunks.push(current.join('\n\n'));
      // Carry the last paragraph as overlap into the next chunk so that
      // context isn't sliced mid-thought across chunk boundaries. Skip it
      // when it's large — overlap that big just duplicates most of a chunk.
      if (paragraph.length <= targetChars / 2) {
        current = [paragraph];
        currentLength = paragraph.length + 2;
        currentIsOnlyOverlap = true;
      } else {
        current = [];
        currentLength = 0;
      }
    }
  }

  // Flush the tail unless it's just the leftover overlap paragraph from the
  // last emit (which would duplicate content already in the previous chunk).
  if (current.length > 0 && !currentIsOnlyOverlap) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

// Split a paragraph longer than maxChars on line boundaries, falling back to
// hard slices for single lines that are themselves too long.
function splitOversized(p: string, maxChars: number): string[] {
  if (p.length <= maxChars) return [p];
  const pieces: string[] = [];
  let cur = '';
  for (const line of p.split('\n')) {
    if (line.length > maxChars) {
      if (cur) pieces.push(cur);
      cur = '';
      for (let i = 0; i < line.length; i += maxChars) {
        pieces.push(line.slice(i, i + maxChars));
      }
      continue;
    }
    if (cur && cur.length + line.length + 1 > maxChars) {
      pieces.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}
