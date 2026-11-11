/**
 * @fileoverview Nominatim request pacing, cancellation, and retry classification at the
 * `fetch` seam — the real `fetchWithTimeout`, status classification, `withRetry`, and
 * request pacing all stay in the path, so start times and submission counts are the
 * ones the upstream would see.
 * @module tests/services/nominatim/nominatim-retry.test
 */

import { getEventListeners } from 'node:events';
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

  /**
   * A session reuses the caller's signal across calls, so nothing a request leaves on it may
   * outlive the request. The line waits on each attempt's own signal — the call's budget
   * joined with the caller's cancellation (#121) — rather than on the caller's, so a queued
   * request hangs no listener on the reused signal at all, and leaves none behind.
   */
  it('hangs no waiter abort listener on a reused caller signal', async () => {
    recordStarts();
    const controller = new AbortController();
    const ctx = createMockContext({ tenantId: 'test', signal: controller.signal });
    const inFlight = Promise.all(
      ['Seattle', 'Portland', 'Tacoma'].map((q) => service.search({ q, limit: 1 }, ctx)),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await inFlight;

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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

/**
 * #121: each request ladder had no total deadline, so an instance that accepted the
 * connection and never answered held the call for four 30 s attempts plus backoff, about
 * 128 s — past the 60 s request timeout MCP SDK clients default to, so the caller never saw
 * the server's error. One budget per call now covers the wait in the line, every attempt,
 * and every backoff, and runs out as `upstream_error`.
 */
describe('NominatimService call budget (#121)', () => {
  let service: NominatimService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    service = new NominatimService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  /** Accepts the request and never answers, rejecting with the signal's reason once it aborts. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  /** Starts a lookup and reports when it settles on the fake clock. */
  function track(osmId = 'N1', ctx = createMockContext({ tenantId: 'test' })) {
    const state: { settled: boolean; error?: unknown; value?: unknown } = { settled: false };
    const pending = service.lookup({ osm_ids: [osmId] }, ctx).then(
      (value) => Object.assign(state, { settled: true, value }),
      (error: unknown) => Object.assign(state, { settled: true, error }),
    );
    return { state, pending };
  }

  it('settles a hung instance at the 50 s budget as upstream_error, after two submissions', async () => {
    const starts: number[] = [];
    mockFetch.mockImplementation(async (_input, init) => {
      starts.push(Date.now());
      return hang(init);
    });
    const { state } = track();

    await vi.advanceTimersByTimeAsync(49_999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);

    const err = state.error as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data).toMatchObject({ reason: 'upstream_error' });
    expect(err.message).toBe('Nominatim did not answer within the 50000ms budget for this call.');
    // One full 30 s window, its backoff, and a second window the budget cuts short.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(relative(starts)[1]).toBeGreaterThanOrEqual(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The budget starts before the call joins the line, so a call queued behind 48 others
   * (each start 1,050 ms after the last) is never sent: its turn would come at 50.4 s.
   */
  it('charges the wait in the line to the budget, settling a call that never left it', async () => {
    recordStarts();
    const ahead = Array.from({ length: 48 }, (_, i) => track(`N${i + 1}`));
    const queued = track('N49');

    await vi.advanceTimersByTimeAsync(49_999);
    expect(queued.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(queued.state.settled).toBe(true);
    await Promise.all(ahead.map(({ pending }) => pending));

    expect(ahead.every(({ state }) => state.settled && state.error === undefined)).toBe(true);
    expect((queued.state.error as McpError).data).toMatchObject({ reason: 'upstream_error' });
    expect(mockFetch).toHaveBeenCalledTimes(48);
    const sent = mockFetch.mock.calls.map(([input]) => String(input));
    expect(sent.some((url) => url.includes('osm_ids=N49'))).toBe(false);
  });

  /** A wait the upstream named is still the caller's to honor, so it is not relabelled. */
  it('fails at once on a Retry-After that outlasts what the budget has left', async () => {
    mockFetch.mockImplementation(
      async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    const { state } = track();

    // The first wait fits the budget; at 30 s the second would end past it.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.settled).toBe(true);

    const err = state.error as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ status: 429, retryAfter: '30' });
    expect(err.data).not.toHaveProperty('reason');
    expect(err.message).not.toContain('failed after');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('still answers once the instance answers inside the budget', async () => {
    let calls = 0;
    mockFetch.mockImplementation(async (_input, init) =>
      ++calls === 1 ? hang(init) : new Response('[]'),
    );
    const { state } = track();

    await vi.advanceTimersByTimeAsync(40_000);
    expect(state).toMatchObject({ settled: true, value: [] });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('caller cancellation keeps its own shape', () => {
    it('in flight: RequestCancelled with no reason', async () => {
      mockFetch.mockImplementation(async (_input, init) => hang(init));
      const caller = new AbortController();
      const { state } = track('N1', createMockContext({ tenantId: 't', signal: caller.signal }));

      await vi.advanceTimersByTimeAsync(1_000);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);

      const err = state.error as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(err.data).toMatchObject({ errorSource: 'FetchAborted' });
      expect(err.data).not.toHaveProperty('reason');
    });

    it('in the backoff: the signal’s own reason', async () => {
      mockFetch.mockImplementation(async () => new Response('overloaded', { status: 503 }));
      const caller = new AbortController();
      const { state } = track('N1', createMockContext({ tenantId: 't', signal: caller.signal }));

      // The first attempt fails at once; its backoff is 1,100 ms ± 25%.
      await vi.advanceTimersByTimeAsync(300);
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(state.error).toBe(caller.signal.reason);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('with its own TimeoutError: a reasonless Timeout', async () => {
      mockFetch.mockImplementation(async (_input, init) => hang(init));
      const caller = new AbortController();
      const { state } = track('N1', createMockContext({ tenantId: 't', signal: caller.signal }));

      await vi.advanceTimersByTimeAsync(45_000);
      caller.abort(new DOMException('Caller deadline passed.', 'TimeoutError'));
      await vi.advanceTimersByTimeAsync(0);

      const err = state.error as McpError;
      expect(err.code).toBe(JsonRpcErrorCode.Timeout);
      expect(err.data).toMatchObject({ errorSource: 'FetchSignalTimeout' });
      expect(err.data).not.toHaveProperty('reason');
    });
  });
});
