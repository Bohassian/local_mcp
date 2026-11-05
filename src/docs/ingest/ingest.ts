import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { ollamaEmbed } from '../../embed.js';
import { deleteSource, DOC_PREFIX, EMBED_MODEL, EMBEDDING_DIM, openStore, toBuffer } from '../store.js';
import { chunkText } from './chunk.js';
import { embedChunks, embeddingText } from './embed-chunks.js';
import type { Page, Reader } from './readers/types.js';
import { readDevDocs } from './readers/devdocs.js';
import { readGodotClassRef } from './readers/godot-classref.js';
import { readMarkdown } from './readers/markdown.js';
import { readRst } from './readers/rst.js';

// Ingests sources from src/docs/sources.json into data/docs.db.
//
//   yarn ingest godot-manual godot-api
//   yarn ingest --all
//
// Reads local files only. Each run replaces the source's rows entirely.

interface SourceConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  format: string;
  path: string; // directory under data/
  include?: string[]; // path prefixes to include; omitted or "" means all
}

// File readers turn one file into a page; bundle readers read a whole
// directory (a DevDocs bundle is one db.json).
const READERS: Record<string, { reader: Reader; ext: RegExp } | { bundle: (root: string) => Page[] }> = {
  rst: { reader: readRst, ext: /\.rst$/ },
  'godot-classref': { reader: readGodotClassRef, ext: /\.rst$/ },
  markdown: { reader: readMarkdown, ext: /\.(md|mdx|markdown|txt)$/i },
  devdocs: { bundle: readDevDocs },
};

const BATCH_SIZE = 32;

function listFiles(root: string, ext: RegExp): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => !path.relative(root, f).split(path.sep).some((part) => part.startsWith('.')))
    .sort();
}

function readPages(src: SourceConfig, root: string): Page[] {
  const fmt = READERS[src.format];
  if (!fmt) throw new Error(`[${src.id}] unknown format: ${src.format}`);
  const inScope = (rel: string) => (src.include ?? ['']).some((prefix) => rel.startsWith(prefix));

  if ('bundle' in fmt) return fmt.bundle(root).filter((p) => inScope(p.path));
  return listFiles(root, fmt.ext)
    .map((file) => path.relative(root, file))
    .filter(inScope)
    .map((rel) => fmt.reader(root, rel, fs.readFileSync(path.join(root, rel), 'utf8')))
    .filter((p): p is Page => p !== null);
}

// A DevDocs bundle's release (from the meta.json fetch-docs writes).
function bundleVersion(root: string): string | undefined {
  const meta = path.join(root, 'meta.json');
  if (!fs.existsSync(meta)) return undefined;
  return (JSON.parse(fs.readFileSync(meta, 'utf8')) as { release?: string }).release;
}

async function ingest(src: SourceConfig) {
  const root = path.join(config.dataDir, src.path);
  if (!fs.existsSync(root)) return console.warn(`[${src.id}] ${root} not found, skipping`);

  const pages = readPages(src, root);
  const chunks = pages.flatMap((page, pageIndex) =>
    page.sections.flatMap((s) => chunkText(s.text).map((text) => ({ pageIndex, heading: s.heading, anchor: s.anchor, text }))),
  );
  const symbolCount = pages.reduce((n, p) => n + p.symbols.length, 0);
  console.log(`[${src.id}] ${pages.length} pages, ${chunks.length} chunks, ${symbolCount} symbols`);

  // Embed everything before touching the DB, so a failed run leaves the
  // previous copy of the source intact.
  const vectors: Buffer[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vecs = await embedChunks(
      embed,
      batch.map((c) => `${DOC_PREFIX}${c.heading}\n\n${embeddingText(c.text)}`),
      (j) => `chunk ${i + j} (${pages[batch[j].pageIndex].path})`,
    );
    for (const v of vecs) {
      if (v.length !== EMBEDDING_DIM) throw new Error(`Expected ${EMBEDDING_DIM}-d vectors, got ${v.length}`);
      vectors.push(toBuffer(v));
    }
    process.stdout.write(`\r[${src.id}] embedded ${vectors.length}/${chunks.length}`);
  }
  process.stdout.write('\n');

  const insertPage = db.prepare(`INSERT INTO pages (source, path, title, body) VALUES (?, ?, ?, ?)`);
  const insertChunk = db.prepare(`INSERT INTO chunks (source, page_id, heading, anchor, text) VALUES (?, ?, ?, ?, ?)`);
  const insertVec = db.prepare(`INSERT INTO chunks_vec (chunk_id, embedding, source) VALUES (?, ?, ?)`);
  const insertFts = db.prepare(`INSERT INTO chunks_fts (rowid, heading, text, source) VALUES (?, ?, ?, ?)`);
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (source, name, name_lc, member_lc, kind, page_id, chunk_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO sources (id, name, version, description, format, page_count, chunk_count, symbol_count, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    deleteSource(db, src.id);
    const pageIds = pages.map((p) => Number(insertPage.run(src.id, p.path, p.title, p.body).lastInsertRowid));

    // First chunk of each anchored section: where its symbols point.
    const anchorChunk = new Map<string, number>();
    chunks.forEach((c, i) => {
      const id = Number(insertChunk.run(src.id, pageIds[c.pageIndex], c.heading, c.anchor ?? null, c.text).lastInsertRowid);
      // vec0 needs an integer key; better-sqlite3 binds plain numbers as REAL.
      insertVec.run(BigInt(id), vectors[i], src.id);
      insertFts.run(id, c.heading, c.text, src.id);
      const key = `${c.pageIndex}#${c.anchor}`;
      if (c.anchor && !anchorChunk.has(key)) anchorChunk.set(key, id);
    });

    pages.forEach((p, pageIndex) => {
      for (const s of p.symbols) {
        const chunkId = anchorChunk.get(`${pageIndex}#${s.anchor}`) ?? null;
        insertSymbol.run(src.id, s.name, s.name.toLowerCase(), s.member?.toLowerCase() ?? null, s.kind, pageIds[pageIndex], chunkId);
      }
    });

    const version = bundleVersion(root) ?? src.version;
    const now = new Date().toISOString();
    insertSource.run(src.id, src.name, version, src.description, src.format, pages.length, chunks.length, symbolCount, now);
  })();
  console.log(`[${src.id}] done`);
}

const { sources } = JSON.parse(fs.readFileSync(new URL('../sources.json', import.meta.url), 'utf8')) as {
  sources: SourceConfig[];
};
const known = sources.map((s) => s.id).join(', ');

const args = process.argv.slice(2);
const selected = args.includes('--all')
  ? sources
  : args.map((id) => sources.find((s) => s.id === id) ?? fail(`Unknown source "${id}". Known: ${known}`));
if (selected.length === 0) fail(`Usage: yarn ingest <source-id>... | --all\nSources: ${known}`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const db = openStore();
const embed = ollamaEmbed(EMBED_MODEL);
try {
  for (const src of selected) await ingest(src);
} finally {
  db.close();
}
