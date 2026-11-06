import { parseArgs } from 'node:util';
import { ollamaEmbed } from '../../embed.js';
import { candidateLists, fuse, looksLikeIdentifier, queryTerms, RRF_K, topResults, type SearchMode } from '../search.js';
import { EMBED_MODEL, openStore } from '../store.js';

// Shows the work behind one search: each method's ranking, how fusion scored
// the leading chunks, and the final results. See docs/HOW_IT_WORKS.md.
//
//   yarn explain "move_and_slide floor detection"
//   yarn explain "how do I make my character leap" --sources godot-manual,godot-api
//   yarn explain "where" --sources rails~8.1 --top 15 --mode fts

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    sources: { type: 'string', default: '' },
    top: { type: 'string', default: '10' },
    k: { type: 'string', default: '5' },
    mode: { type: 'string', default: 'hybrid' },
  },
});
const query = positionals.join(' ').trim();
if (!query) {
  console.error('Usage: yarn explain "<query>" [--sources a,b] [--top 10] [--k 5] [--mode hybrid|vector|fts]');
  process.exit(1);
}
const sources = values.sources ? values.sources.split(',').map((s) => s.trim()) : [];
const top = Number(values.top);
const k = Number(values.k);
const mode = values.mode as SearchMode;

const db = openStore();
const embed = ollamaEmbed(EMBED_MODEL);
const describe = db.prepare<[number], { heading: string | null; path: string }>(
  `SELECT c.heading, p.path FROM chunks c JOIN pages p ON p.id = c.page_id WHERE c.id = ?`,
);
const label = (id: number) => describe.get(id)?.heading ?? `chunk ${id}`;

console.log(`Query:   ${query}`);
console.log(`Sources: ${sources.length ? sources.join(', ') : 'all'}   Mode: ${mode}`);
const terms = queryTerms(query);
console.log(`Terms:   ${terms.map((t) => (looksLikeIdentifier(t) ? `${t} (identifier)` : t)).join(', ') || '(none)'}`);

// 1. Each method's own ranking.
const lists = await candidateLists(db, embed, query, { sources, mode });
const ranked = Object.entries(lists) as Array<[keyof typeof lists, number[]]>;
const names: Record<string, string> = { vector: 'Vector (meaning)', fts: 'Keyword (BM25)', symbol: 'Symbol (API names)' };
for (const [name, ids] of ranked) {
  console.log(`\n${names[name]}: ${ids.length} candidates`);
  ids.slice(0, top).forEach((id, i) => console.log(`  ${String(i + 1).padStart(2)}. ${label(id)}`));
}

// 2. Fusion: each list a chunk appears in adds 1 / (RRF_K + rank).
const scores = fuse(Object.values(lists));
console.log(`\nFused (score = sum of 1/(${RRF_K} + rank) over the lists a chunk is in):`);
const byScore = [...scores].sort((a, b) => b[1] - a[1]);
for (const [id, score] of byScore.slice(0, top)) {
  const parts = ranked.filter(([, ids]) => ids.includes(id)).map(([name, ids]) => `${name} #${ids.indexOf(id) + 1}`);
  console.log(`  ${score.toFixed(4)}  ${label(id)}  [${parts.join(', ')}]`);
}

// 3. Final results, after the per-page cap.
const results = topResults(db, scores, k);
// Chunks that outscored the last result but were skipped for their page.
const kept = new Set(results.map((r) => r.chunkId));
const lastKept = byScore.findIndex(([id]) => id === results.at(-1)?.chunkId);
const capped = lastKept < 0 ? [] : byScore.slice(0, lastKept).filter(([id]) => !kept.has(id));
console.log(`\nResults (top ${k}, at most 2 per page):`);
if (results.length === 0) console.log('  (none)');
results.forEach((r, i) => console.log(`  ${i + 1}. ${r.score.toFixed(4)}  ${r.heading ?? r.title}  (${r.source}: ${r.path})`));
if (capped.length) console.log(`  Skipped by the per-page cap: ${capped.map(([id]) => label(id)).join('; ')}`);

db.close();
