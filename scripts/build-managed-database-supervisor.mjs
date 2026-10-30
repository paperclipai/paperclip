#!/usr/bin/env node
// Builds the managed embedded PostgreSQL supervisor as a self-contained tree:
//
//   <out>/main.mjs      server/src/managed-database/main.ts and its imports
//   <out>/migrations/   packages/db/src/migrations (read relative to main.mjs)
//   <out>/engine/       the bundled PostgreSQL engine (bin, lib, share)
//
// The supervisor starts as root, and the `node` app user owns /app, so the
// image must not run it from /app: a compromised app could replace the code
// and gain root on the next start. The Dockerfile copies this tree to a
// root-owned directory and adds release.json, the pinned release identity.
//
// Usage: node scripts/build-managed-database-supervisor.mjs <out-dir>
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv[2];
if (!outArg) {
  console.error("usage: build-managed-database-supervisor.mjs <out-dir>");
  process.exit(2);
}
const outDir = path.resolve(outArg);

if (process.platform !== "linux") {
  console.error(`the managed database supervisor bundles a Linux engine; this is ${process.platform}`);
  process.exit(1);
}
// Same lookup as packages/db/src/embedded-postgres-native.ts.
const serverRequire = createRequire(path.join(repoRoot, "server", "package.json"));
const embeddedPostgresRoot = path.dirname(path.dirname(serverRequire.resolve("embedded-postgres")));
const engineSource = path.resolve(embeddedPostgresRoot, "..", "@embedded-postgres", `linux-${process.arch}`, "native");
if (!existsSync(path.join(engineSource, "bin", "postgres"))) {
  console.error(`no bundled PostgreSQL engine at ${engineSource}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  stdin: {
    contents: `import { runCli } from ${JSON.stringify(path.join(repoRoot, "server", "src", "managed-database", "main.ts"))};\nrunCli();\n`,
    resolveDir: repoRoot,
    loader: "ts",
  },
  outfile: path.join(outDir, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "warning",
  // Only a test helper imports these, dynamically; the bundle locates the
  // engine through <out>/engine instead.
  external: ["embedded-postgres", "@embedded-postgres/*"],
  // Bundled CommonJS dependencies call require().
  banner: { js: 'import { createRequire as __managedDatabaseCreateRequire } from "node:module"; const require = __managedDatabaseCreateRequire(import.meta.url);' },
});

cpSync(path.join(repoRoot, "packages", "db", "src", "migrations"), path.join(outDir, "migrations"), { recursive: true });
cpSync(engineSource, path.join(outDir, "engine"), { recursive: true, verbatimSymlinks: true });

console.log(`managed database supervisor bundle written to ${outDir}`);
