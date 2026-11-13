import { beforeAll } from "vitest";

/**
 * Loads a mocked module graph one time for the enclosing `describe` block,
 * not one time for each test.
 *
 * A per-test `vi.resetModules()` plus a per-test `vi.importActual` (or a
 * dynamic `import()`) forces Node to transform and evaluate the module
 * graph again on every test. This work is synchronous and CPU-bound. Under
 * CPU load, one re-import can take seconds instead of milliseconds and
 * stall a test past its timeout.
 *
 * A route module graph does not need a fresh import for test isolation.
 * `vi.hoisted` mocks keep a stable identity across tests. Each test can
 * still re-arm mock behavior in its own `beforeEach`. Register the module
 * mocks one time. Import the graph one time in `beforeAll`. Reuse the
 * result for every test in the block.
 *
 * Read `.value` only inside a test body. It throws before `beforeAll` runs.
 */
export function hoistModuleGraph<T>(
  registerMocks: () => void,
  loadGraph: () => Promise<T>,
): { readonly value: T } {
  let graph: T | undefined;

  beforeAll(async () => {
    registerMocks();
    graph = await loadGraph();
  });

  return {
    get value(): T {
      if (graph === undefined) {
        throw new Error("module graph is not loaded yet — read .value inside a test");
      }
      return graph;
    },
  };
}
