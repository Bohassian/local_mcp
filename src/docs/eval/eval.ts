import fs from 'node:fs';
import { ollamaEmbed } from '../../embed.js';
import { searchDocs, type SearchMode } from '../search.js';
import { EMBED_MODEL, openStore } from '../store.js';

// Retrieval eval: for each query in <set>.json, is one of the expected pages in
// the top k? Reports hit@k and MRR per query kind, plus the misses.
//
//   yarn eval                    # godot set, k=5, every mode
//   yarn eval rails 5 hybrid     # one mode: vector | fts | hybrid

interface EvalQuery {
  kind: string;
  query: string;
  pages: string[];
  sources?: string[]; // as a project's AGENTS.md would pass them
}

const [set = 'godot', kArg = '5', modeArg] = process.argv.slice(2);
const k = Number(kArg);
const modes: SearchMode[] = modeArg ? [modeArg as SearchMode] : ['vector', 'fts', 'hybrid'];

// Top-level `sources` is the default for queries that don't set their own.
const { queries, sources: defaultSources } = JSON.parse(
  fs.readFileSync(new URL(`${set}.json`, import.meta.url), 'utf8'),
) as { queries: EvalQuery[]; sources?: string[] };

// Huge Godot classes whose chunks are near almost any query. "noise" is the
// share of results from these pages (never an expected answer).
const NOISE_PAGES = new Set([
  'classes/class_renderingserver.rst',
  'classes/class_projectsettings.rst',
  'classes/class_renderingdevice.rst',
  'classes/class_displayserver.rst',
  'classes/class_editorsettings.rst',
  'classes/class_textserver.rst',
]);

const db = openStore();
const embed = ollamaEmbed(EMBED_MODEL);

type Tally = { hits: number; rr: number; total: number };
const pct = (n: number, of: number) => `${n}/${of} (${Math.round((100 * n) / of)}%)`;
const row = (label: string, t: Tally) =>
  `  ${label.padEnd(13)} hit@${k} ${pct(t.hits, t.total).padEnd(12)} MRR ${(t.rr / t.total).toFixed(2)}`;

for (const mode of modes) {
  const byKind = new Map<string, Tally>();
  const misses: string[] = [];
  let returned = 0;
  let noise = 0;

  for (const q of queries) {
    const results = await searchDocs(db, embed, q.query, { k, mode, sources: q.sources ?? defaultSources });
    const got = results.map((r) => r.path);
    const rank = got.findIndex((p) => q.pages.includes(p));

    const tally = byKind.get(q.kind) ?? { hits: 0, rr: 0, total: 0 };
    tally.total++;
    if (rank >= 0) {
      tally.hits++;
      tally.rr += 1 / (rank + 1);
    } else {
      misses.push(`  [${q.kind}] ${q.query}\n      got: ${[...new Set(got)].join(', ')}`);
    }
    byKind.set(q.kind, tally);
    returned += got.length;
    noise += got.filter((p) => NOISE_PAGES.has(p)).length;
  }

  const all = [...byKind.values()].reduce(
    (a, b) => ({ hits: a.hits + b.hits, rr: a.rr + b.rr, total: a.total + b.total }),
    { hits: 0, rr: 0, total: 0 },
  );
  console.log(`\n== ${mode}`);
  for (const [kind, t] of byKind) console.log(row(kind, t));
  console.log(row('all', all));
  console.log(`  noise: ${pct(noise, returned)} of results from big settings/server classes`);
  if (misses.length) console.log(`  misses:\n${misses.join('\n')}`);
}

db.close();
