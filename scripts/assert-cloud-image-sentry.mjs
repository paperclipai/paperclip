#!/usr/bin/env node
// Resolve the installed `@sentry/node` package the same way the server's own
// peer-version gate does (server/src/peer-version-check.ts), then print its
// version. Exits non-zero when the package cannot be resolved.
//
// Mount this file at a path inside the target image's server directory and
// run it there with `node`, so module resolution walks the same
// `node_modules` tree the running server itself resolves from:
//
//   docker run --rm \
//     -v "$PWD/scripts/assert-cloud-image-sentry.mjs:/app/server/.ci-sentry-probe.mjs:ro" \
//     --entrypoint node <image> /app/server/.ci-sentry-probe.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Proves the ECMAScript import path resolves. `require.resolve` below
// checks the CommonJS path; the server needs both to succeed.
await import("@sentry/node");

const require = createRequire(import.meta.url);
let dir = dirname(require.resolve("@sentry/node"));
for (;;) {
  const candidate = join(dir, "package.json");
  if (existsSync(candidate)) {
    const parsed = JSON.parse(readFileSync(candidate, "utf8"));
    if (parsed.name === "@sentry/node") {
      process.stdout.write(parsed.version);
      process.exit(0);
    }
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
console.error("could not resolve the installed @sentry/node package");
process.exit(1);
