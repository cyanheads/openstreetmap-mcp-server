/**
 * @fileoverview Startup of the real entry point under an invalid server env var (#97): the
 * server config is parsed in `setup()`, so the process exits non-zero with the framework's
 * configuration banner naming the variable, on stdio and on HTTP, before any transport
 * starts — rather than reporting ready and failing every tool call.
 * @module tests/index.test
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const LOGS_DIR = mkdtempSync(join(tmpdir(), 'osm-startup-'));

afterAll(() => {
  rmSync(LOGS_DIR, { recursive: true, force: true });
});

/**
 * Runs `src/index.ts` with nothing from the shell or `.env` but the variables given. A server
 * that does start is stopped by the spawn's own timeout, which signals only this child.
 */
function start(transport: 'stdio' | 'http', variable: string, value: string) {
  return spawnSync('bun', ['--no-env-file', 'src/index.ts'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LOGS_DIR,
      MCP_TRANSPORT_TYPE: transport,
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '39797',
      MCP_HTTP_MAX_PORT_RETRIES: '0',
      [variable]: value,
    },
    input: '',
    encoding: 'utf8',
    timeout: 10_000,
  });
}

describe('startup with an invalid server env var (#97)', () => {
  it.each([
    ['stdio', 'OSM_OVERPASS_ENDPOINTS', 'not-a-url'],
    ['stdio', 'OSM_OVERPASS_ENDPOINTS', 'https://mirror.example/api/interpreter|four'],
    ['stdio', 'OSM_OVERPASS_BASE_URL', 'https://overpass.example/api/interpreter|4'],
    ['http', 'OSM_OVERPASS_ENDPOINTS', 'not-a-url'],
    ['http', 'OSM_OVERPASS_ENDPOINTS', 'https://mirror.example/api/interpreter|four'],
    ['http', 'OSM_OVERPASS_BASE_URL', 'https://overpass.example/api/interpreter|4'],
  ] as const)(
    'exits 1 on %s for %s=%s, the banner naming the variable',
    (transport, variable, value) => {
      const run = start(transport, variable, value);
      const banner = run.stderr.split('Configuration error — server failed to start')[1];

      expect(run.signal).toBeNull();
      expect(run.status).toBe(1);
      expect(banner).toContain('Server config validation failed:');
      expect(banner).toContain(variable);
      expect(`${run.stdout}${run.stderr}`).not.toContain('is now running and ready');
    },
    15_000,
  );
});
