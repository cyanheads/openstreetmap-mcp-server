/**
 * @fileoverview Shared helpers for asserting on the error a tool handler throws.
 * @module tests/helpers/handler-error
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * An `McpError` raised through a tool's typed error contract, narrowed for assertions.
 *
 * `McpError.data` is deliberately an open `Record<string, unknown>` so a service throwing
 * below the handler can carry its own fields; `reason` and `recovery.hint` are the two the
 * contract guarantees, and this states them so a test reads them without per-line casts.
 */
export type ContractError = McpError & {
  readonly data: Record<string, unknown> & {
    reason?: string;
    recovery?: { hint?: string };
  };
};

/**
 * Run a handler call and return whatever it threw, or its resolved value when it did not.
 *
 * A definition's `handler` is typed to return either a value or a promise, so the call is
 * awaited rather than given a `.catch()` — `.catch` does not exist on the union, and a test
 * that reaches for it is asserting against an unsettled promise.
 */
export async function captureThrown(call: unknown): Promise<unknown> {
  try {
    return await call;
  } catch (error) {
    return error;
  }
}
