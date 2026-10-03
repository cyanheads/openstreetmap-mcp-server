/**
 * @fileoverview Tests for the Overpass endpoint settings in the server config: the
 * `|N` capacity suffix on `OSM_OVERPASS_ENDPOINTS` entries and its rejection on the
 * pinned `OSM_OVERPASS_BASE_URL` (#92).
 * @module tests/config/server-config.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Parses the config fresh from the given Overpass variables; unset ones read as absent. */
async function loadConfig(env: {
  OSM_OVERPASS_BASE_URL?: string;
  OSM_OVERPASS_ENDPOINTS?: string;
  OSM_OVERPASS_MAX_CONCURRENCY?: string;
}) {
  vi.resetModules();
  vi.stubEnv('OSM_OVERPASS_BASE_URL', env.OSM_OVERPASS_BASE_URL ?? '');
  vi.stubEnv('OSM_OVERPASS_ENDPOINTS', env.OSM_OVERPASS_ENDPOINTS ?? '');
  vi.stubEnv('OSM_OVERPASS_MAX_CONCURRENCY', env.OSM_OVERPASS_MAX_CONCURRENCY ?? '');
  const { getServerConfig } = await import('@/config/server-config.js');
  return getServerConfig();
}

/** The startup error a config load raises, failing the test when it loads cleanly. */
async function startupError(env: Parameters<typeof loadConfig>[0]): Promise<McpError> {
  const error = await loadConfig(env).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(McpError);
  expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  return error as McpError;
}

describe('OSM_OVERPASS_ENDPOINTS |N suffix (#92)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the default as one unsuffixed entry', async () => {
    const config = await loadConfig({});
    expect(config.overpassEndpoints).toEqual([{ url: 'https://overpass-api.de/api/interpreter' }]);
  });

  /**
   * The suffix is split at the last `|`, so a URL that needs a literal pipe writes it
   * percent-encoded and still takes a suffix after it.
   */
  it('parses an |N suffix at the last pipe and keeps %7C inside the URL', async () => {
    const config = await loadConfig({
      OSM_OVERPASS_ENDPOINTS:
        'https://overpass-api.de/api/interpreter, https://h/a%7Cb/interpreter|3 ,https://mirror.example/api/interpreter|12',
    });

    expect(config.overpassEndpoints).toEqual([
      { url: 'https://overpass-api.de/api/interpreter' },
      { url: 'https://h/a%7Cb/interpreter', maxConcurrent: 3 },
      { url: 'https://mirror.example/api/interpreter', maxConcurrent: 12 },
    ]);
  });

  /**
   * The schema before the `|N` suffix accepted every one of these as a URL with the pipe in
   * its path, so a typo'd suffix was POSTed to a wrong path instead of failing at startup.
   */
  it.each([
    'https://mirror.example/api/interpreter|',
    'https://mirror.example/api/interpreter|0',
    'https://mirror.example/api/interpreter|-1',
    'https://mirror.example/api/interpreter|2.5',
    'https://mirror.example/api/interpreter|four',
    'https://h/a|b/interpreter',
    'https://h/a|b/interpreter|3',
  ])('fails startup naming OSM_OVERPASS_ENDPOINTS for %s', async (entry) => {
    const error = await startupError({
      OSM_OVERPASS_ENDPOINTS: `https://overpass-api.de/api/interpreter,${entry}`,
    });
    expect(error.message).toContain('OSM_OVERPASS_ENDPOINTS');
  });

  /**
   * A second entry for one URL is a second slot line and a second fault record for the
   * same host, so a call walking the list re-asked a host that had just refused or shed
   * it, with no backoff between, and a terminal error named the host twice.
   */
  it('keeps the first entry of a repeated URL, suffix and all', async () => {
    const config = await loadConfig({
      OSM_OVERPASS_ENDPOINTS:
        'https://a.example/api/interpreter|2,https://b.example/api/interpreter, https://a.example/api/interpreter|4,https://b.example/api/interpreter',
    });

    expect(config.overpassEndpoints).toEqual([
      { url: 'https://a.example/api/interpreter', maxConcurrent: 2 },
      { url: 'https://b.example/api/interpreter' },
    ]);
  });

  it('rejects a suffix on OSM_OVERPASS_BASE_URL, naming OSM_OVERPASS_MAX_CONCURRENCY', async () => {
    const error = await startupError({
      OSM_OVERPASS_BASE_URL: 'https://h/api/interpreter|4',
    });
    expect(error.message).toContain('OSM_OVERPASS_BASE_URL');
    expect(error.message).toContain('OSM_OVERPASS_MAX_CONCURRENCY');
  });

  it('accepts a pinned URL carrying an encoded pipe', async () => {
    const config = await loadConfig({ OSM_OVERPASS_BASE_URL: 'https://h/a%7Cb/interpreter' });
    expect(config.overpassBaseUrl).toBe('https://h/a%7Cb/interpreter');
  });
});
