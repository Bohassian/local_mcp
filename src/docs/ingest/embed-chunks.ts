import type { Embed } from '../../embed.js';

// The text sent to the embedding model (the stored chunk keeps the original).
// Runs of -, =, +, | (RST tables, underlines) cost about a token per char and
// mean nothing, so collapse them.
export function embeddingText(chunk: string): string {
  return chunk
    .replace(/[-=+|~^*#_]{3,}/g, ' ')
    .replace(/[ \t]*\|[ \t]*/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

const tooLong = (err: unknown) => err instanceof Error && err.message.includes('exceeds the context length');

// Embeds a batch. If Ollama rejects it for length, embeds one at a time,
// halving any input that still doesn't fit (and logging that it did).
export async function embedChunks(embed: Embed, texts: string[], label: (i: number) => string): Promise<number[][]> {
  try {
    return await embed(texts);
  } catch (err) {
    if (!tooLong(err)) throw err;
  }
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    let input = texts[i];
    for (;;) {
      try {
        out.push((await embed([input]))[0]);
        break;
      } catch (err) {
        if (!tooLong(err) || input.length < 200) throw err;
        input = input.slice(0, Math.floor(input.length / 2));
        console.warn(`\n[warn] ${label(i)} too long to embed; truncated to ${input.length} chars`);
      }
    }
  }
  return out;
}
