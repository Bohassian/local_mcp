import type { Page, Reader, Section } from './types.js';

// Markdown, split at ATX headings (#, ##, ...). Headings inside fenced code
// blocks are ignored. Each section's heading is "Page title › Heading".
export const readMarkdown: Reader = (_root, relPath, content) => {
  const lines = content.split('\n');
  const firstH1 = lines.find((l) => /^#\s+/.test(l));
  const title = firstH1 ? firstH1.replace(/^#\s+/, '').trim() : relPath;

  const sections: Section[] = [];
  let heading = title;
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const name = h[2].trim();
      heading = name === title ? title : `${title} › ${name}`;
      continue;
    }
    buf.push(line);
  }
  flush();

  if (sections.length === 0) return null;
  const page: Page = { path: relPath, title, body: content, sections, symbols: [] };
  return page;
};
