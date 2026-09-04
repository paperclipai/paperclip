import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

test("Docker context retains every runner-local traceability test", async () => {
  const runnerRoot = resolve(repoRoot, "packages/paperclip-runner");
  const manifest = JSON.parse(
    await readFile(resolve(runnerRoot, "spec/evals/stress-workflow-traceability.json"), "utf8"),
  );
  const dockerignore = await readFile(resolve(repoRoot, ".dockerignore"), "utf8");
  const retainedPaths = new Set(
    dockerignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!") && !line.endsWith("/**"))
      .map((line) => line.slice(1)),
  );

  const runnerLocalTests = new Set(
    manifest.findings
      .flatMap((finding) => finding.regressionTests)
      .filter((path) => !path.startsWith("../../"))
      .map((path) => `packages/paperclip-runner/${path}`),
  );
  const missing = [...runnerLocalTests].filter((path) => !retainedPaths.has(path));

  assert.deepEqual(missing, []);
});

test("Docker context probe walks the traceability manifest", async () => {
  const probe = await readFile(resolve(repoRoot, ".github/docker-context-checks.Dockerfile"), "utf8");

  assert.match(probe, /stress-workflow-traceability\.json/u);
  assert.match(probe, /finding\.regressionTests/u);
});
