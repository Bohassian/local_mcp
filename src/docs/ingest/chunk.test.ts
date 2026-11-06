import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkText } from './chunk.js';

// Chunking: splitting a section into pieces small enough to embed and to
// return as one search result. See docs/HOW_IT_WORKS.md#chunking.
//
// These tests pass a tiny target (10 "tokens" = 40 chars, hard cap 80) so the
// examples stay readable. Real ingest uses 500 tokens (~2000 chars).

const para = (label: string, length: number) => label.padEnd(length, '.');

describe('chunkText', () => {
  it('keeps a short text as a single chunk', () => {
    assert.deepEqual(chunkText('One short paragraph.'), ['One short paragraph.']);
  });

  it('returns nothing for blank text', () => {
    assert.deepEqual(chunkText('  \n\n  \n'), []);
  });

  it('starts a new chunk once the target size is reached', () => {
    const a = para('A', 25);
    const b = para('B', 25);
    const c = para('C', 25);
    const chunks = chunkText([a, b, c].join('\n\n'), 10);
    // A+B reaches 40 chars, so it is emitted; C starts the next chunk.
    assert.equal(chunks[0], `${a}\n\n${b}`);
    assert.ok(chunks[1].endsWith(c));
  });

  it('repeats the last paragraph of a chunk at the start of the next (overlap)', () => {
    // Overlap keeps a thought that straddles a boundary findable from both
    // sides. Only paragraphs up to half the target size are carried over.
    const a = para('A', 15);
    const b = para('B', 15);
    const c = para('C', 15);
    const d = para('D', 15);
    const chunks = chunkText([a, b, c, d].join('\n\n'), 10);
    assert.deepEqual(chunks, [`${a}\n\n${b}\n\n${c}`, `${c}\n\n${d}`]);
  });

  it('does not emit a final chunk that would only repeat the overlap', () => {
    const a = para('A', 15);
    const b = para('B', 15);
    const c = para('C', 15);
    // A+B+C reaches the target exactly at the end; C would be the overlap,
    // and nothing follows it.
    assert.deepEqual(chunkText([a, b, c].join('\n\n'), 10), [`${a}\n\n${b}\n\n${c}`]);
  });

  it('splits one oversized paragraph at line breaks, then hard-slices long lines', () => {
    // A 200-char single line (like a giant RST table row) with a cap of 80.
    const chunks = chunkText('x'.repeat(200), 10);
    assert.ok(chunks.every((c) => c.length <= 80), `lengths: ${chunks.map((c) => c.length)}`);
    assert.equal(chunks.join('').replace(/\s/g, '').length, 200, 'no characters lost');
  });
});
