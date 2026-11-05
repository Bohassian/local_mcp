import type { Page, Reader, Section } from './types.js';

// RST underline/overline characters used for section titles.
const ADORNMENT = /^([=\-~^*#"'`+:._])\1{2,}\s*$/;

// Page title: the first adorned heading.
export function deriveTitle(rst: string, fallback: string): string {
  const lines = rst.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line && ADORNMENT.test(lines[i + 1]) && lines[i + 1].trim().length >= line.length - 2) {
      return line;
    }
  }
  return fallback;
}

// Splits an RST document at its section headings. Each section's heading is
// "Page title › Section title" so it carries page context into search.
export function splitRstSections(rst: string, title: string): Section[] {
  const lines = rst.split('\n');
  const sections: Section[] = [];
  let heading = title;
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const isHeading =
      line.trim() !== '' &&
      !ADORNMENT.test(line) &&
      next !== undefined &&
      ADORNMENT.test(next) &&
      next.trim().length >= line.trim().length - 2;
    if (isHeading) {
      // Drop this heading's overline, already pushed into the buffer.
      if (buf.length > 0 && ADORNMENT.test(buf[buf.length - 1])) buf.pop();
      flush();
      const name = line.trim();
      heading = name === title ? title : `${title} › ${name}`;
      i++;
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

export const readRst: Reader = (_root, relPath, content) => {
  const title = deriveTitle(content, relPath);
  const sections = splitRstSections(content, title);
  if (sections.length === 0) return null;
  const page: Page = { path: relPath, title, body: content, sections, symbols: [] };
  return page;
};
