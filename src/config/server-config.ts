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
    /**
     * A `|N` here would otherwise pass as part of the path and be POSTed to. The pin
     * is sized by `OSM_OVERPASS_MAX_CONCURRENCY`, so the message points there.
     */
    .refine(
      (url) => !url.includes('|'),
      'OSM_OVERPASS_BASE_URL takes no |N suffix — OSM_OVERPASS_MAX_CONCURRENCY sizes the pinned endpoint. Write a | inside the URL as %7C.',
    )
    .optional()
    .describe(
      'Overpass API endpoint URL. When set, pins every query to this one endpoint and disables mirror failover — the behavior a private-instance deployment wants. OSM_OVERPASS_MAX_CONCURRENCY sizes it; a |N suffix is rejected. Leave unset to use the ordered list in OSM_OVERPASS_ENDPOINTS.',
    ),
  overpassEndpoints: z
    .string()
    .default(DEFAULT_OVERPASS_ENDPOINT)
    /**
     * Split at the last `|`, so a URL that needs a literal pipe writes it as `%7C`
     * and can still carry a suffix. Whatever follows the pipe is handed to the
     * schema below as written: a typo'd suffix fails startup instead of reaching
     * the endpoint as part of its path.
     */
    .transform((raw) =>
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry): { url: string; maxConcurrent?: string | undefined } => {
          const bar = entry.lastIndexOf('|');
          return bar === -1
            ? { url: entry }
            : { url: entry.slice(0, bar), maxConcurrent: entry.slice(bar + 1) };
        }),
    )
    /**
     * The messages name the variable itself: `parseEnvConfig` keys its env-var
     * lookup on the issue path, and a per-entry failure reports at
     * `overpassEndpoints.<index>.<field>` — a path with no mapping, so the prefix
     * would otherwise fall back to the schema path.
     */
    .pipe(
      z
        .array(
          z.object({
            url: z
              .string()
              .url(
                'Each OSM_OVERPASS_ENDPOINTS entry must be a full URL, e.g. https://overpass-api.de/api/interpreter',
              )
              .refine(
                (url) => !url.includes('|'),
                'An OSM_OVERPASS_ENDPOINTS entry holds a | before its |N suffix — write a | inside a URL as %7C.',
              ),
            maxConcurrent: z
              .string()
              .regex(
                /^[1-9]\d*$/,
                'The |N suffix on an OSM_OVERPASS_ENDPOINTS entry must be a positive integer, e.g. https://mirror.example/api/interpreter|4 — write a | inside a URL as %7C.',
              )
              .transform(Number)
              .optional(),
          }),
        )
        .min(1),
    )
    /**
     * A repeated URL keeps its first entry, suffix and all. A second entry would be a
     * second slot line and fault record for one host, so a call walking the list would
     * re-ask a host that had just refused or shed it, with no backoff between.
     */
    .transform((entries) =>
      entries.filter(({ url }, index) => entries.findIndex((other) => other.url === url) === index),
    )
    .describe(
      'Comma-separated ordered list of Overpass endpoints. A failure advances to the next entry within the same tool call — at once when the call has not tried that entry yet; the list is tried in order, so the first entry stays the preferred endpoint. Each entry has its own concurrent slots: N for an entry written url|N, else OSM_OVERPASS_MAX_CONCURRENCY. A later entry adds capacity only when sized with |N, and new calls then take the first entry with a free slot; an unsuffixed later entry serves only as failover, so listing a mirror never adds queries in flight. A URL listed twice keeps its first entry. Write a | inside a URL as %7C. An endpoint that sheds load with a 5xx other than 501, a 408, or a 425 can be tried again, while one that refuses the call on its own account — a throttle, an HTTP refusal such as 401/403/404/501 or a redirect (never followed), a refused or unresolvable connection, an instance fault, or no answer inside its attempt window — is skipped for the rest of that call, so the call never returns to a host already written off and ends once every entry has been. A host that could not be connected to, or gave no answer inside a full attempt window, is also skipped by later calls while it cools down: 30 seconds, doubling with each repeat up to 10 minutes, then one call tries it again; any HTTP response from it ends the cooldown. When every entry is cooling, a call still tries the one cooling longest. Endpoints are reported by origin only, and where the error text of an endpoint quotes the whole path, query string, or userinfo of an entry verbatim, each is repeated as …, so an API key in the path or query reaches a response or a log only if an endpoint echoes it in another form, such as the key alone or re-encoded. A single entry means no failover. Ignored when OSM_OVERPASS_BASE_URL is set.',
    ),
  overpassMaxConcurrency: z.coerce
    .number()
    .int()
    .min(1)
    .default(2)
    .describe(
      'Concurrent Overpass queries per endpoint: OSM_OVERPASS_BASE_URL, and every OSM_OVERPASS_ENDPOINTS entry not sized with |N. With no |N entry it is also the most queries in flight across all endpoints. A query waits at most 30 seconds in total for a slot, then fails with pacer_shed and a retryAfter. The public endpoint advertises its budget at /api/status and answers HTTP 429 beyond it; raise only for a mirror or private instance with a larger budget.',
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
