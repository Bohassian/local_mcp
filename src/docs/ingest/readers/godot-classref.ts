import type { DocSymbol, Page, Reader, Section } from './types.js';

// Godot's generated class reference (godot-docs/classes/class_*.rst). Every
// class and member is preceded by a label such as
//   .. _class_Node2D_property_global_position:
// so the page splits cleanly into one section per member, and the labels
// double as a symbol index.

const LABEL = /^\.\. _(class_[^:\s]+):\s*$/;
const MEMBER =
  /^class_(.+?)_(property|method|private_method|signal|constant|annotation|constructor|operator|theme_color|theme_constant|theme_font_size|theme_font|theme_icon|theme_style|theme_sound)_(.+)$/;

// Readable kind names for symbols and headings. A Map, not an object literal:
// `constructor` is a kind, and obj['constructor'] is Object's constructor.
const KIND = new Map<string, string>([
  ['private_method', 'method'],
  ['theme_color', 'theme color'],
  ['theme_constant', 'theme constant'],
  ['theme_font_size', 'theme font size'],
  ['theme_font', 'theme font'],
  ['theme_icon', 'theme icon'],
  ['theme_style', 'theme style'],
  ['theme_sound', 'theme sound'],
]);

// Section titles the generator emits above each table or list of members.
// Once the summary tables are dropped, some are left with nothing under them.
const GROUP_TITLE =
  /^(Description|Tutorials|Properties|Methods|Signals|Enumerations|Constants|Annotations|Constructors|Operators|Theme Properties|Property Descriptions|Method Descriptions|Constructor Descriptions|Operator Descriptions|Annotation Descriptions|Theme Property Descriptions)$/;

// Drops group titles followed only by another title or the end of the text.
function dropEmptyTitles(lines: string[]): string[] {
  return lines.filter((l, i) => {
    if (!GROUP_TITLE.test(l.trim())) return true;
    const next = lines.slice(i + 1).find((n) => n.trim() !== '');
    return next !== undefined && !GROUP_TITLE.test(next.trim());
  });
}

// Strips the generator's RST markup down to readable text: cross-reference
// roles become their link text, substitutions become words, and the summary
// grid tables (which repeat every member section) are dropped.
export function cleanClassRst(rst: string): string {
  const lines = rst
    .split('\n')
    .filter(
      (l) =>
        !/^\s*\.\. (rst-class|container|table|tabs|code-tab)::/.test(l) &&
        !/^\s*:(allow_comments|github_url|widths):/.test(l) &&
        !/^\s*\.\. _(class|enum)_[^:]*:\s*$/.test(l) &&
        !/^\s*\.\. (DO NOT EDIT|Generated automatically|XML file|Generator:|XML source:)/.test(l) &&
        !/^\s*\+[-=+]+\+\s*$/.test(l) &&
        !/^\s*\| /.test(l) &&
        !/^\s*[-=~^]{4,}\s*$/.test(l),
    );
  return dropEmptyTitles(lines)
    .join('\n')
    .replace(/:ref:`🔗<[^>]*>`/g, '')
    .replace(/:(?:ref|doc):`([^`<]+?)\s*<[^>]+>`/g, '$1')
    .replace(/:(?:ref|doc):`([^`]+)`/g, '$1')
    .replace(/\|(void|const|virtual|vararg|static|required|constructor|operator|bitfield)\|/g, '$1')
    .replace(/\\ /g, '')
    .replace(/\\([:*_`|\\])/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const readGodotClassRef: Reader = (_root, relPath, content) => {
  if (!/(^|\/)class_[^/]+\.rst$/.test(relPath)) return null;

  const lines = content.split('\n');
  const sections: Section[] = [];
  const symbols: DocSymbol[] = [];
  let className = '';
  let current: { heading: string; anchor: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanClassRst(current.lines.join('\n'));
    if (text) sections.push({ heading: current.heading, anchor: current.anchor, text });
    current = null;
  };

  for (const line of lines) {
    const label = LABEL.exec(line);
    if (!label) {
      current?.lines.push(line);
      continue;
    }
    const anchor = label[1];
    const member = MEMBER.exec(anchor);
    if (member) {
      const [, cls, rawKind, name] = member;
      const kind = KIND.get(rawKind) ?? rawKind;
      flush();
      current = { heading: `${cls}.${name} (${kind})`, anchor, lines: [] };
      symbols.push({ name: `${cls}.${name}`, member: name, kind, anchor });
    } else if (!className) {
      // First plain class label: the class itself.
      className = anchor.slice('class_'.length);
      flush();
      current = { heading: `${className} (class)`, anchor, lines: [] };
      symbols.push({ name: className, kind: 'class', anchor });
    } else {
      // Other labels (enum headers etc.) stay inside the current section.
      current?.lines.push(line);
    }
  }
  flush();

  if (!className || sections.length === 0) return null;
  return {
    path: relPath,
    title: className,
    body: cleanClassRst(content),
    sections,
    symbols,
  };
};
