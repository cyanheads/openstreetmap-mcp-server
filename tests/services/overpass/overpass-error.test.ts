/**
 * @fileoverview Tests for the Overpass status-reason mapping and the instance-fault
 * signature it shares with the service (#104).
 * @module tests/services/overpass/overpass-error.test
 */

import { describe, expect, it } from 'vitest';
import {
  extractOverpassError,
  isInstanceRefusal,
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

  /**
   * Every message this server writes for an Overpass failure, none of which may read as an
   * instance's own words: the service tests the signature against its remark messages, and
   * a match on its own wording would write a host off for a fault it never reported.
   */
  it.each([
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
  ])('does not match the server-authored message %j', (message) => {
    expect(OVERPASS_INSTANCE_FAULT_PATTERN.test(message)).toBe(false);
  });
});
