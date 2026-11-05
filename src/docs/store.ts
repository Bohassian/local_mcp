import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config.js';

// The docs store, data/docs.db. Ingest writes it; the server reads it.
// Changing a table or EMBEDDING_DIM means deleting the file and re-ingesting.

export const DOCS_DB_PATH = path.join(config.dataDir, 'docs.db');

// The embedding model and what the stored vectors depend on: its size and
// the task prefixes it was trained with. Changing any of these means
// re-ingesting. The model name is repeated in docker-compose.yml (ollama-pull).
export const EMBED_MODEL = 'qwen3-embedding:4b';
export const EMBEDDING_DIM = 2560;
// Qwen3-Embedding: queries carry a task instruction, documents nothing.
export const QUERY_PREFIX =
  'Instruct: Given a question about a programming language, framework or API, retrieve documentation passages that answer it\nQuery:';
export const DOC_PREFIX = '';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  description TEXT,
  format TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  UNIQUE (source, path)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  heading TEXT,
  anchor TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source);
CREATE INDEX IF NOT EXISTS chunks_page ON chunks (page_id);

-- source is a metadata column, so KNN queries can filter on it.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${EMBEDDING_DIM}],
  source TEXT
);

-- rowid = chunks.id. Plain (not external-content) so rows delete by rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  heading,
  text,
  source UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  member_lc TEXT,
  kind TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  chunk_id INTEGER
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name_lc);
CREATE INDEX IF NOT EXISTS symbols_member ON symbols (member_lc);
`;

export type DocsDb = Database.Database;

export function openStore(dbPath = DOCS_DB_PATH): DocsDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(SCHEMA);
  return db;
}

export function toBuffer(vector: number[]): Buffer {
  const f32 = new Float32Array(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

// SQL filter on a list of sources: ` AND <column> IN (@source0, @source1, ...)`.
// Pass sourceParams(sources) along with the query.
export function sourceFilter(column: string, sources: string[]): string {
  if (sources.length === 0) return '';
  return ` AND ${column} IN (${sources.map((_, i) => `@source${i}`).join(', ')})`;
}

export function sourceParams(sources: string[]): Record<string, string> {
  return Object.fromEntries(sources.map((s, i) => [`source${i}`, s]));
}

export function deleteSource(db: DocsDb, source: string): void {
  db.transaction(() => {
    const chunkIds = `SELECT id FROM chunks WHERE source = @source`;
    db.prepare(`DELETE FROM chunks_vec WHERE chunk_id IN (${chunkIds})`).run({ source });
    db.prepare(`DELETE FROM chunks_fts WHERE rowid IN (${chunkIds})`).run({ source });
    db.prepare(`DELETE FROM symbols WHERE source = @source`).run({ source });
    db.prepare(`DELETE FROM chunks WHERE source = @source`).run({ source });
    db.prepare(`DELETE FROM pages WHERE source = @source`).run({ source });
    db.prepare(`DELETE FROM sources WHERE id = @source`).run({ source });
  })();
}
