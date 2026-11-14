#!/usr/bin/env node
// Prove two things about the target image's server directory, in order:
//
// 1. The tsx loader, `server/node_modules/tsx/dist/loader.mjs`, still
//    resolves. Workers that load workspace TypeScript on demand use it (the
//    production `CMD` itself starts the runtime bundle with plain node). That
//    path is a symbolic link into the workspace pnpm store, and the `cloud`
//    stage's Sentry copy writes into the same `server/node_modules`
//    directory, so a copy that removes or shadows the link breaks them.
// 2. The installed `@sentry/node` package resolves, the same way the
//    server's own peer-version gate does
//    (server/src/peer-version-check.ts). Then print its version.
//
// Exit non-zero, with a clear message on standard error, when either check
// fails. Print only the version string on standard output on success.
//
// Mount this file at a path inside the target image's server directory and
// run it there with `node`, so module resolution walks the same
// `node_modules` tree the running server itself resolves from:
//
//   docker run --rm \
//     -v "$PWD/scripts/assert-cloud-image-sentry.mjs:/app/server/.ci-sentry-probe.mjs:ro" \
//     --entrypoint node <image> /app/server/.ci-sentry-probe.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));

// Follow the link the same way Node's own module loader does, so a broken
// or missing link fails this probe before it fails a live container.
const tsxLoaderPath = join(serverDir, "node_modules", "tsx", "dist", "loader.mjs");
try {
  realpathSync(tsxLoaderPath);
} catch (error) {
  console.error(
    `could not resolve ${tsxLoaderPath}: workers that load workspace TypeScript need this loader (${error.message})`,
  );
  process.exit(1);
}

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
