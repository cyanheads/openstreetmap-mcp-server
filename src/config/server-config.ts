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

/**
 * FOSSGIS-operated main Overpass instance — the first endpoint tried unless
 * `OSM_OVERPASS_ENDPOINTS` replaces the list or `OSM_OVERPASS_BASE_URL` pins one.
 */
const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

const ServerConfigSchema = z.object({
  nominatimBaseUrl: z
    .string()
    .url()
    .default('https://nominatim.openstreetmap.org')
    .describe('Nominatim API base URL. Override to use a private or mirror instance.'),
  /**
   * Left without a default so "operator pinned an endpoint" stays distinguishable
   * from "nobody set anything" — a default would make the two identical and there
   * would be no way to tell that failover should be skipped.
   */
  overpassBaseUrl: z
    .string()
    .url()
    .optional()
    .describe(
      'Overpass API endpoint URL. When set, pins every query to this one endpoint and disables mirror failover — the behavior a private-instance deployment wants. Leave unset to use the ordered list in OSM_OVERPASS_ENDPOINTS.',
    ),
  overpassEndpoints: z
    .string()
    .default(DEFAULT_OVERPASS_ENDPOINT)
    .transform((raw) =>
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    /**
     * The message names the variable itself: `parseEnvConfig` keys its env-var
     * lookup on the issue path, and a per-entry failure reports at
     * `overpassEndpoints.<index>` — a path with no mapping, so the prefix would
     * otherwise fall back to the schema path.
     */
    .pipe(
      z
        .array(
          z
            .string()
            .url(
              'Each OSM_OVERPASS_ENDPOINTS entry must be a full URL, e.g. https://overpass-api.de/api/interpreter',
            ),
        )
        .min(1),
    )
    .describe(
      'Comma-separated ordered list of Overpass endpoints. A transient failure (5xx, HTML throttle page, connection timeout) advances to the next entry within the same tool call; the list is tried in order, so the first entry stays the preferred endpoint. A single entry means no failover. Ignored when OSM_OVERPASS_BASE_URL is set.',
    ),
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
    overpassEndpoints: 'OSM_OVERPASS_ENDPOINTS',
    overpassMaxConcurrency: 'OSM_OVERPASS_MAX_CONCURRENCY',
    nominatimUserAgent: 'OSM_USER_AGENT',
  });
  return _config;
}
