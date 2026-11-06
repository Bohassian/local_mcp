import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ollamaEmbed } from '../../embed.js';
import { embeddingText } from '../ingest/embed-chunks.js';
import { DOC_PREFIX, DOCS_DB_PATH, EMBED_MODEL } from '../store.js';

// Embedding drift: re-embeds a random sample of stored chunks with the running
// Ollama and compares each to its vector in docs.db (cosine similarity). Run it
// before and after bumping Ollama: 1.00000 means identical vectors; a median
// around 0.999 is numerical noise; clearly lower means re-ingest. Read-only.
//
//   npm run embed-drift              # 64 chunks
//   npm run embed-drift -- 256

const n = Number(process.argv[2] ?? 64);

const db = new Database(DOCS_DB_PATH, { readonly: true, fileMustExist: true });
sqliteVec.load(db);

const rows = db
  .prepare<[number], { heading: string; text: string; embedding: Buffer }>(
    `SELECT c.heading, c.text, v.embedding FROM chunks c JOIN chunks_vec v ON v.chunk_id = c.id
     WHERE c.id IN (SELECT id FROM chunks ORDER BY random() LIMIT ?)`,
  )
  .all(n);
if (rows.length === 0) throw new Error(`No chunks in ${DOCS_DB_PATH}. Ingest first.`);

const embed = ollamaEmbed(EMBED_MODEL);
const sims: number[] = [];
// Same input text as ingest. Ingest halves the odd chunk that doesn't fit the
// context; those come out lower here without meaning anything changed.
for (let i = 0; i < rows.length; i += 16) {
  const batch = rows.slice(i, i + 16);
  const fresh = await embed(batch.map((r) => `${DOC_PREFIX}${r.heading}\n\n${embeddingText(r.text)}`));
  batch.forEach((r, j) => {
    const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
    sims.push(cosine(stored, fresh[j]));
  });
}
db.close();

sims.sort((a, b) => a - b);
const at = (p: number) => sims[Math.min(sims.length - 1, Math.floor(p * sims.length))].toFixed(5);
console.log(`${EMBED_MODEL}: ${sims.length} chunks`);
console.log(`cosine(stored, fresh): min ${at(0)}  p5 ${at(0.05)}  median ${at(0.5)}  max ${at(1)}`);

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}
