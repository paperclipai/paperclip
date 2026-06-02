import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Vitest globalSetup — rebuilds workspace dependencies that the server tests
 * type-check against before any test worker spins up.
 *
 * Why this exists:
 *   `server`'s `pnpm typecheck` script already invokes
 *   `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` so a fresh
 *   `dist/` is in place before tsc runs. But `npx vitest run …`,
 *   `pnpm test`, the IDE language server, and other LSP-style harnesses
 *   bypass the pnpm script and consume whatever stale `.d.ts` is already in
 *   `packages/{plugins/sdk,shared}/dist/`. The symptom looks like real type
 *   drift on the SDK contract (`PluginPerformActionActorContext` missing,
 *   stale `PLUGIN_RPC_ERROR_CODES`, etc.) when it's actually just a dist
 *   that predates recent SDK source edits.
 *
 *   Running ensure-plugin-build-deps once in `globalSetup` makes
 *   `vitest run` self-sufficient: the script is a no-op when outputs are
 *   fresh (just `statSync` calls over the source tree) and rebuilds when
 *   they aren't.
 *
 *   The script already handles concurrent invocations via a lock dir under
 *   `node_modules/.cache/`, so this is safe across parallel local runs.
 */
export const setup = (): void => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const script = path.join(repoRoot, "scripts", "ensure-plugin-build-deps.mjs");

  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `ensure-plugin-build-deps exited with status ${result.status ?? "unknown"}; ` +
        `vitest aborted to avoid running tests against a stale SDK/shared dist.`,
    );
  }
};
