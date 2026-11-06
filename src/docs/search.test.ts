import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Embed } from '../embed.js';
import { fuse, looksLikeIdentifier, ownerOf, queryTerms, searchDocs, symbolIds } from './search.js';
import { type DocsDb, EMBEDDING_DIM, openStore, toBuffer } from './store.js';

// Hybrid search, step by step. See docs/HOW_IT_WORKS.md#the-search-path.

describe('queryTerms: splitting a query into words for keyword and symbol search', () => {
  it('drops stopwords and keeps identifiers whole', () => {
    assert.deepEqual(queryTerms('How do I use Node.queue_free()?'), ['Node.queue_free']);
  });

  it('keeps Ruby-style separators (# and ::) and trailing ? or !', () => {
    assert.deepEqual(queryTerms('ActiveRecord::QueryMethods#where'), ['ActiveRecord::QueryMethods#where']);
    assert.deepEqual(queryTerms('Array#map and File::exist?'), ['Array#map', 'File::exist?']);
  });
});

describe('looksLikeIdentifier: which words are worth looking up as API names', () => {
  const cases: Array<[string, boolean]> = [
    ['move_and_slide', true], // snake_case
    ['Node.position', true], // dotted
    ['Array#map', true], // Ruby instance method
    ['Node2D', true], // contains a digit or inner capital
    ['QueryMethods', true],
    ['Label', true], // Capitalized word: probably a class
    ['label', false], // plain word: would match too many members
    ['floor', false],
  ];
  for (const [term, expected] of cases) {
    it(`${term} -> ${expected}`, () => assert.equal(looksLikeIdentifier(term), expected));
  }
});

describe('ownerOf: the class part of a member name', () => {
  it('drops the last segment after . # or ::', () => {
    assert.equal(ownerOf('label.text'), 'label');
    assert.equal(ownerOf('activerecord::querymethods#where'), 'activerecord::querymethods');
  });
});

describe('fuse: reciprocal rank fusion', () => {
  // Each list adds 1 / (60 + rank) to an item's score, ranks starting at 1.
  // Scores are never compared across lists, only positions, so a keyword
  // score and a vector distance never need converting to a common scale.
  it('scores a single first place as 1/61', () => {
    assert.equal(fuse([[7]]).get(7), 1 / 61);
  });

  it('matches the worked example in HOW_IT_WORKS.md', () => {
    // From a real query, "move_and_slide floor detection": the
    // CharacterBody2D.move_and_slide chunk (id 7827) ranked 17th by meaning,
    // 39th by keywords and 1st by symbol name.
    const ranked = (rank: number, id: number) => [...Array(rank - 1).fill(-rank), id];
    const scores = fuse([ranked(17, 7827), ranked(39, 7827), ranked(1, 7827)]);
    assert.equal(scores.get(7827)!.toFixed(4), '0.0395'); // 1/77 + 1/99 + 1/61
  });

  it('can rank an item found by two lists above one that tops a single list', () => {
    // 2nd + 2nd beats 1st alone: agreement between methods counts.
    const scores = fuse([
      [1, 2],
      [3, 2],
    ]);
    assert.ok(scores.get(2)! > scores.get(1)!);
  });
});

// A tiny docs store, built in memory the way ingest builds the real one.
//
// The "embedding model" here is a toy: one dimension per topic, set to 1 when
// the text mentions any of that topic's words. Real models learn thousands of
// such dimensions from data, but the idea is the same: texts about the same
// thing end up with similar vectors, even with no words in common
// ("leap" and "jump").
const TOPICS = [
  ['jump', 'leap', 'hop'],
  ['floor', 'ground'],
  ['camera', 'viewport'],
  ['text', 'string', 'label'],
];
const toyVector = (text: string) => {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  TOPICS.forEach((words, i) => {
    if (words.some((w) => text.toLowerCase().includes(w))) v[i] = 1;
  });
  return v;
};
const toyEmbed: Embed = async (texts) => texts.map(toyVector);

interface ToyChunk {
  heading: string;
  text: string;
  symbol?: { name: string; member?: string; kind: string };
}

function addPage(db: DocsDb, source: string, path: string, chunks: ToyChunk[]) {
  const pageId = Number(
    db.prepare(`INSERT INTO pages (source, path, title, body) VALUES (?, ?, ?, '')`).run(source, path, path).lastInsertRowid,
  );
  for (const c of chunks) {
    const id = Number(
      db
        .prepare(`INSERT INTO chunks (source, page_id, heading, text) VALUES (?, ?, ?, ?)`)
        .run(source, pageId, c.heading, c.text).lastInsertRowid,
    );
    db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding, source) VALUES (?, ?, ?)`).run(
      BigInt(id),
      toBuffer(toyVector(`${c.heading} ${c.text}`)),
      source,
    );
    db.prepare(`INSERT INTO chunks_fts (rowid, heading, text, source) VALUES (?, ?, ?, ?)`).run(id, c.heading, c.text, source);
    if (c.symbol) {
      const { name, member, kind } = c.symbol;
      db.prepare(
        `INSERT INTO symbols (source, name, name_lc, member_lc, kind, page_id, chunk_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(source, name, name.toLowerCase(), member?.toLowerCase() ?? null, kind, pageId, id);
    }
  }
}

describe('searchDocs on a small in-memory store', () => {
  let db: DocsDb;
  const headings = async (query: string, mode?: 'vector' | 'fts' | 'hybrid') =>
    (await searchDocs(db, toyEmbed, query, { k: 5, mode })).map((r) => r.heading);

  before(() => {
    db = openStore(':memory:');
    addPage(db, 'api', 'class_label.rst', [
      { heading: 'Label (class)', text: 'A control that displays text.', symbol: { name: 'Label', kind: 'class' } },
      {
        heading: 'Label.text (property)',
        text: 'The string to display.',
        symbol: { name: 'Label.text', member: 'text', kind: 'property' },
      },
    ]);
    addPage(db, 'api', 'class_characterbody2d.rst', [
      {
        heading: 'CharacterBody2D.move_and_slide (method)',
        text: 'Moves the body based on velocity, sliding along surfaces.',
        symbol: { name: 'CharacterBody2D.move_and_slide', member: 'move_and_slide', kind: 'method' },
      },
      {
        heading: 'CharacterBody2D.is_on_floor (method)',
        text: 'Returns true if the body is on the floor.',
        symbol: { name: 'CharacterBody2D.is_on_floor', member: 'is_on_floor', kind: 'method' },
      },
      { heading: 'CharacterBody2D.floor_max_angle (property)', text: 'Steepest slope that counts as floor.' },
      { heading: 'CharacterBody2D.floor_snap_length (property)', text: 'Snaps the body to the floor.' },
    ]);
    addPage(db, 'manual', 'jumping.rst', [{ heading: 'Jumping', text: 'Give the player an upward velocity to jump.' }]);
    addPage(db, 'ruby', 'array', [
      {
        heading: 'Array#empty? (method)',
        text: 'Returns true if there are no elements.',
        symbol: { name: 'Array#empty?', member: 'empty?', kind: 'method' },
      },
    ]);
    addPage(db, 'api', 'class_camera2d.rst', [
      { heading: 'Camera2D (class)', text: 'Camera node for 2D scenes.', symbol: { name: 'Camera2D', kind: 'class' } },
    ]);
  });
  after(() => db.close());

  it('keyword search (fts) finds exact words', async () => {
    assert.equal((await headings('velocity sliding', 'fts'))[0], 'CharacterBody2D.move_and_slide (method)');
  });

  it('keyword search misses synonyms', async () => {
    assert.deepEqual(await headings('leap', 'fts'), []);
  });

  it('vector search finds the same meaning in other words', async () => {
    assert.equal((await headings('how do I leap', 'vector'))[0], 'Jumping');
  });

  it('symbol search finds a member by its exact name', async () => {
    const ids = symbolIds(db, queryTerms('move_and_slide'), []);
    assert.equal(ids.length, 1);
  });

  it('symbol search pairs a class with a member named in plain words ("label text" -> Label.text)', async () => {
    assert.equal((await headings('label text', 'hybrid'))[0], 'Label.text (property)');
  });

  it('symbol search finds an API name that ends a question ("…is_on_floor?")', async () => {
    const results = await searchDocs(db, toyEmbed, 'How do I check is_on_floor?', { k: 5, mode: 'fts', sources: ['api'] });
    assert.equal(results[0].heading, 'CharacterBody2D.is_on_floor (method)');
    const terms = queryTerms('How do I check is_on_floor?');
    assert.deepEqual(terms, ['check', 'is_on_floor?']); // the ? stays on the term...
    assert.equal(symbolIds(db, terms, ['api']).length, 1); // ...but symbol search still matches
  });

  it('symbol search keeps Ruby names that really end in ?', async () => {
    assert.equal(symbolIds(db, queryTerms('Array#empty?'), []).length, 1);
    assert.equal(symbolIds(db, queryTerms('empty?'), []).length, 1);
  });

  it('symbol search treats "camera" as Camera2D or Camera3D', async () => {
    assert.ok((await headings('camera', 'hybrid')).includes('Camera2D (class)'));
  });

  it('returns at most 2 chunks from any one page', async () => {
    // Four chunks on class_characterbody2d.rst mention "floor" or "body".
    const results = await searchDocs(db, toyEmbed, 'body floor', { k: 5, mode: 'fts' });
    const fromPage = results.filter((r) => r.path === 'class_characterbody2d.rst');
    assert.equal(fromPage.length, 2);
  });

  it('can filter to some sources', async () => {
    const results = await searchDocs(db, toyEmbed, 'jump velocity', { k: 5, sources: ['manual'] });
    assert.deepEqual(
      results.map((r) => r.source),
      ['manual'],
    );
  });
});
