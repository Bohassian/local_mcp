import { config } from './config.js';

// Turns text into vectors with an Ollama embedding model.

// Texts in, one vector per text out, in the same order.
export type Embed = (texts: string[]) => Promise<number[][]>;

export function ollamaEmbed(model: string, baseUrl = config.embedUrl): Embed {
  const url = `${baseUrl.replace(/\/$/, '')}/api/embed`;

  return async (texts) => {
    if (texts.length === 0) return [];

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      // Keep Ollama's message: ingest looks for "exceeds the context length".
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama embed failed: ${res.status} ${res.statusText} — ${detail}`);
    }

    const { embeddings } = (await res.json()) as { embeddings?: number[][] };
    if (embeddings?.length !== texts.length) {
      throw new Error(`Ollama returned ${embeddings?.length ?? 0} vectors for ${texts.length} texts`);
    }
    return embeddings;
  };
}
