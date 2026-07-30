/**
 * @fileoverview Server-specific environment variable configuration.
 * @module config/server-config
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/** Read version from package.json at startup so the User-Agent stays in sync. */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const defaultUserAgent = `openstreetmap-mcp-server/${readPackageVersion()}`;

const ServerConfigSchema = z.object({
  nominatimBaseUrl: z
    .string()
    .url()
    .default('https://nominatim.openstreetmap.org')
    .describe('Nominatim API base URL. Override to use a private or mirror instance.'),
  overpassBaseUrl: z
    .string()
    .url()
    .default('https://overpass-api.de/api/interpreter')
    .describe('Overpass API endpoint URL. Override to use a mirror or private instance.'),
  overpassMaxConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .default(2)
    .describe(
      'Maximum Overpass queries submitted at once. The public endpoint advertises its budget at /api/status and answers HTTP 429 beyond it; raise only for a mirror or private instance with a larger budget.',
    ),
  nominatimUserAgent: z
    .string()
    .default(defaultUserAgent)
    .describe('User-Agent sent to Nominatim and Overpass. Required by usage policy.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    nominatimBaseUrl: 'OSM_NOMINATIM_BASE_URL',
    overpassBaseUrl: 'OSM_OVERPASS_BASE_URL',
    overpassMaxConcurrency: 'OSM_OVERPASS_MAX_CONCURRENCY',
    nominatimUserAgent: 'OSM_USER_AGENT',
  });
  return _config;
}
