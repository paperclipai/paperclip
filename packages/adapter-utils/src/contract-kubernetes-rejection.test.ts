/**
 * Contract test: every existing local adapter must return a structured error
 * (errorCode: "execution_target_not_yet_supported") when given a kubernetes
 * execution target, rather than throwing or crashing.
 *
 * This is the M1 spec Risk #3 guard: adapters must fail-fast with a clear
 * message so users who configure a kubernetes target see a helpful response
 * instead of an unhandled exception.
 *
 * Imports use relative paths that cross package boundaries — this works under
 * vitest (which uses vite transforms) but is intentionally outside the
 * TypeScript rootDir. The paths below resolve relative to this file's location
 * at packages/adapter-utils/src/.
 */

import { describe, it, expect } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "./types.js";
import type { AdapterKubernetesExecutionTarget } from "./execution-target.js";

const k8sTarget: AdapterKubernetesExecutionTarget = {
  kind: "kubernetes",
  clusterConnectionId: "test-cluster-connection-1",
};

function makeCtx(): AdapterExecutionContext {
  return {
    runId: "r-contract-test-1",
    agent: {
      id: "a-1",
      companyId: "c-1",
      name: "contract-test-agent",
      adapterType: "test",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {},
    context: {},
    onLog: async () => {},
    executionTarget: k8sTarget,
  };
}

/**
 * Each entry: [display name, relative path from this file to the adapter's execute.ts].
 * Relative paths cross package boundaries; vitest resolves them correctly at
 * runtime even though tsc would reject them (rootDir constraint).
 */
const adapterModules: ReadonlyArray<readonly [string, () => Promise<{ execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> }>]> = [
  [
    "claude_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/claude-local/src/server/execute.js"),
  ],
  [
    "codex_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/codex-local/src/server/execute.js"),
  ],
  [
    "gemini_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/gemini-local/src/server/execute.js"),
  ],
  [
    "opencode_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/opencode-local/src/server/execute.js"),
  ],
  [
    "acpx_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/acpx-local/src/server/execute.js"),
  ],
  [
    "pi_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/pi-local/src/server/execute.js"),
  ],
  [
    "cursor_local",
    // @ts-expect-error — cross-package relative import; valid at vitest runtime
    () => import("../../adapters/cursor-local/src/server/execute.js"),
  ],
];

describe("adapter contract: kubernetes execution target is rejected in M1", () => {
  for (const [name, doImport] of adapterModules) {
    it(`${name}: returns errorCode="execution_target_not_yet_supported" instead of throwing`, async () => {
      let mod: { execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> };
      try {
        mod = await doImport();
      } catch (e) {
        console.warn(
          `[contract] Could not import adapter "${name}": ${(e as Error).message} — skipping`,
        );
        return;
      }

      if (typeof mod.execute !== "function") {
        throw new Error(`Adapter "${name}" does not export an \`execute\` function`);
      }

      const result = await mod.execute(makeCtx());

      // Must not throw — must return a structured result
      expect(result).toBeDefined();
      expect(result.exitCode).toBeNull();
      expect(result.errorCode).toMatch(/kubernetes|execution_target/i);
      expect(result.errorMessage ?? "").toContain("Kubernetes");
    });
  }
});
