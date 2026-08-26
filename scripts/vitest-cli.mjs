import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let cachedVitestCli = null;

// Resolve Vitest's own JS entry point so callers can spawn it with Node.
//
// Spawning `pnpm exec vitest` fails on Windows, where `pnpm` is a .cmd shim
// that Node cannot execute without a shell. A shell is not an acceptable
// workaround here: the general-server invocation passes one --exclude argument
// per serialized suite, which overruns the 8191-character cmd.exe command line,
// and a POSIX shell would expand glob arguments such as **/dist/** before Vitest
// received them. Spawning Node with this path avoids a shell on every platform.
//
// Resolution is lazy because callers such as --dry-run never spawn Vitest, and
// some CI jobs run those paths without the Vitest package installed.
export function resolveVitestCli() {
  cachedVitestCli ??= path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  return cachedVitestCli;
}
