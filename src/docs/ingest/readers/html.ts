// Minimal HTML-to-text for DevDocs pages. DevDocs serves generated, sanitized
// HTML (no scripts, well-formed tags), so a tag-level pass is enough and
// avoids a parser dependency. Output is markdown-ish: headings as #, code
// blocks fenced, inline code in backticks, list items as "- ".
//
// Elements whose id is in `anchors` emit a marker (see ANCHOR) at their
// position, so callers can split the text into one section per anchor.

export const ANCHOR = '\u0000';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rarr: '→',
  larr: '←',
  copy: '©',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'table', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd',
  'blockquote', 'details', 'summary', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'br', 'hr',
]);

export function htmlToText(html: string, anchors: Set<string> = new Set()): string {
  const out: string[] = [];
  let inPre = 0;
  let last = 0;
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<!--[\s\S]*?-->/g;

  const text = (s: string) => {
    if (!s) return;
    const decoded = decodeEntities(s);
    out.push(inPre ? decoded : decoded.replace(/\s+/g, ' '));
  };

  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    text(html.slice(last, m.index));
    last = tag.lastIndex;
    if (!m[2]) continue; // comment
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3];

    if (!closing) {
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      if (id && anchors.has(id)) out.push(`\n${ANCHOR}${id}${ANCHOR}\n`);
    }

    if (name === 'pre') {
      if (closing) {
        inPre = Math.max(0, inPre - 1);
        out.push('\n```\n');
      } else {
        inPre++;
        out.push('\n```\n');
      }
    } else if (name === 'code' && !inPre) {
      out.push('`');
    } else if (/^h[1-6]$/.test(name)) {
      out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `);
    } else if (name === 'li' && !closing) {
      out.push('\n- ');
    } else if ((name === 'td' || name === 'th') && closing) {
      out.push(' | ');
    } else if (BLOCK.has(name)) {
      out.push(closing || name === 'br' || name === 'hr' ? '\n' : '\n\n');
    }
  }
  text(html.slice(last));

  // Tidy whitespace outside code fences only; indentation inside them matters.
  return out
    .join('')
    .split(/(\n```\n[\s\S]*?\n```\n)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/`\s*`/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n'),
    )
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
