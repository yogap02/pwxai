/**
 * Bounded concurrency pool. Generation and classification both route through
 * this because both are pure network wait. Concurrency is per-phase and
 * deliberately not per-domain (pipeline-pattern.md §4): the manifest threads
 * through domains one at a time and concurrent domains would drop each other's
 * writes. Do not use this to parallelise domains.
 */

import pLimit from 'p-limit';

/** The p-limit limiter type, re-exported for callers. */
export type Pool = ReturnType<typeof pLimit>;

export function createPool(concurrency: number): Pool {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `createPool: concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  return pLimit(concurrency);
}

/**
 * Map with bounded concurrency preserving INPUT order, not arrival order.
 * Block order in generated files is pinned rather than arrival order
 * (pipeline-pattern.md §4, concurrency invariant #1).
 */
export async function mapOrdered<TIn, TOut>(
  pool: Pool,
  inputs: readonly TIn[],
  fn: (input: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut | undefined>(inputs.length);
  await Promise.all(
    inputs.map((input, index) =>
      pool(async () => {
        results[index] = await fn(input, index);
      }),
    ),
  );
  return results.map((r, i) => {
    if (r === undefined) {
      throw new Error(`mapOrdered: task ${i} never resolved — this is a bug`);
    }
    return r;
  });
}
