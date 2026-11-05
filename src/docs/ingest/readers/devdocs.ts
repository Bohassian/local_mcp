import fs from 'node:fs';
import path from 'node:path';
import { ANCHOR, htmlToText } from './html.js';
import { readMarkdown } from './markdown.js';
import type { DocSymbol, Page, Section } from './types.js';

// DevDocs bundle (data/devdocs/<slug>/, fetched by `yarn fetch-docs`):
//   index.json  { entries: [{ name, path, type }] }  path = "page#anchor" or "page"
//   db.json     { "<page>": "<html>" }
// Each page becomes one Page. Anchored index entries split the page into one
// section per entry and become symbols; entries without an anchor name the
// page itself (a class, module or guide).

interface IndexEntry {
  name: string;
  path: string;
  type: string;
}

// Anchor for a page's lead section (overview before the first member).
const PAGE_ANCHOR = '__page';

// Kind from rdoc-style anchors (Ruby/Rails); other bundles fall back to the
// generic "entry".
function kindOf(anchor: string | undefined, entry: IndexEntry): string {
  if (!anchor) return entry.type === 'Guides' ? 'guide' : 'page';
  if (anchor.startsWith('method-i-')) return 'instance method';
  if (anchor.startsWith('method-c-')) return 'class method';
  if (anchor.startsWith('attribute-i-')) return 'attribute';
  if (anchor.startsWith('attribute-c-')) return 'class attribute';
  if (/^(constant|const)-/.test(anchor)) return 'constant';
  return 'entry';
}

// rdoc pages put each method's full implementation ("Show source" + a code
// block starting "# File ...") before its description. Dropped: long, and it
// pulls the embedding toward the code rather than what the method does.
function dropSource(text: string): string {
  return text.replace(/Show source\s*\n+```\n# File [^\n]*\n[\s\S]*?\n```\n?/g, '');
}

// The member part of a qualified name: after the last #, ::, or ".".
function memberOf(name: string): string | undefined {
  const m = /(?:#|::|\.)([^#:.]+)$/.exec(name);
  return m?.[1];
}

export function readDevDocs(root: string): Page[] {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')) as {
    entries: IndexEntry[];
  };
  const db = JSON.parse(fs.readFileSync(path.join(root, 'db.json'), 'utf8')) as Record<string, string>;

  // Entries grouped by page.
  const byPage = new Map<string, Array<IndexEntry & { anchor?: string }>>();
  for (const e of index.entries) {
    const [page, anchor] = e.path.split('#');
    const list = byPage.get(page) ?? [];
    list.push({ ...e, anchor: anchor ? decodeURIComponent(anchor) : undefined });
    byPage.set(page, list);
  }

  const pages: Page[] = [];
  for (const [pagePath, html] of Object.entries(db)) {
    if (pagePath === 'index') continue;
    const entries = byPage.get(pagePath) ?? [];
    const pageEntry = entries.find((e) => !e.anchor);
    const anchored = new Map(entries.filter((e) => e.anchor).map((e) => [e.anchor!, e]));

    const marked = dropSource(htmlToText(html, new Set(anchored.keys())));

    // Guides (and other pages without anchored entries) are prose: split them
    // at their headings like markdown, titled by their own `#` heading.
    if (anchored.size === 0) {
      const page = readMarkdown(root, pagePath, marked);
      if (!page) continue;
      // A class or module with no documented members (error classes,
      // constant-only modules) still needs its symbol.
      if (pageEntry && pageEntry.type !== 'Guides') {
        page.title = pageEntry.name;
        page.sections[0].anchor = PAGE_ANCHOR;
        page.symbols.push({ name: pageEntry.name, kind: 'class', anchor: PAGE_ANCHOR });
      }
      pages.push(page);
      continue;
    }

    const title =
      pageEntry?.name ?? /^#\s+(.+)$/m.exec(marked)?.[1]?.trim() ?? pagePath;

    // Split at anchor markers: text before the first marker is the page's own
    // section (class/module overview, or the whole guide).
    const parts = marked.split(new RegExp(`${ANCHOR}([^${ANCHOR}]+)${ANCHOR}`));
    const sections: Section[] = [];
    const lead = parts[0].trim();
    if (lead) sections.push({ heading: title, anchor: PAGE_ANCHOR, text: lead });
    for (let i = 1; i < parts.length; i += 2) {
      const anchor = parts[i];
      const body = (parts[i + 1] ?? '').trim();
      const entry = anchored.get(anchor);
      if (!body || !entry) continue;
      sections.push({ heading: `${entry.name} (${kindOf(anchor, entry)})`, anchor, text: body });
    }
    if (sections.length === 0) continue;

    const symbols: DocSymbol[] = [];
    // Non-guide pages are classes or modules; the index doesn't say which,
    // so both get kind `class` (what lookup_symbol lists members for).
    if (pageEntry && pageEntry.type !== 'Guides' && lead) {
      symbols.push({ name: pageEntry.name, kind: 'class', anchor: PAGE_ANCHOR });
    }
    for (const e of anchored.values()) {
      if (!sections.some((s) => s.anchor === e.anchor)) continue;
      symbols.push({ name: e.name, member: memberOf(e.name), kind: kindOf(e.anchor, e), anchor: e.anchor! });
    }

    pages.push({
      path: pagePath,
      title,
      body: marked.replace(new RegExp(`\\n?${ANCHOR}[^${ANCHOR}]+${ANCHOR}\\n?`, 'g'), '\n'),
      sections,
      symbols,
    });
  }
  return pages;
}
