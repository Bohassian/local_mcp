import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../config.js';
import { ollamaEmbed, type Embed } from '../embed.js';
import { type Endpoint, logged, text } from '../endpoint.js';
import { searchDocs } from './search.js';
import { type DocsDb, EMBED_MODEL, EMBEDDING_DIM, openStore, sourceFilter, sourceParams } from './store.js';

// Docs lookup over data/docs.db: list_docs, search_docs, lookup_symbol,
// read_doc. Descriptions are directive on purpose: local models under-call
// retrieval unless told when to use it.

export async function docsEndpoint(): Promise<Endpoint> {
  const db = openStore();
  const embed = ollamaEmbed(EMBED_MODEL);

  // Fail at startup if the model's vectors don't fit the index.
  const [probe] = await embed(['probe']);
  if (probe.length !== EMBEDDING_DIM) {
    throw new Error(`${EMBED_MODEL} returns ${probe.length}-d vectors; the store expects ${EMBEDDING_DIM}.`);
  }
  console.log(`docs: embedding with ${EMBED_MODEL} at ${config.embedUrl}`);

  return { path: '/docs', newServer: () => newDocsServer(db, embed), close: () => db.close() };
}

function newDocsServer(db: DocsDb, embed: Embed): McpServer {
  const server = new McpServer({ name: 'docs', version: '0.1.0' });

  // Source ids as an enum, so the model sees what's ingested (as of session start).
  const ids = db.prepare<[], { id: string }>(`SELECT id FROM sources ORDER BY id`).all().map((r) => r.id);
  const source = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string();
  const sources = z
    .array(source)
    .optional()
    .describe('Limit to these docs sources (see list_docs), e.g. the ones the project uses. Omit to search all.');

  server.registerTool(
    'list_docs',
    {
      description:
        'List the local documentation sources available to search_docs, ' +
        'lookup_symbol and read_doc, with what each covers and its version.',
      inputSchema: {},
    },
    logged('list_docs', () => listDocs(db)),
  );

  server.registerTool(
    'search_docs',
    {
      description:
        'Search local documentation (guides, manuals and API references; see ' +
        'list_docs). Combines keyword and semantic search, so both "how do I ' +
        '..." questions and exact API names work. CALL THIS BEFORE writing code ' +
        'against an API these docs cover, and before making claims about its ' +
        'behavior. Prefer it over guessing names or signatures.',
      inputSchema: {
        query: z.string().trim().min(1).describe('A question, or API names, e.g. "move_and_slide floor detection".'),
        sources,
        k: z.number().int().min(1).max(20).default(5).describe('How many results to return. Default 5, max 20.'),
      },
    },
    logged('search_docs', async ({ query, sources = [], k }) => {
      const results = await searchDocs(db, embed, query, { k, sources });
      if (results.length === 0) {
        const where = sources.length > 0 ? ` in ${sources.join(', ')}` : '';
        return text(`No matches for "${query}"${where}. Try other wording, or list_docs to see what is indexed.`);
      }
      return text(
        results
          .map((r, i) => `### ${i + 1}. ${r.heading ?? r.title ?? r.path}\nsource: ${r.source} | path: ${r.path}\n\n${r.text}`)
          .join('\n\n---\n\n'),
      );
    }),
  );

  server.registerTool(
    'lookup_symbol',
    {
      description:
        'Look up an API symbol by name and return its reference entry ' +
        '(signature and description). Accepts a qualified member (e.g. ' +
        '"CharacterBody2D.move_and_slide", "ActiveRecord::QueryMethods#where", ' +
        '"QueryMethods#where"), a bare member ("move_and_slide"), or a class or ' +
        'module ("Node2D", which also lists its members). Use it to confirm ' +
        'exact names and signatures before using them.',
      inputSchema: {
        name: z.string().trim().min(1).describe('Symbol name, e.g. "Tween.tween_property".'),
        sources,
      },
    },
    logged('lookup_symbol', ({ name, sources = [] }) => lookupSymbol(db, name.replace(/\(\)$/, ''), sources)),
  );

  server.registerTool(
    'read_doc',
    {
      description:
        'Read a whole documentation page (or one section of it) found via ' +
        'search_docs or lookup_symbol, when a result is cut off or more ' +
        'context is needed. Long pages are truncated with an outline.',
      inputSchema: {
        source: source.describe('The source of the page (from a search result).'),
        path: z.string().trim().min(1).describe('Page path, as shown in a search result.'),
        section: z.string().trim().optional().describe('Optional: only return sections whose heading contains this text.'),
      },
    },
    logged('read_doc', ({ source, path, section }) => readDoc(db, source, path, section)),
  );

  return server;
}

function listDocs(db: DocsDb) {
  const rows = db
    .prepare<[], { id: string; name: string; version: string | null; description: string | null; page_count: number; symbol_count: number }>(
      `SELECT id, name, version, description, page_count, symbol_count FROM sources ORDER BY id`,
    )
    .all();
  if (rows.length === 0) return text('No docs sources are ingested yet.');
  return text(
    rows
      .map((r) => {
        const version = r.version ? ` (${r.version})` : '';
        const symbols = r.symbol_count ? `, ${r.symbol_count} symbols` : '';
        return `- ${r.id}: ${r.name}${version}. ${r.description ?? ''} [${r.page_count} pages${symbols}]`;
      })
      .join('\n'),
  );
}

interface SymbolRow {
  name: string;
  kind: string;
  source: string;
  path: string;
  chunk_id: number | null;
  page_id: number;
}

const MEMBERS_PER_KIND = 60; // @GlobalScope alone has hundreds of constants

function lookupSymbol(db: DocsDb, name: string, sources: string[]) {
  const lc = name.toLowerCase();
  const escaped = lc.replace(/[\\%_]/g, '\\$&'); // for LIKE
  const params = { lc, escaped, ...sourceParams(sources) };
  const filter = sourceFilter('s.source', sources);
  const find = (where: string) =>
    db
      .prepare<object, SymbolRow>(
        `SELECT s.name, s.kind, s.source, p.path, s.chunk_id, s.page_id
           FROM symbols s JOIN pages p ON p.id = s.page_id
          WHERE ${where}`,
      )
      .all(params);

  // Most to least specific: exact name, namespace left off
  // ("QueryMethods#where"), then a bare member name.
  let rows = find(`s.name_lc = @lc${filter}`);
  if (rows.length === 0) rows = find(`s.name_lc LIKE '%::' || @escaped ESCAPE '\\'${filter} LIMIT 50`);
  if (rows.length === 0) rows = find(`s.member_lc = @lc${filter} ORDER BY s.name LIMIT 50`);

  const list = (rs: SymbolRow[]) => rs.map((r) => `- ${r.name} (${r.kind}, ${r.source})`).join('\n');

  if (rows.length === 0) {
    const prefix = find(
      `(s.name_lc LIKE @escaped || '%' ESCAPE '\\' OR s.member_lc LIKE @escaped || '%' ESCAPE '\\')${filter}
       ORDER BY length(s.name) LIMIT 20`,
    );
    if (prefix.length === 0) return text(`No symbol named "${name}". Try search_docs with a description of what you need.`);
    return text(`No exact match for "${name}". Symbols starting with it:\n${list(prefix)}`);
  }

  // A bare member can match many classes ("play"): list rather than dump them.
  if (rows.length > 3) {
    return text(`"${name}" matches ${rows.length} symbols. Call lookup_symbol again with the full name:\n${list(rows)}`);
  }

  const chunk = db.prepare<[number], { text: string }>(`SELECT text FROM chunks WHERE id = ?`);
  // A class's members are the other symbols on its page.
  const members = db.prepare<[number, string], { name: string; kind: string }>(
    `SELECT name, kind FROM symbols WHERE page_id = ? AND name != ? ORDER BY kind, name`,
  );

  return text(
    rows
      .map((r) => {
        const body = r.chunk_id != null ? (chunk.get(r.chunk_id)?.text ?? '') : '';
        const entry = `### ${r.name} (${r.kind})\nsource: ${r.source} | path: ${r.path}\n\n${body}`;
        if (r.kind !== 'class') return entry;

        const byKind = new Map<string, string[]>();
        for (const m of members.all(r.page_id, r.name)) {
          // Drop the owner and its separator: "Node2D.position" -> "position".
          const short = m.name.startsWith(r.name) ? m.name.slice(r.name.length).replace(/^(?:#|::|\.)/, '') : m.name;
          byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), short]);
        }
        if (byKind.size === 0) return entry;
        const shown = (names: string[]) =>
          names.length <= MEMBERS_PER_KIND
            ? names.join(', ')
            : `${names.slice(0, MEMBERS_PER_KIND).join(', ')}, ... (+${names.length - MEMBERS_PER_KIND} more)`;
        return (
          `${entry}\n\nMembers (own only; see "Inherits" above for parent classes):\n` +
          [...byKind].map(([kind, names]) => `- ${kind}: ${shown(names)}`).join('\n')
        );
      })
      .join('\n\n---\n\n'),
  );
}

const READ_LIMIT = 16_000; // chars

function readDoc(db: DocsDb, source: string, path: string, section?: string) {
  const page = db
    .prepare<[string, string], { id: number; title: string | null; body: string }>(
      `SELECT id, title, body FROM pages WHERE source = ? AND path = ?`,
    )
    .get(source, path);
  if (!page) return text(`No page "${path}" in ${source}. Use a path from a search_docs result.`);

  const chunks = db
    .prepare<[number], { heading: string | null; text: string }>(`SELECT heading, text FROM chunks WHERE page_id = ? ORDER BY id`)
    .all(page.id);
  const outline = [...new Set(chunks.map((c) => c.heading ?? ''))]
    .filter(Boolean)
    .map((h) => `- ${h}`)
    .join('\n');

  let body = page.body;
  if (section) {
    const matching = chunks.filter((c) => (c.heading ?? '').toLowerCase().includes(section.toLowerCase()));
    if (matching.length === 0) return text(`No section matching "${section}" in ${path}. Sections:\n${outline}`);
    body = matching.map((c) => `## ${c.heading}\n\n${c.text}`).join('\n\n');
  }

  const header = `# ${page.title ?? path}\nsource: ${source} | path: ${path}\n\n`;
  if (body.length <= READ_LIMIT) return text(header + body);
  return text(
    `${header}${body.slice(0, READ_LIMIT)}\n\n[Truncated at ${READ_LIMIT} of ${body.length} chars. ` +
      `Read one section with the \`section\` argument. Sections:\n${outline}]`,
  );
}
