/**
 * @fileoverview The notice renderer (#128): a CommonMark parse of the quote it writes reads back
 * the notice, for every value the tag validator admits; lines handing a call back to a tool
 * render as code spans; the next trailer field still opens its own block; cost stays linear.
 * @module tests/tools/openstreetmap-markdown-escape.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { describe, expect, it, vi } from 'vitest';
import {
  escapeMarkdownValue,
  renderNoticeMarkdown,
} from '@/mcp-server/tools/definitions/openstreetmap-markdown-escape.js';
import { resolveTagInput } from '@/mcp-server/tools/definitions/openstreetmap-tag-input.js';
import { commonmark } from '../helpers/markdown.js';

/** One quoted paragraph: the only block structure a rendered notice may parse to. */
const QUOTE_BLOCKS = [
  'blockquote_open',
  'paragraph_open',
  'inline',
  'paragraph_close',
  'blockquote_close',
];

/** The inline tokens a notice quote may hold: anything else is live Markdown or HTML. */
const NOTICE_INLINE = new Set(['text', 'softbreak', 'hardbreak', 'code_inline']);

/** What a CommonMark parse of `markdown` reads back, with the structure it parsed to. */
function readBack(markdown: string) {
  const tokens = commonmark.parse(markdown, {});
  const children = tokens.flatMap((token) => token.children ?? []);
  return {
    blocks: tokens.map((token) => token.type),
    stray: children.map((child) => child.type).filter((type) => !NOTICE_INLINE.has(type)),
    text: children.map((child) => (child.type.endsWith('break') ? '\n' : child.content)).join(''),
  };
}

/** The read-back a notice must have: one quoted paragraph holding it, line breaks as LF. */
const readsAs = (notice: string) => ({
  blocks: QUOTE_BLOCKS,
  stray: [],
  text: notice.replace(/\r\n?/g, '\n'),
});

/** The empty-page sentence the Overpass tools quote a tag chain in. */
const inSentence = (value: string) =>
  `No amenity=${value} features found within 100m. Try a larger radius_meters, a different tag, or verify the coordinates.`;

/**
 * Tag values built from every character the convenience tools admit, line breaks included,
 * drawn from a fixed seed and filtered through the real validator, so the population follows
 * what the validator lets through. NUL is left out: CommonMark reads it as U+FFFD, and no
 * Markdown form of it reads back.
 */
function admittedValues(): string[] {
  const alphabet = [
    ...Array.from({ length: 0x5f }, (_, i) => String.fromCharCode(0x20 + i)),
    '\n',
    '\r',
    '\r\n',
    '\t',
    '\v',
    '\u{a0}',
    'é',
    '😀',
    '\u{301}',
    '&amp;',
    '&#123;',
    '<b>',
    '</b>',
    '<https://x.io>',
    '<a@b.io>',
    '```',
    '~~',
    '***',
    '1.',
    '1)',
    '---',
    '===',
    '    ',
  ];
  const targeted = [
    '*x*',
    '_x_',
    '`x`',
    '``x``',
    '<b>x</b>',
    '<https://evil.example>',
    '&amp;',
    '&#42;',
    '~~x~~',
    'a|b',
    '!x',
    'x\n# h',
    'x\n> q',
    'x\n- i',
    'x\n+ i',
    'x\n* i',
    'x\n1. i',
    'x\n1) i',
    'x\n---',
    'x\n===',
    'x\n```',
    'x\n    code',
    'x\n\ny',
    'a|b\n-|-',
    'x\r\ny',
    'x\ry',
    'x\ty',
    'C#',
    'x #',
    'x ###\ny',
    'x\n#',
    'snake_case',
    "Dick's Drive-In",
  ];
  const samples = new Set(targeted);
  let seed = 42;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x100000000;
  };
  while (samples.size < 30_000) {
    let value = '';
    for (let n = 1 + Math.floor(next() * 10); n > 0; n--) {
      value += alphabet[Math.floor(next() * alphabet.length)];
    }
    samples.add(value);
  }
  return [...samples].flatMap((amenity) => {
    const resolved = resolveTagInput({ amenity });
    return 'error' in resolved || resolved.tagValue === undefined ? [] : [resolved.tagValue];
  });
}

describe('renderNoticeMarkdown', () => {
  it('reads back a notice holding any value the tag validator admits, alone or in a sentence', () => {
    const values = admittedValues();
    const failures = values
      .flatMap((value) => [value, inSentence(value)])
      .filter(
        (notice) =>
          JSON.stringify(readBack(renderNoticeMarkdown(notice))) !==
          JSON.stringify(readsAs(notice)),
      );
    expect(values.length).toBeGreaterThan(15_000);
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it.each([
    { form: 'LF', notice: 'a\nb' },
    { form: 'CRLF', notice: 'a\r\nb' },
    { form: 'CR', notice: 'a\rb' },
    { form: 'mixed breaks', notice: 'a\r\nb\rc\nd' },
    { form: 'a blank line', notice: 'a\r\n\r\nb' },
    { form: 'two blank lines', notice: 'a\n\n\nb' },
    { form: 'a leading break', notice: '\na' },
    { form: 'a trailing break', notice: 'a\n' },
    { form: 'two trailing breaks', notice: 'a\r\n\r\n' },
    { form: 'a break alone', notice: '\n' },
  ])('reads back $form as LF', ({ notice }) => {
    expect(readBack(renderNoticeMarkdown(notice))).toEqual(readsAs(notice));
  });

  /**
   * The read-back reads a soft break, a hard break, and an LF inside text alike, and a parse
   * turns a raw CR into LF first, so a CR left unsplit or a middle blank line written as `&#10;`
   * reads back the same as a quoted line. These pin the bytes: each line opens with `> `, lines
   * join with hard breaks, and only a final break is `&#10;`.
   */
  it.each([
    { form: 'a CR', notice: 'a\rb', rendered: '> a\\\n> b' },
    { form: 'mixed breaks', notice: 'a\r\nb\rc\nd', rendered: '> a\\\n> b\\\n> c\\\n> d' },
    { form: 'a blank line', notice: 'a\n\nb', rendered: '> a\\\n> \\\n> b' },
    { form: 'a CRLF blank line', notice: 'a\r\n\r\nb', rendered: '> a\\\n> \\\n> b' },
    { form: 'a trailing break', notice: 'a\n', rendered: '> a&#10;' },
  ])('writes $form as a quoted line per line', ({ notice, rendered }) => {
    expect(renderNoticeMarkdown(notice)).toBe(rendered);
  });

  it.each([
    { text: 'entity-shaped text', notice: 'No amenity=&amp; &copy; &#38; &#x26; features found.' },
    { text: 'leading spaces', notice: '  x' },
    { text: 'trailing spaces', notice: 'x  ' },
    { text: 'spaces around a line between others', notice: 'x\n  y  \nz' },
    { text: 'tabs at the edges', notice: '\tx\t' },
    { text: 'a no-break space at the end', notice: 'x\u{a0}' },
  ])('reads back $text', ({ notice }) => {
    expect(readBack(renderNoticeMarkdown(notice))).toEqual(readsAs(notice));
  });

  it('writes a notice with no Markdown-active character as a plain quote', () => {
    const notice =
      'No amenity=cafe features found within 100m. Try a larger radius_meters, a different tag, or verify the coordinates.';
    expect(renderNoticeMarkdown(notice)).toBe(`> ${notice}`);
  });

  it('escapes the issue reproduction values line by line, each line quoted', () => {
    expect(renderNoticeMarkdown(inSentence('*x*'))).toBe(
      '> No amenity=\\*x\\* features found within 100m. Try a larger radius_meters, a different tag, or verify the coordinates.',
    );
    expect(renderNoticeMarkdown('No amenity=x\n# heading\n- item features found.')).toBe(
      '> No amenity=x\\\n> \\# heading\\\n> \\- item features found.',
    );
  });

  /**
   * A line that is a call to hand back to a tool starts with `[out:json]` or `{"` and renders
   * as one code span, so the characters a reader copies out are the notice's own, with no
   * backslash. The fence outruns every backtick run in the line, padded where a backtick
   * touches an end. Caller tag text cannot start such a line: the validator rejects `[` and `"`.
   */
  describe('a line that hands a call back to a tool', () => {
    it.each([
      {
        holding: 'Overpass QL',
        line: '[out:json];rel(237385);out tags 1;',
        rendered: '> `[out:json];rel(237385);out tags 1;`',
      },
      {
        holding: 'a JSON argument object',
        line: '{"osm_ids":["R237385"],"limit":1}',
        rendered: '> `{"osm_ids":["R237385"],"limit":1}`',
      },
      {
        holding: 'a backtick run inside',
        line: '[out:json];node["name"="a``b"];out;',
        rendered: '> ```[out:json];node["name"="a``b"];out;```',
      },
      {
        holding: 'a backtick run at its end',
        line: '[out:json];out;//``',
        rendered: '> ``` [out:json];out;//`` ```',
      },
      {
        holding: 'brackets, quotes, and HTML',
        line: '{"name":"<b>Café</b> [x]"}',
        rendered: '> `{"name":"<b>Café</b> [x]"}`',
      },
      {
        holding: 'a trailing space',
        line: '[out:json];out; ',
        rendered: '> `[out:json];out; `',
      },
    ])('renders a line holding $holding as one code span', ({ line, rendered }) => {
      expect(renderNoticeMarkdown(line)).toBe(rendered);
      const tokens = commonmark.parse(rendered, {});
      expect(tokens.flatMap((token) => token.children ?? [])).toMatchObject([
        { type: 'code_inline', content: line },
      ]);
    });

    it('keeps the code span on its own line between escaped lines', () => {
      const notice =
        'Check it with openstreetmap_query_raw, query\n[out:json];rel(1);out ids 1;\nand limit 1: an *empty* result means no such id.';
      const rendered = renderNoticeMarkdown(notice);
      expect(rendered).toBe(
        '> Check it with openstreetmap_query_raw, query\\\n> `[out:json];rel(1);out ids 1;`\\\n> and limit 1: an \\*empty\\* result means no such id.',
      );
      expect(readBack(rendered)).toEqual(readsAs(notice));
    });

    it.each([
      {
        line: 'query [out:json];out; next',
        rendered: '> query \\[out:json\\];out; next',
      },
      { line: ' [out:json];out;', rendered: '> &#32;\\[out:json\\];out;' },
      { line: "{'a':1}", rendered: "> {'a':1}" },
      { line: 'query {"a":1} next', rendered: '> query {"a":1} next' },
    ])('escapes $line, which does not start with a hand-back prefix', ({ line, rendered }) => {
      expect(renderNoticeMarkdown(line)).toBe(rendered);
      expect(readBack(rendered)).toEqual(readsAs(line));
    });
  });

  /**
   * The framework ends a quote before the next trailer field only when the field's last line
   * opens one, so every line the renderer writes must start with `>`. Neither Overpass tool
   * enriches a field after its notice, so a probe tool puts one there.
   */
  describe('the trailer field after a rendered notice', () => {
    const probe = tool('probe_notice_trailer', {
      description: 'Enriches a notice and then a total.',
      input: z.object({ notice: z.string().describe('Notice text.') }),
      output: z.object({ ok: z.boolean().describe('Always true.') }),
      enrichment: {
        notice: z.string().describe('Notice.'),
        totalFound: z.number().describe('Total.'),
      },
      enrichmentTrailer: {
        notice: { render: renderNoticeMarkdown },
        totalFound: { label: 'Total Found' },
      },
      handler(input, ctx) {
        ctx.enrich.notice(input.notice);
        ctx.enrich({ totalFound: 3 });
        return { ok: true };
      },
      format: () => [{ type: 'text', text: 'ok' }],
    });

    it.each([
      { ending: 'a plain line', notice: 'No amenity=cafe features found within 100m.' },
      { ending: 'an escaped line', notice: 'x\n- item' },
      { ending: 'a line break', notice: 'x\n' },
      { ending: 'a code span', notice: 'Check it:\n[out:json];rel(1);out ids 1;' },
    ])('opens its own block after a notice ending in $ending', async ({ notice }) => {
      const result = await runToolContract(probe, { notice });
      const text = (result.content as { text: string }[]).map((block) => block.text).join('');
      const tokens = commonmark.parse(text, {});
      const open = tokens.findIndex((token) => token.type === 'blockquote_open');
      const close = tokens.findIndex((token) => token.type === 'blockquote_close');
      const quoted = tokens.slice(open + 1, close).flatMap((token) => token.children ?? []);
      expect(
        quoted.map((child) => (child.type.endsWith('break') ? '\n' : child.content)).join(''),
      ).toBe(notice);
      const after = tokens.slice(close + 1);
      expect(after.map((token) => token.type)).toEqual([
        'paragraph_open',
        'inline',
        'paragraph_close',
      ]);
      expect(after[1]?.content).toBe('**Total Found:** 3');
    });
  });
});

/**
 * The tag inputs carry no schema length limit, so a caller-sized value reaches the renderer and
 * the framework escaper whole. Measured in this thread's CPU time, never wall clock: each size
 * is timed beside a fresh baseline, a batch of calls per measurement, and the least growth across
 * the pairs is held under 4× linear — 256 across the digit run's 64× span — with an absolute
 * ceiling of 1 µs per character. The input doubles, checked at each size before the next runs.
 */
describe('renderNoticeMarkdown cost', () => {
  const BASE_CHARS = 5_000;
  /** Text one measurement spends, so a small input is timed over a batch of calls. */
  const BATCH_CHARS = 160_000;
  const PAIRS = 5;

  function cpuMicrosPerCall(notice: string): number {
    const calls = Math.max(1, Math.round(BATCH_CHARS / notice.length));
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) renderNoticeMarkdown(notice);
    const spent = process.threadCpuUsage(start);
    return (spent.user + spent.system) / calls;
  }

  /**
   * Shapes stop at 80k characters, below Bun's regex slow-mode switch; the digit run reaches no
   * regex that switches, so it carries the full span.
   */
  it.each([
    {
      shape: "'§1 x' runs ending '\\ny'",
      make: (n: number) => `${'§1 x'.repeat(n / 4)}\ny`,
      maxChars: 80_000,
    },
    { shape: "'  \\r\\n' runs", make: (n: number) => '  \r\n'.repeat(n / 4), maxChars: 80_000 },
    {
      shape: "a '#' run closing a line",
      make: (n: number) => `No amenity=x ${'#'.repeat(n)}\ny`,
      maxChars: 80_000,
    },
    {
      shape: "'<1@' openers with no closer",
      make: (n: number) => '<1@'.repeat(n / 3),
      maxChars: 80_000,
    },
    {
      shape: "'&amp' openers with no closer",
      make: (n: number) => '&amp'.repeat(n / 4),
      maxChars: 80_000,
    },
    { shape: "'_' and '\\' runs", make: (n: number) => '_\\'.repeat(n / 2), maxChars: 80_000 },
    {
      shape: 'a hand-back line of backtick runs',
      make: (n: number) => `[out:json]${'`a'.repeat(n / 2)}`,
      maxChars: 80_000,
    },
    { shape: 'a digit run', make: (n: number) => '1'.repeat(n), maxChars: 320_000 },
  ])(
    'stays linear over $shape',
    ({ make, maxChars }) => {
      const base = make(BASE_CHARS);
      cpuMicrosPerCall(base);
      for (let chars = BASE_CHARS * 2; chars <= maxChars; chars *= 2) {
        const input = make(chars);
        let growth = Number.POSITIVE_INFINITY;
        let perCall = Number.POSITIVE_INFINITY;
        for (let pair = 0; pair < PAIRS; pair++) {
          const baseline = cpuMicrosPerCall(base);
          const spent = cpuMicrosPerCall(input);
          perCall = Math.min(perCall, spent);
          growth = Math.min(growth, spent / baseline);
        }
        expect(growth, `${chars} characters`).toBeLessThan(4 * (chars / BASE_CHARS));
        expect(perCall, `${chars} characters, µs per call`).toBeLessThan(chars);
      }
    },
    0,
  );
});

/**
 * The raw-element fallback of `openstreetmap_query_raw`. An array is escaped one item at a time:
 * the framework escaper's working memory grows with the text one call is given, and a relation's
 * `members` with full geometry runs to tens of megabytes as JSON.
 */
describe('escapeMarkdownValue', () => {
  const MEMBER = { type: 'way', ref: 7, role: 'outer', geometry: [{ lat: -17.5, lon: 179.99 }] };

  it('renders an array as its JSON with the brackets and each string escaped', () => {
    expect(escapeMarkdownValue([MEMBER, -1.5, 'a*b_', null, true, [1, 'x[y]'], {}])).toBe(
      String.raw`\[{"type":"way","ref":7,"role":"outer","geometry":\[{"lat":-17.5,"lon":179.99}\]},-1.5,"a\*b\_",null,true,\[1,"x\[y\]"\],{}\]`,
    );
    expect(escapeMarkdownValue([])).toBe(String.raw`\[\]`);
  });

  it.each([
    { label: 'relation members with geometry', value: [MEMBER, { ...MEMBER, ref: 8, role: '' }] },
    { label: 'node ids', value: [1, 22, 333] },
    { label: 'negative and exponent numbers', value: [-1, -0.5, 1e21, 1e-7] },
    {
      label: 'strings that open Markdown blocks',
      value: ['# h', '- item', '1. one', '> q', '---'],
    },
    {
      label: 'strings holding inline Markdown and HTML',
      value: ['*a*', '_a_', '`a`', '<b>x</b>', '&amp;', 'a|b', '~~a~~', '[t](u)', 'a\\b'],
    },
    {
      label: 'strings that meet at an item boundary',
      value: ['a_', '_b', '<http://a', 'b>', '&', 'amp;'],
    },
    { label: 'strings with line breaks and edge spaces', value: [' a ', 'a\nb', 'a\r\nb', '\t'] },
    { label: 'nested arrays and objects', value: [[1, [2, ['x*']]], { a: [{ b: '_c_' }] }, []] },
    { label: 'null and booleans', value: [null, true, false] },
  ])('renders $label as the serialized array escaped whole', ({ value }) => {
    expect(escapeMarkdownValue(value)).toBe(escapeMarkdownInline(JSON.stringify(value)));
  });

  /**
   * The one place the two part: the framework escapes a `<` that a later `@…>` could close as an
   * email autolink, and an item is escaped without sight of the next. The quote and comma between
   * two items are not address characters, so nothing links and the JSON reads back whole.
   */
  it.each([
    { value: ['<', '@>'], rendered: String.raw`\["<","@>"\]` },
    {
      value: [{ role: '<' }, { role: 'a@b.io>' }],
      rendered: String.raw`\[{"role":"<"},{"role":"a@b.io>"}\]`,
    },
    { value: [['<'], [['@>']]], rendered: String.raw`\[\["<"\],\[\["@>"\]\]\]` },
  ])(
    'leaves a < that only a later item could close as an autolink: $rendered',
    ({ value, rendered }) => {
      expect(escapeMarkdownValue(value)).toBe(rendered);
      expect(readBack(rendered)).toEqual({
        blocks: ['paragraph_open', 'inline', 'paragraph_close'],
        stray: [],
        text: JSON.stringify(value),
      });
    },
  );

  it('escapes that < when the address closes inside the same item', () => {
    const value = [{ a: '<x', b: 'y@z.io>' }, '<a@b.io>'];
    const rendered = escapeMarkdownValue(value);
    expect(rendered).toBe(String.raw`\[{"a":"\<x","b":"y@z.io>"},"\<a@b.io>"\]`);
    expect(readBack(rendered)).toEqual({
      blocks: ['paragraph_open', 'inline', 'paragraph_close'],
      stray: [],
      text: JSON.stringify(value),
    });
  });

  it('renders an object as its JSON and a scalar as its string, escaped', () => {
    expect(escapeMarkdownValue({ minlat: -1.5, name: '*x*' })).toBe(
      String.raw`{"minlat":-1.5,"name":"\*x\*"}`,
    );
    expect(escapeMarkdownValue('a*b')).toBe(String.raw`a\*b`);
    expect(escapeMarkdownValue(42)).toBe('42');
  });

  it('hands the framework escaper one array item at a time, and no number at all', async () => {
    const seen: number[] = [];
    vi.resetModules();
    vi.doMock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
      return {
        ...actual,
        escapeMarkdownInline: (text: string) => {
          seen.push(text.length);
          return actual.escapeMarkdownInline(text);
        },
      };
    });
    try {
      const fresh = await import('@/mcp-server/tools/definitions/openstreetmap-markdown-escape.js');
      const members = Array.from({ length: 100 }, (_, i) => ({ ...MEMBER, ref: 100 + i }));
      const nodes = Array.from({ length: 5_000 }, (_, i) => i + 1);
      fresh.escapeMarkdownValue(members);
      fresh.escapeMarkdownValue(nodes);
      // One call per member, each the 79 characters of that member's JSON; none for a node id.
      expect(seen).toHaveLength(100);
      expect(Math.max(...seen)).toBe(79);
    } finally {
      vi.doUnmock('@cyanheads/mcp-ts-core/utils');
      vi.resetModules();
    }
  });
});
