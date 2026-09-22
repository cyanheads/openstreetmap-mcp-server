/**
 * @fileoverview Nominatim request pacing, cancellation, and retry classification at the
 * `fetch` seam — the real `fetchWithTimeout`, status classification, `withRetry`, and
 * request pacing all stay in the path, so start times and submission counts are the
 * ones the upstream would see.
 * @module tests/services/nominatim/nominatim-retry.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_REQUEST_INTERVAL_MS,
  NominatimService,
} from '@/services/nominatim/nominatim-service.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
    nominatimUserAgent: 'openstreetmap-mcp-server/test',
  }),
}));

/**
 * Stands in for the network. A request carrying an already-aborted signal rejects with
 * that signal's reason before any response, as the real `fetch` does — which is what
 * separates "never sent" from "sent and cancelled" in the cancellation cases.
 */
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

/** The `q` a submitted search asked for, in submission order. */
function submittedQueries(): string[] {
  return mockFetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('q') ?? '');
}

/** Clock readings, relative to the first submission, at which each request was sent. */
function recordStarts(respond: (url: URL) => Response = () => new Response('[]')): number[] {
  const startedAt: number[] = [];
  mockFetch.mockImplementation(async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    startedAt.push(Date.now());
    return respond(new URL(String(input)));
  });
  return startedAt;
}

function relative(times: number[]): number[] {
  return times.map((time) => time - (times[0] ?? 0));
}

describe('NominatimService request pacing at the fetch seam', () => {
  let service: NominatimService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    service = new NominatimService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts N concurrent uncached requests exactly one minimum interval apart', async () => {
    const startedAt = recordStarts();
    const ctx = createMockContext({ tenantId: 'test' });
    const inFlight = Promise.all(
      ['Seattle', 'Portland', 'Tacoma', 'Spokane'].map((q) => service.search({ q, limit: 1 }, ctx)),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    await inFlight;

    expect(relative(startedAt)).toEqual([
      0,
      MIN_REQUEST_INTERVAL_MS,
      2 * MIN_REQUEST_INTERVAL_MS,
      3 * MIN_REQUEST_INTERVAL_MS,
    ]);
    expect(submittedQueries()).toEqual(['Seattle', 'Portland', 'Tacoma', 'Spokane']);
  });

  /**
   * A retry is a new request against the same 1 req/s policy, so it is paced behind every
   * request started since — not only its own previous attempt. The backoff alone (1100ms
   * ± 25% jitter) would put it inside the interval the concurrent caller already took.
   */
  it('paces a retry behind the requests started since its failed attempt', async () => {
    let seattleCalls = 0;
    const startedAt = recordStarts((url) => {
      if (url.searchParams.get('q') !== 'Seattle') return new Response('[]');
      seattleCalls++;
      return seattleCalls === 1 ? new Response('overloaded', { status: 503 }) : new Response('[]');
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const inFlight = Promise.all([
      service.search({ q: 'Seattle', limit: 1 }, ctx),
      service.search({ q: 'Portland', limit: 1 }, ctx),
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    await inFlight;

    expect(submittedQueries()).toEqual(['Seattle', 'Portland', 'Seattle']);
    expect(relative(startedAt)).toEqual([0, MIN_REQUEST_INTERVAL_MS, 2 * MIN_REQUEST_INTERVAL_MS]);
  });

  /**
   * A caller that goes away while waiting for its slot leaves the line instead of holding
   * a start the next caller could use, and never reaches the upstream at all.
   */
  it('drops a caller aborted while queued and gives its slot to the next caller', async () => {
    const startedAt = recordStarts();
    const cancelled = new AbortController();

    const first = service.search({ q: 'Seattle', limit: 1 }, createMockContext({ tenantId: 't' }));
    const aborted = service
      .search(
        { q: 'Portland', limit: 1 },
        createMockContext({ tenantId: 't', signal: cancelled.signal }),
      )
      .catch((e: unknown) => e);
    const third = service.search({ q: 'Tacoma', limit: 1 }, createMockContext({ tenantId: 't' }));

    await vi.advanceTimersByTimeAsync(500);
    cancelled.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, third]);

    const err = await aborted;
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect((err as McpError).data).toMatchObject({ errorSource: 'NominatimSlotAborted' });
    expect(submittedQueries()).toEqual(['Seattle', 'Tacoma']);
    expect(relative(startedAt)).toEqual([0, MIN_REQUEST_INTERVAL_MS]);
  });

  /** Shutdown: nothing still in line is sent, and no dispatch timer outlives the service. */
  it('rejects callers still in line on dispose and leaves no timer armed', async () => {
    recordStarts();
    const ctx = createMockContext({ tenantId: 'test' });
    const first = service.search({ q: 'Seattle', limit: 1 }, ctx);
    const queued = service.search({ q: 'Portland', limit: 1 }, ctx).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    await first;
    service.dispose();
    const err = (await queued) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(submittedQueries()).toEqual(['Seattle']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('NominatimService retry classification at the fetch seam', () => {
  let service: NominatimService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    service = new NominatimService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs a lookup expected to fail, driving pacing and backoff on the fake clock. */
  async function lookupError(): Promise<McpError> {
    const pending = service
      .lookup({ osm_ids: ['N1'] }, createMockContext({ tenantId: 'test' }))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await pending;
    expect(err).toBeInstanceOf(McpError);
    return err as McpError;
  }

  it('re-submits a 503 across the full attempt budget', async () => {
    mockFetch.mockImplementation(async () => new Response('overloaded', { status: 503 }));
    const err = await lookupError();

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(err.message).toContain('failed after 4 attempts');
  });

  it('surfaces a 429 without Retry-After on its first submission', async () => {
    mockFetch.mockImplementation(async () => new Response('slow down', { status: 429 }));
    const err = await lookupError();

    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('honors a 429 Retry-After as a wait, then re-submits', async () => {
    const startedAt = recordStarts(() =>
      startedAt.length === 1
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '3' } })
        : new Response('[]'),
    );
    const pending = service.lookup({ osm_ids: ['N1'] }, createMockContext({ tenantId: 'test' }));
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(relative(startedAt)[1]).toBeGreaterThanOrEqual(3_000);
  });

  it('surfaces a 400 on its first submission', async () => {
    mockFetch.mockImplementation(
      async () =>
        new Response('{"error":{"code":400,"message":"Invalid OSM ID"}}', { status: 400 }),
    );
    const err = await lookupError();

    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * #86: a wrong `OSM_NOMINATIM_BASE_URL` or a blocked client is answered identically on
   * every re-submission, so the retry ladder only spent three more requests against a
   * shared public service before the caller saw the same status.
   */
  it.each([
    [404, JsonRpcErrorCode.NotFound],
    [403, JsonRpcErrorCode.Forbidden],
    [401, JsonRpcErrorCode.Unauthorized],
  ])('surfaces an HTTP %d after one submission (#86)', async (status, code) => {
    mockFetch.mockImplementation(async () => new Response('nope', { status }));
    const err = await lookupError();

    expect(err.code).toBe(code);
    expect(err.data).toMatchObject({ status });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err.message).not.toContain('failed after');
  });

  /** The framework marks a 501 `retryable: false`; the predicate now honors that opt-out. */
  it('surfaces an HTTP 501 after one submission', async () => {
    mockFetch.mockImplementation(async () => new Response('nope', { status: 501 }));
    const err = await lookupError();

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
