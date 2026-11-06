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

const CANDIDATES_PER_LIST = 50; // how many each search method returns for fusion
const MAX_PER_PAGE = 2; // so one huge class page can't fill the results
// Damps the gap between ranks 1, 2, 3...; 60 is the value the RRF paper found
// works well across collections. https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
export const RRF_K = 60;

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or should so that the this to use using what when where which why with you'.split(' '),
);

// Owner/member separators: Godot `Node.queue_free`, Ruby `Array#map`, `File::exist?`.
const MEMBER_SEP = /(?:#|::|\.)/;

// Query words, keeping identifier characters (_ . @ # :) together.
export function queryTerms(query: string): string[] {
  const words = (query.match(/[\p{L}\p{N}_.@#:?!]+/gu) ?? [])
    .map((t) => t.replace(/^[.#:]+|[.():]+$/g, ''))
    .filter((t) => t.length > 1);
  // A query that is one word is an API name, even a stopword: Rails `where`,
  // `or`, `with`.
  if (words.length === 1) return words;
  return words.filter((t) => !STOPWORDS.has(t.toLowerCase()));
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
      .all({ vec: toBuffer(vector), k: CANDIDATES_PER_LIST, ...(source ? { source } : {}) });
  const rows = sources.length === 0 ? knn() : sources.flatMap((s) => knn(s));
  return rows
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATES_PER_LIST)
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
    .all({ match, k: CANDIDATES_PER_LIST, ...sourceParams(sources) })
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

// The symbol-table lookups that symbol search uses, limited to `sources`.
// Names are matched lowercased.
type SymbolRow = { chunk_id: number; name_lc: string };

function symbolLookups(db: DocsDb, sources: string[]) {
  const filter = sourceFilter('source', sources);
  const params = sourceParams(sources);
  const lookup = (sql: string) => {
    const stmt = db.prepare<object, SymbolRow>(`${sql} AND chunk_id IS NOT NULL${filter}`);
    return (name: string) => stmt.all({ name, ...params });
  };
  return {
    // Full name: `characterbody2d.move_and_slide`, or a class like `label`.
    byName: lookup(`SELECT chunk_id, name_lc FROM symbols WHERE name_lc = @name`),
    // Member part only: `move_and_slide` matches it on every class that has one.
    byMember: lookup(`SELECT chunk_id, name_lc FROM symbols WHERE member_lc = @name`),
    // Classes by full name, last `::` segment (`querymethods` ->
    // `activerecord::querymethods`), or Godot's 2D/3D pair (`camera` ->
    // Camera2D, Camera3D).
    classes: lookup(
      `SELECT chunk_id, name_lc FROM symbols
        WHERE kind = 'class'
          AND (name_lc IN (@name, @name || '2d', @name || '3d') OR name_lc LIKE '%::' || @name)`,
    ),
  };
}
type SymbolLookups = ReturnType<typeof symbolLookups>;

// A common member name (`get_name`, `to_s`) exists on hundreds of classes;
// keep only the first few when it appears alone in a query.
const MAX_MATCHES_PER_BARE_MEMBER = 20;
const MAX_CLASSES_PER_WORD = 10;

// Symbol search: chunks that document API names mentioned in the query, best
// first. The four stages, in priority order:
//   1. qualified names that match a symbol exactly  `Tween.tween_property`
//   2. members of a class named in the query        "label text" -> Label.text
//   3. those classes themselves                      "label text" -> Label
//   4. identifiers as full or member names           `move_and_slide` -> every class's
export function symbolIds(db: DocsDb, terms: string[], sources: string[]): number[] {
  const find = symbolLookups(db, sources);
  // Only identifier-like words lose a trailing mark: "…a model?" must not start
  // matching classes named Model.
  const words = [
    ...new Set(terms.flatMap((t) => (looksLikeIdentifier(t) ? withAndWithoutMark(t) : [t])).map((t) => t.toLowerCase())),
  ];
  // A one-word query is an API name even when it's a plain word ("pluck").
  const identifiers = (terms.length === 1 ? terms : terms.filter(looksLikeIdentifier))
    .flatMap(withAndWithoutMark)
    .map((t) => t.toLowerCase());
  const classesByWord = classesNamedBy(find, words);

  const rows = [
    ...exactQualifiedNames(find, identifiers),
    ...membersOfNamedClasses(find, words, classesByWord),
    ...[...classesByWord.values()].flat(),
    ...bareNames(find, identifiers),
  ];
  return [...new Set(rows.map((r) => r.chunk_id))].slice(0, CANDIDATES_PER_LIST);
}

// Ruby names can end in ? or ! (`empty?`, `save!`), and queryTerms keeps the
// mark for them. But a question's own ? lands on its last word too
// ("…is_on_floor?"). So try the term as written, then without the mark.
function withAndWithoutMark(term: string): string[] {
  return /[?!]$/.test(term) ? [term, term.slice(0, -1)] : [term];
}

// Stage 1. Only terms with a separator: `Node.queue_free`, `Array#map`.
function exactQualifiedNames(find: SymbolLookups, identifiers: string[]): SymbolRow[] {
  return identifiers.filter((t) => MEMBER_SEP.test(t)).flatMap((t) => find.byName(t));
}

// Which query words name a class, and the classes each one names. Any word
// counts here, not just identifier-like ones: people write "label", not "Label".
function classesNamedBy(find: SymbolLookups, words: string[]): Map<string, SymbolRow[]> {
  const byWord = new Map<string, SymbolRow[]>();
  for (const word of words) {
    const classes = find.classes(word).slice(0, MAX_CLASSES_PER_WORD);
    if (classes.length > 0) byWord.set(word, classes);
  }
  return byWord;
}

// Stage 2. For each class a word named, the other words that are members of
// that class: "label" names Label, and Label.text has member `text`.
function membersOfNamedClasses(
  find: SymbolLookups,
  words: string[],
  classesByWord: Map<string, SymbolRow[]>,
): SymbolRow[] {
  const found: SymbolRow[] = [];
  for (const [classWord, classes] of classesByWord) {
    const classNames = new Set(classes.map((c) => c.name_lc));
    for (const word of words) {
      if (word === classWord) continue;
      found.push(...find.byMember(word).filter((m) => classNames.has(ownerOf(m.name_lc))));
    }
  }
  return found;
}

// Stage 4. Each identifier, and each part of a qualified one
// (`Node.queue_free` -> `node`, `queue_free`), as a full name or a member name.
function bareNames(find: SymbolLookups, identifiers: string[]): SymbolRow[] {
  const parts = new Set(identifiers.flatMap((t) => t.split(/[.#:]+/)).filter((t) => t.length > 1));
  return [...parts].flatMap((name) => [
    ...find.byName(name),
    ...find.byMember(name).slice(0, MAX_MATCHES_PER_BARE_MEMBER),
  ]);
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
  // 1. Each method ranks its own candidates.
  const lists = await candidateLists(db, embed, query, { sources, mode });
  // 2. Merge the rankings into one score per chunk.
  const scores = fuse(Object.values(lists));
  // 3. Best first, at most MAX_PER_PAGE from any page, until there are k.
  return topResults(db, scores, k);
}

// Chunk ids from each search method, best first. `mode` leaves some out.
export interface CandidateLists {
  vector?: number[];
  fts?: number[];
  symbol?: number[];
}

export async function candidateLists(
  db: DocsDb,
  embed: Embed,
  query: string,
  { sources = [] as string[], mode = 'hybrid' as SearchMode } = {},
): Promise<CandidateLists> {
  const terms = queryTerms(query);
  const lists: CandidateLists = {};
  if (mode !== 'fts') {
    // Queries get an instruction prefix; stored documents were embedded without one.
    const [vector] = await embed([`${QUERY_PREFIX}${query}`]);
    lists.vector = vectorIds(db, vector, sources);
  }
  if (mode !== 'vector') {
    lists.fts = ftsIds(db, terms, sources);
    lists.symbol = symbolIds(db, terms, sources);
  }
  return lists;
}

// Highest scores first, skipping chunks from a page that already has
// MAX_PER_PAGE results, so one huge class page can't fill every slot.
export function topResults(db: DocsDb, scores: Map<number, number>, k: number): SearchResult[] {
  const chunk = db.prepare<[number], Omit<SearchResult, 'score'> & { pageId: number }>(
    `SELECT c.id AS chunkId, c.page_id AS pageId, c.source, p.path, p.title, c.heading, c.anchor, c.text
       FROM chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.id = ?`,
  );

  const results: SearchResult[] = [];
  const resultsPerPage = new Map<number, number>();
  for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1])) {
    const { pageId, ...result } = chunk.get(id)!;
    const n = resultsPerPage.get(pageId) ?? 0;
    if (n >= MAX_PER_PAGE) continue;
    resultsPerPage.set(pageId, n + 1);
    results.push({ ...result, score });
    if (results.length === k) break;
  }
  return results;
}
