import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const checkerUrl = new URL("./check-runner-workflow-traceability.mjs", import.meta.url);

test("loads the eval module from an absolute Windows path", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows drive-letter imports are the regression under test");
    return;
  }

  const packageRoot = await mkdtemp(join(tmpdir(), "paperclip-runner-traceability-"));
  t.after(() => rm(packageRoot, { recursive: true, force: true }));

  const evalDirectory = join(packageRoot, "dist", "eval");
  await mkdir(evalDirectory, { recursive: true });
  await writeFile(join(evalDirectory, "index.js"), "export const marker = 'loaded';\n");

  const { loadWorkflowEvals } = await import(checkerUrl.href);
  const evals = await loadWorkflowEvals(packageRoot);

  assert.equal(evals.marker, "loaded");
});
