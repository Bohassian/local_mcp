import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Embed } from '../../embed.js';
import { embedChunks, embeddingText } from './embed-chunks.js';

describe('embeddingText', () => {
  it('collapses table borders and underlines, which cost tokens but carry no meaning', () => {
    const rst = 'Title\n=====\n\n+-----+-----+\n| a   | b   |\n+-----+-----+';
    assert.equal(embeddingText(rst), 'Title\n \n\n \n | a | b | \n ');
  });
});

describe('embedChunks', () => {
  // A stand-in for Ollama that, like the real model, rejects any input over
  // its context length. Each vector is just [input length].
  const LIMIT = 300;
  const calls: string[][] = [];
  const fakeEmbed: Embed = async (texts) => {
    calls.push(texts);
    if (texts.some((t) => t.length > LIMIT)) throw new Error('the input length exceeds the context length');
    return texts.map((t) => [t.length]);
  };

  it('embeds a batch in one call when everything fits', async () => {
    calls.length = 0;
    assert.deepEqual(await embedChunks(fakeEmbed, ['ab', 'cde'], String), [[2], [3]]);
    assert.equal(calls.length, 1);
  });

  it('falls back to one at a time, halving any text that is still too long', async () => {
    calls.length = 0;
    const vectors = await embedChunks(fakeEmbed, ['short', 'y'.repeat(1000)], String);
    // 1000 -> 500 -> 250 chars before it fits. The vector order still matches the input.
    assert.deepEqual(vectors, [[5], [250]]);
  });

  it('rethrows errors that are not about length', async () => {
    const broken: Embed = async () => {
      throw new Error('connection refused');
    };
    await assert.rejects(embedChunks(broken, ['a'], String), /connection refused/);
  });
});
