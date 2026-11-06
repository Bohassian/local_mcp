import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readGodotClassRef } from './godot-classref.js';
import { readMarkdown } from './markdown.js';
import { cleanInlineRst, readRst } from './rst.js';

// Readers turn one source file into a Page: its sections (later chunked and
// embedded) and its symbols (API names, for lookup_symbol and symbol search).

describe('readMarkdown', () => {
  it('splits at headings and prefixes each with the page title', () => {
    const page = readMarkdown('', 'notes.md', '# Deploys\n\nIntro.\n\n## Rollback\n\nRun the script.\n');
    assert.deepEqual(page?.sections, [
      { heading: 'Deploys', text: 'Intro.' },
      { heading: 'Deploys › Rollback', text: 'Run the script.' },
    ]);
  });

  it('ignores # lines inside code fences', () => {
    const page = readMarkdown('', 'n.md', '# T\n\n```sh\n# not a heading\n```\n');
    assert.equal(page?.sections.length, 1);
  });
});

describe('readRst', () => {
  it('takes the title from the first underlined heading', () => {
    const page = readRst('', 'signals.rst', 'Using signals\n=============\n\nIntro.\n\nConnecting\n----------\n\nCode.\n');
    assert.equal(page?.title, 'Using signals');
    assert.deepEqual(
      page?.sections.map((s) => s.heading),
      ['Using signals', 'Using signals › Connecting'],
    );
  });
});

describe('cleanInlineRst', () => {
  it('reduces heading markup to plain text', () => {
    assert.equal(cleanInlineRst('1: :ref:`bool<class_bool>`'), '1: bool');
    assert.equal(cleanInlineRst('Would increasing ``repeat_times`` fix this?'), 'Would increasing repeat_times fix this?');
    assert.equal(cleanInlineRst('_process vs. \\*_input'), '_process vs. *_input');
    assert.equal(cleanInlineRst('Handling :bbcode:`[url]` tag clicks'), 'Handling [url] tag clicks');
  });

  it('is applied to section headings', () => {
    const page = readRst('', 'p.rst', 'Page\n====\n\nIntro.\n\nUsing ``foo``\n-------------\n\nText.\n');
    assert.equal(page?.sections[1].heading, 'Page › Using foo');
  });
});

describe('readGodotClassRef', () => {
  // A cut-down classes/class_*.rst. The `.. _label:` lines mark where each
  // class and member is documented.
  const rst = [
    '.. _class_Label:',
    '',
    'Label',
    '=====',
    '',
    'A control for displaying plain text.',
    '',
    '.. _class_Label_property_text:',
    '',
    'String **text** = ``""``',
    '',
    'The text to display on screen.',
    '',
    '.. _class_Label_method_get_line_count:',
    '',
    'int **get_line_count**\\ (\\ ) |const|',
    '',
    'Returns the number of lines of text.',
  ].join('\n');

  it('makes one section per member, and a symbol pointing at each', () => {
    const page = readGodotClassRef('', 'classes/class_label.rst', rst)!;
    assert.deepEqual(
      page.sections.map((s) => s.heading),
      ['Label (class)', 'Label.text (property)', 'Label.get_line_count (method)'],
    );
    assert.deepEqual(page.symbols, [
      { name: 'Label', kind: 'class', anchor: 'class_Label' },
      { name: 'Label.text', member: 'text', kind: 'property', anchor: 'class_Label_property_text' },
      {
        name: 'Label.get_line_count',
        member: 'get_line_count',
        kind: 'method',
        anchor: 'class_Label_method_get_line_count',
      },
    ]);
  });

  it('strips RST markup down to readable text', () => {
    const page = readGodotClassRef('', 'classes/class_label.rst', rst)!;
    assert.equal(page.sections[2].text, 'int get_line_count() const\n\nReturns the number of lines of text.');
  });

  it('skips files that are not class pages', () => {
    assert.equal(readGodotClassRef('', 'tutorials/intro.rst', rst), null);
  });
});
