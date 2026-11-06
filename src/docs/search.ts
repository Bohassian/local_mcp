import type { Embed } from '../embed.js';
import { type DocsDb, QUERY_PREFIX, sourceFilter, sourceParams, toBuffer } from './store.js';

// Hybrid search: three ranked candidate lists, merged by reciprocal rank fusion.
//   vector  semantic KNN; good for "how do I ..." questions
//   fts     FTS5 BM25 over heading + text; good for exact words
//   symbol  query identifiers matched against the symbol table, so
//           `move_and_slide` or `QueryMethods where` land on the API entry
//
// New to search? docs/HOW_IT_WORKS.md walks a real query through this file.

export type SearchMode = 'vector' | 'fts' | 'hybrid';

export interface SearchResult {
  chunkId: number;
  source: string;
  path: string;
  title: string | null;
  heading: string | null;
  anchor: string | null;
  text: string;
  score: number;
}

const CANDIDATES = 50; // per list
const MAX_PER_PAGE = 2; // so one huge class page can't fill the results
// Damps the gap between ranks 1, 2, 3...; 60 is the value the RRF paper found
// works well across collections. https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
const RRF_K = 60;

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or should so that the this to use using what when where which why with you'.split(' '),
);

// Owner/member separators: Godot `Node.queue_free`, Ruby `Array#map`, `File::exist?`.
const MEMBER_SEP = /(?:#|::|\.)/;

// Query words, keeping identifier characters (_ . @ # :) together.
export function queryTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_.@#:?!]+/gu) ?? [])
    .map((t) => t.replace(/^[.#:]+|[.():]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
}

export function vectorIds(db: DocsDb, vector: number[], sources: string[]): number[] {
  // KNN (k-nearest neighbors): the k stored vectors closest to the query's.
  // https://alexgarcia.xyz/sqlite-vec/features/knn.html
  // One KNN per source, merged by distance: vec0 metadata filters only
  // reliably support equality.
  const knn = (source?: string) =>
    db
      .prepare<object, { chunk_id: number; distance: number }>(
        `SELECT chunk_id, distance FROM chunks_vec
          WHERE embedding MATCH @vec AND k = @k${source ? ' AND source = @source' : ''}
          ORDER BY distance`,
      )
      .all({ vec: toBuffer(vector), k: CANDIDATES, ...(source ? { source } : {}) });
  const rows = sources.length === 0 ? knn() : sources.flatMap((s) => knn(s));
  return rows
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATES)
    .map((r) => Number(r.chunk_id));
}

export function ftsIds(db: DocsDb, terms: string[], sources: string[]): number[] {
  if (terms.length === 0) return [];
  // Each term as a quoted phrase, so FTS5 doesn't parse it as syntax.
  const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  // Heading matches weigh 10x body matches. bm25() takes one weight per FTS
  // column (heading, text, source); lower scores are better, hence ascending.
  // https://www.sqlite.org/fts5.html#the_bm25_function
  return db
    .prepare<object, { rowid: number }>(
      `SELECT rowid FROM chunks_fts
        WHERE chunks_fts MATCH @match${sourceFilter('source', sources)}
        ORDER BY bm25(chunks_fts, 10.0, 1.0, 0.0)
        LIMIT @k`,
    )
    .all({ match, k: CANDIDATES, ...sourceParams(sources) })
    .map((r) => r.rowid);
}

// snake_case, dotted, namespaced, or capitalized (Node2D, QueryMethods, Label).
// Plain words ("play", "where") also name members, but matching them alone
// swamps natural-language questions with unrelated API entries.
export function looksLikeIdentifier(term: string): boolean {
  return /[_.@#]|::/.test(term) || /^.+[A-Z0-9]/.test(term) || /^[A-Z][a-z]+$/.test(term);
}

// `label.text` -> `label`, `activerecord::querymethods#where` -> `activerecord::querymethods`.
export function ownerOf(nameLc: string): string {
  return nameLc.replace(new RegExp(`${MEMBER_SEP.source}[^#:.]+$`), '');
}

// Candidates, in priority order:
//   1. qualified terms that name a symbol exactly (`Tween.tween_property`)
//   2. members of a class named in the query ("label" + "text" -> Label.text)
//   3. those classes themselves
//   4. bare identifier-like terms, as a symbol or member name
export function symbolIds(db: DocsDb, terms: string[], sources: string[]): number[] {
  const words = terms.map((t) => t.toLowerCase());
  // A one-word query is an API name even when it's a plain word ("pluck").
  const idents = (terms.length === 1 ? terms : terms.filter(looksLikeIdentifier)).map((t) => t.toLowerCase());
  const params = sourceParams(sources);
  const filter = sourceFilter('source', sources);

  const byName = db.prepare<object, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols WHERE name_lc = @name AND chunk_id IS NOT NULL${filter}`,
  );
  const byMember = db.prepare<object, { chunk_id: number; name_lc: string }>(
    `SELECT chunk_id, name_lc FROM symbols WHERE member_lc = @name AND chunk_id IS NOT NULL${filter}`,
  );
  // A class matches by full name, last `::` segment, or Godot's 2D/3D pair
  // ("camera" -> Camera2D, Camera3D).
  const classes = db.prepare<object, { chunk_id: number; name_lc: string }>(
    `SELECT chunk_id, name_lc FROM symbols
      WHERE kind = 'class'
        AND (name_lc IN (@name, @name || '2d', @name || '3d') OR name_lc LIKE '%::' || @name)
        AND chunk_id IS NOT NULL${filter}
      LIMIT 10`,
  );

  const ids: number[] = [];

  for (const t of idents.filter((t) => MEMBER_SEP.test(t))) {
    ids.push(...byName.all({ name: t, ...params }).map((r) => r.chunk_id));
  }

  const classHits = new Map<string, Array<{ chunk_id: number; name_lc: string }>>();
  for (const w of new Set(words)) {
    const hits = classes.all({ name: w, ...params });
    if (hits.length > 0) classHits.set(w, hits);
  }
  for (const [cls, hits] of classHits) {
    const owners = new Set(hits.map((h) => h.name_lc));
    for (const w of new Set(words)) {
      if (w === cls) continue;
      for (const m of byMember.all({ name: w, ...params })) {
        if (owners.has(ownerOf(m.name_lc))) ids.push(m.chunk_id);
      }
    }
  }
  for (const hits of classHits.values()) ids.push(...hits.map((h) => h.chunk_id));

  const bare = new Set(idents.flatMap((t) => t.split(/[.#:]+/)).filter((t) => t.length > 1));
  for (const name of bare) {
    ids.push(...byName.all({ name, ...params }).map((r) => r.chunk_id));
    ids.push(...byMember.all({ name, ...params }).slice(0, 20).map((r) => r.chunk_id));
  }
  return [...new Set(ids)].slice(0, CANDIDATES);
}

// Reciprocal rank fusion: each list adds 1 / (RRF_K + rank) to an id's score.
// Only positions count, so a BM25 score and a vector distance never need
// converting to a common scale.
export function fuse(lists: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return scores;
}

export async function searchDocs(
  db: DocsDb,
  embed: Embed,
  query: string,
  { k = 5, sources = [] as string[], mode = 'hybrid' as SearchMode } = {},
): Promise<SearchResult[]> {
  const terms = queryTerms(query);
  const lists: number[][] = [];
  if (mode !== 'fts') {
    const [vector] = await embed([`${QUERY_PREFIX}${query}`]);
    lists.push(vectorIds(db, vector, sources));
  }
  if (mode !== 'vector') {
    lists.push(ftsIds(db, terms, sources));
    lists.push(symbolIds(db, terms, sources));
  }

  const chunk = db.prepare<[number], Omit<SearchResult, 'score'> & { pageId: number }>(
    `SELECT c.id AS chunkId, c.page_id AS pageId, c.source, p.path, p.title, c.heading, c.anchor, c.text
       FROM chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.id = ?`,
  );

  const results: SearchResult[] = [];
  const perPage = new Map<number, number>();
  for (const [id, score] of [...fuse(lists)].sort((a, b) => b[1] - a[1])) {
    const { pageId, ...r } = chunk.get(id)!;
    const n = perPage.get(pageId) ?? 0;
    if (n >= MAX_PER_PAGE) continue;
    perPage.set(pageId, n + 1);
    results.push({ ...r, score });
    if (results.length === k) break;
  }
  return results;
}
