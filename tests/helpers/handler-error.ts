/**
 * @fileoverview Shared helpers for asserting on the error a tool handler throws, and on the
 * error envelope a caller receives for it.
 * @module tests/helpers/handler-error
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { type RunToolContractOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';

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

/**
 * A shed raised by the framework's own pacer — a one-slot line whose slot is held and a
 * caller with no wait left — so a tool test passes through the framework's own
 * `pacer_shed` shape, which the Overpass service restates with the same code and data
 * keys, rather than a hand-copied one.
 */
export async function pacerShed(): Promise<McpError> {
  const pacer = createPacer({ name: 'overpass', maxConcurrent: 1 });
  let release = (): void => {};
  const held = pacer.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const shed = await captureThrown(pacer.run(async () => {}, { maxWaitMs: 0 }));
  release();
  await held;
  pacer.dispose();
  if (!(shed instanceof McpError)) throw new Error('Expected the held pacer to shed.');
  return shed;
}

/** The error envelope a caller receives for a failed tool call. */
export interface WireError {
  readonly code: number;
  readonly data: Record<string, unknown> & {
    reason?: string;
    recovery?: { hint?: string };
  };
  readonly message: string;
  /** The `content[]` text — the Markdown twin of `structuredContent.error`. */
  readonly text: string;
}

type ToolDefinition = Parameters<typeof runToolContract>[0];

/**
 * Run a tool through `runToolContract` and return the error envelope a caller receives.
 *
 * The handler's throw is resolved against the tool's `errors[]` contract as the production
 * handler factory resolves it, so a failure whose `data.reason` names a declared entry comes
 * back with that entry's `recovery` as `data.recovery.hint` and a `Recovery:` line in the
 * text. A handler-level throw carries only what its throw site wrote, which is why hint
 * assertions read this envelope. Fails the test when the call succeeds.
 */
export async function wireError<T extends ToolDefinition>(
  definition: T,
  input: Parameters<typeof runToolContract<T>>[1],
  context?: RunToolContractOptions['context'],
): Promise<WireError> {
  const result = await runToolContract(definition, input, context ? { context } : undefined);
  if (!result.isError) {
    throw new Error(`Expected ${definition.name} to fail, but it returned a result.`);
  }
  const { error } = result.structuredContent as {
    error: { code: number; message: string; data?: WireError['data'] };
  };
  if (!error.data) {
    throw new Error(`${definition.name} failed without error data: ${error.message}`);
  }
  const text = result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  return { code: error.code, message: error.message, data: error.data, text: text.join('\n') };
}
