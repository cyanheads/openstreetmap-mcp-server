/**
 * @fileoverview Tests for the Overpass status-reason mapping, the instance-fault signature
 * it shares with the service (#104), the missing-data remark read ahead of it (#123), and the
 * entity decoding of the `Error:` line every one of them reads (#129).
 * @module tests/services/overpass/overpass-error.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  extractOverpassError,
  isAreaDispatcherRefusal,
  isInstanceRefusal,
  missingDataOf,
  OVERPASS_INSTANCE_FAULT_PATTERN,
  overpassStatusReason,
} from '@/services/overpass/overpass-error.js';

/** OSM3S's error document around one `Error:` line, as the public endpoint renders it. */
const osm3sDocument = (line: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<html><body>\n<p>The data included in this document is from www.openstreetmap.org.</p>\n<p><strong style="color:#FF0000">Error</strong>: ${line} </p>\n</body></html>\n`;

const BUSY =
  'runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.';
const OFF = 'runtime error: The dispatcher (i.e. the database management system) is turned off.';
const QUERY_TIMEOUT = 'runtime error: Query timed out in "query" at line 1 after 26 seconds.';
const OOM =
  'runtime error: Query ran out of memory in "query" at line 1. It would need at least 0 MB of RAM to continue.';
const PROXY_PAGE =
  '<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>';

/** The verbatim response text a fixture under `./fixtures/` captured. */
const fixtureBody = (name: string): string =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).body;

/** overpass.openstreetmap.fr's verbatim remark for a `[date:]` query. */
const ATTIC: string = JSON.parse(fixtureBody('overpass-no-attic-remark.json')).remark;

/**
 * Every message this server writes for an Overpass failure, none of which may read as an
 * instance's own words: the service tests both recognizers against its remark messages, and
 * a match on its own wording would write a host off for a fault it never reported.
 */
const SERVER_AUTHORED_MESSAGES = [
  'Overpass reported an error: ',
  'Overpass refused the query as throttled: ',
  'Overpass returned an HTML page instead of JSON — likely rate-limited.',
  'Overpass returned a body that is not JSON: ',
  'Overpass query timed out: ',
  'Overpass ran out of memory: ',
  'Overpass query exceeded the 90000ms client deadline.',
  'Overpass did not answer within the 120000ms budget for this call.',
  'Network error contacting Overpass: ',
  'Overpass query was aborted by the caller.',
  'Overpass query was aborted while waiting for an endpoint slot.',
  'Overpass returned HTTP 504 Gateway Timeout. (failed after 4 attempts)',
  'No Overpass endpoint could serve this query — https://overpass-api.de: HTTP 504 (busy); https://overpass.example: instance fault.',
  'No configured Overpass endpoint holds the data this query reads — https://overpass.example: no attic data; https://overpass.mirror.example: no meta data.',
  'Overpass returned HTTP 502 Bad Gateway. (failed after 4 attempts) Endpoints without the data this query reads — https://overpass.example: no attic data.',
];

describe('overpassStatusReason (#104)', () => {
  /** The reason a status takes, read off the `Error:` line the body carries. */
  const reasonFor = (status: number, body: string) =>
    overpassStatusReason(status, extractOverpassError(body));

  it.each([
    [504, osm3sDocument(BUSY), 'overpass_unavailable'],
    [408, osm3sDocument(BUSY), 'overpass_unavailable'],
    [504, osm3sDocument(OFF), 'overpass_unavailable'],
    [504, osm3sDocument(QUERY_TIMEOUT), 'overpass_gateway_timeout'],
    [504, osm3sDocument(OOM), 'overpass_gateway_timeout'],
    [504, PROXY_PAGE, 'overpass_gateway_timeout'],
    [408, 'request timed out', 'overpass_gateway_timeout'],
    [503, osm3sDocument(BUSY), 'overpass_unavailable'],
    [502, PROXY_PAGE, 'overpass_unavailable'],
    [425, '', 'overpass_unavailable'],
  ] as const)('maps HTTP %i carrying %j to %s', (status, body, reason) => {
    expect(reasonFor(status, body)).toBe(reason);
  });

  it.each([400, 403, 404, 429])('names no reason for HTTP %i', (status) => {
    expect(reasonFor(status, osm3sDocument(BUSY))).toBeUndefined();
  });

  /** The signature is read off the extracted line, never the raw body around it. */
  it('ignores the signature anywhere but the Error: line', () => {
    const body = `<html><body><p>dispatcher too busy open64:</p>${PROXY_PAGE}</body></html>`;
    expect(extractOverpassError(body)).toBeUndefined();
    expect(isInstanceRefusal(504, extractOverpassError(body))).toBe(false);
  });

  it.each(SERVER_AUTHORED_MESSAGES)('does not match the server-authored message %j', (message) => {
    expect(OVERPASS_INSTANCE_FAULT_PATTERN.test(message)).toBe(false);
  });
});

/**
 * #123: an instance built without the data a query reads answers HTTP 200 with a remark
 * whose second half is the file error's own `open64:` line, so it also carries the
 * instance-fault signature. Read on its own, ahead of that signature, it names what the
 * instance lacks.
 */
describe('missingDataOf (#123)', () => {
  /**
   * The metadata sibling. No instance without metadata was captured, so this is the attic
   * capture's shape with the sentence OSM3S's `web_query.cc` writes from the same branch, and
   * the meta file its `open64:` line would then name.
   */
  const META = ATTIC.replace(
    'Tried to use museum file but no museum files available on this instance.',
    'Tried to use meta file but no meta files available on this instance.',
  ).replace('node_tags_global_attic.bin', 'nodes_meta.bin');

  it('reads the captured remark as no attic data, though it carries the instance signature', () => {
    expect(OVERPASS_INSTANCE_FAULT_PATTERN.test(ATTIC)).toBe(true);
    expect(missingDataOf(ATTIC)).toBe('no attic data');
    expect(missingDataOf(`Overpass reported an error: ${ATTIC}`)).toBe('no attic data');
  });

  it('reads the metadata sentence as no meta data', () => {
    expect(META).toContain('no meta files available on this instance');
    expect(missingDataOf(`Overpass reported an error: ${META}`)).toBe('no meta data');
  });

  it.each([
    'runtime error: open64: 2 No such file or directory /data/work/overpass/database/node_tags_global_attic.bin File_Blocks::File_Blocks::1',
    'runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.',
    OFF,
    QUERY_TIMEOUT,
    OOM,
  ])('names nothing for a remark without either sentence: %j', (remark) => {
    expect(missingDataOf(remark)).toBeUndefined();
  });

  it.each(SERVER_AUTHORED_MESSAGES)('does not match the server-authored message %j', (message) => {
    expect(missingDataOf(message)).toBeUndefined();
  });
});

/**
 * #129: OSM3S XML-escapes the text of its error document, so a remark that quotes reached the
 * message as `&quot;`. The `Error:` line is decoded before anything reads or cuts it.
 */
describe('extractOverpassError entity decoding (#129)', () => {
  /** overpass-api.de's verbatim HTTP 400 document for `rel(0)`. */
  const ID_QUERY_BODY = fixtureBody('overpass-id-query-400.json');
  const ID_QUERY =
    'line 2: static error: For the attribute "ref" of the element "id-query" the only allowed values are positive integers.';

  /** OSM3S's escaping of the text it writes into the document. */
  const xmlEscaped = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');

  it('reads the captured remark as Overpass wrote it', () => {
    expect(ID_QUERY_BODY).toContain('&quot;ref&quot;');
    expect(extractOverpassError(ID_QUERY_BODY)).toBe(ID_QUERY);
  });

  it.each([
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&apos;', "'"],
    ['&amp;', '&'],
    ['&#34;', '"'],
    ['&#x22;', '"'],
    ['&#x1F600; &#128512;', '😀 😀'],
    ['a &lt; b and c', 'a < b and c'],
    // `&amp;` decodes as if last: the `&` it yields starts no second reference.
    ['&amp;quot;', '&quot;'],
    ['&amp;amp;', '&amp;'],
    ['&amp;#34;', '&#34;'],
    ['&#38;quot;', '&quot;'],
  ])('decodes %j in an Error: line as %j', (written, read) => {
    expect(extractOverpassError(osm3sDocument(`parse error: ${written}`))).toBe(
      `parse error: ${read}`,
    );
  });

  it.each(['&nbsp; &QUOT; &#X22; &quot &', '&#0; &#xD800; &#x110000; &#99999999999999999999;'])(
    'keeps %j, no reference XML defines or one naming no XML character, as written',
    (written) => {
      expect(extractOverpassError(osm3sDocument(`parse error: ${written}`))).toBe(
        `parse error: ${written}`,
      );
    },
  );

  it('cuts at 300 decoded characters, never counting or splitting an entity', () => {
    const quoted = extractOverpassError(osm3sDocument('&quot;'.repeat(120)));
    expect(quoted).toBe('"'.repeat(120));

    const long = extractOverpassError(osm3sDocument('&lt;'.repeat(400)));
    expect(long).toBe(`${'<'.repeat(300)}…`);
  });

  /**
   * Every classifier reads the decoded line. Each row is a line OSM3S writes, run through its
   * escaping into a document; the verdicts are the ones the line's own words earn, so none may
   * have rested on entity text.
   */
  it.each([
    ['the captured id-query remark', ID_QUERY, 'overpass_gateway_timeout', false, undefined],
    ['a query timeout, which quotes', QUERY_TIMEOUT, 'overpass_gateway_timeout', false, undefined],
    ['an out-of-memory remark', OOM, 'overpass_gateway_timeout', false, undefined],
    ['a busy base dispatcher', BUSY, 'overpass_unavailable', false, undefined],
    ['a dispatcher turned off', OFF, 'overpass_unavailable', true, undefined],
    [
      'a busy area dispatcher',
      'runtime error: open64: 0 Success /osm3s_v0.7.62_areas Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request.',
      'overpass_unavailable',
      true,
      undefined,
    ],
    ['the captured attic remark', ATTIC, 'overpass_unavailable', false, 'no attic data'],
  ] as const)('keeps the verdicts on %s', (_label, line, reason504, areaDispatcher, missing) => {
    const detail = extractOverpassError(osm3sDocument(xmlEscaped(line)));
    expect(detail).toBe(line);
    expect(overpassStatusReason(504, detail)).toBe(reason504);
    expect(overpassStatusReason(400, detail)).toBeUndefined();
    expect(isAreaDispatcherRefusal(detail ?? '')).toBe(areaDispatcher);
    expect(missingDataOf(detail ?? '')).toBe(missing);
  });
});

/**
 * A non-JSON 200 reaches {@link extractOverpassError} whole, up to the service's read ceiling,
 * so its cost over upstream-sized text is held linear. Measured in this thread's CPU time,
 * never wall clock: each size is timed beside a fresh baseline, a batch of calls per
 * measurement, and the least growth across the pairs is held under 4× linear — 256 across the
 * 64× span. The input doubles, checked at each size before the next runs.
 */
describe('extractOverpassError cost (#129)', () => {
  const BASE_CHARS = 5_000;
  /** Text one measurement spends, so a small input is timed over a batch of calls. */
  const BATCH_CHARS = 160_000;
  const PAIRS = 5;

  function cpuMicrosPerCall(body: string): number {
    const calls = Math.max(1, Math.round(BATCH_CHARS / body.length));
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) extractOverpassError(body);
    const spent = process.threadCpuUsage(start);
    return (spent.user + spent.system) / calls;
  }

  /**
   * Shapes past Bun's regex slow-mode switch, about 80k characters, stop below it; the digit
   * and hex runs never reach a regex that switches, so they carry the full span.
   */
  it.each([
    {
      shape: "'§1 x' runs ending '\\ny'",
      make: (n: number) => `Error: ${'§1 x'.repeat(n / 4)}\ny`,
      maxChars: 80_000,
    },
    {
      shape: "'  \\r\\n' runs",
      make: (n: number) => `Error: ${'  \r\n'.repeat(n / 4)}`,
      maxChars: 80_000,
    },
    {
      shape: "'&amp' openers with no closer",
      make: (n: number) => `Error: ${'&amp'.repeat(n / 4)}`,
      maxChars: 80_000,
    },
    {
      shape: 'one Error: line per entity',
      make: (n: number) => 'Error: &quot;x\n'.repeat(n / 16),
      maxChars: 80_000,
    },
    {
      shape: 'a decimal reference with no closer',
      make: (n: number) => `Error: &#${'1'.repeat(n)}`,
      maxChars: 320_000,
    },
    {
      shape: 'a hex reference with no closer',
      make: (n: number) => `Error: &#x${'f'.repeat(n)}`,
      maxChars: 320_000,
    },
  ])('stays linear over $shape', ({ make, maxChars }) => {
    const base = make(BASE_CHARS);
    cpuMicrosPerCall(base);
    for (let chars = BASE_CHARS * 2; chars <= maxChars; chars *= 2) {
      const input = make(chars);
      let growth = Number.POSITIVE_INFINITY;
      for (let pair = 0; pair < PAIRS; pair++) {
        const baseline = cpuMicrosPerCall(base);
        growth = Math.min(growth, cpuMicrosPerCall(input) / baseline);
      }
      expect(growth, `${chars} characters`).toBeLessThan(4 * (chars / BASE_CHARS));
    }
  });
});
