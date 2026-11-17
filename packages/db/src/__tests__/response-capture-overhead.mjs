// Run from the repository root with Node 24. A pinned git source is materialized
// only in memory; no baseline production clone or runtime patch is retained.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, loadavg, cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd(), base = process.argv[2], count = Number(process.argv[3] ?? 1000);
if (!base || !/^[a-f0-9]{40}$/.test(base) || !Number.isInteger(count) || count < 1 || count > 10000)
  throw new Error("Usage: node packages/db/src/__tests__/response-capture-overhead.mjs BASELINE_SHA [queries<=10000]");
const baseline = execFileSync("git", ["show", `${base}:packages/db/src/response-capture.ts`], { encoding: "utf8" });
const directory = await mkdtemp(join(tmpdir(), "capture-overhead-"));
try {
  const bundles = {};
  for (const variant of ["current", "candidate"]) {
    const output = join(directory, variant, "server/dist-runtime/server.mjs");
    await mkdir(join(directory, variant, "server/dist-runtime"), { recursive: true });
    await build({ entryPoints: [resolve(root, "packages/db/src/__tests__/response-capture-bundle-fixture.ts")],
      outfile: output, bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false,
      plugins: variant === "current" ? [{ name: "pinned-baseline", setup(builder) {
        builder.onLoad({ filter: /[/\\]response-capture\.ts$/ }, () => ({ contents: baseline, loader: "ts", resolveDir: resolve(root, "packages/db/src") }));
      } }] : [] });
    bundles[variant] = await import(pathToFileURL(output).href);
  }
  console.log(JSON.stringify({ kind: "host", node: process.version, execPath: process.execPath, base, logicalCpus: cpus().length, loadavg: loadavg(), count,
    boundary: "serial instrumented fake-driver process; real bundled Drizzle/capture; no network, database, output flush or assertions in timing" }));
  for (const variant of ["current", "candidate"]) for (const mode of ["disabled", "unowned", "http.request", "response.presentation"])
    await bundles[variant].measureBundleCapture(mode, Math.min(count, 500));
  for (let round = 0; round < 5; round++) {
    for (const mode of ["disabled", "unowned", "http.request", "response.presentation"]) {
      for (const variant of round % 2 ? ["candidate", "current"] : ["current", "candidate"])
        console.log(JSON.stringify({ kind: "sample", round, variant, ...await bundles[variant].measureBundleCapture(mode, count) }));
    }
  }
  const proof = await bundles.candidate.runBundleProof();
  console.log(JSON.stringify({ kind: "proof", ...proof }));
} finally { await rm(directory, { recursive: true, force: true }); }
