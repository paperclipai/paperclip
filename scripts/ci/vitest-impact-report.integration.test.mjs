import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { measureVitestImpact } from "./vitest-impact-report.mjs";

test("real Vitest graph follows aliases/transitive imports but misses filesystem contracts", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "vitest-impact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "unit"));
  const write = (file, text) => writeFileSync(path.join(root, file), text);
  write("vitest.config.mjs", 'export default { test: { projects: ["unit"] } };');
  write("unit/vitest.config.mjs", `export default {
    resolve: { alias: { "@leaf": ${JSON.stringify(path.join(root, "unit/leaf.mjs"))} } },
    test: { name: "fixture", include: ["**/*.test.mjs"] }
  };`);
  write("unit/leaf.mjs", "export const value = 42;");
  write("unit/bridge.mjs", 'export { value } from "@leaf";');
  // The graph must be collected without executing the test modules.
  write("unit/related.test.mjs", 'import { value } from "./bridge.mjs"; throw new Error("must not execute");');
  write("unit/dynamic.test.mjs", 'const load = () => import("./leaf.mjs"); throw new Error("must not execute");');
  write("unit/independent.test.mjs", 'throw new Error("must not execute");');
  write("unit/reader.test.mjs", 'import { readFileSync } from "node:fs"; const body = readFileSync(new URL("./leaf.mjs", import.meta.url), "utf8");');

  const report = await measureVitestImpact({ root, projects: ["fixture"], changedFiles: ["unit/leaf.mjs"] });
  assert.equal(report.mode, "report-only");
  assert.equal(report.projects[0].totalFiles, 4);
  assert.deepEqual(report.projects[0].selectedTests, ["unit/dynamic.test.mjs", "unit/related.test.mjs"]);
  assert.deepEqual(report.projects[0].omittedTests, ["unit/independent.test.mjs", "unit/reader.test.mjs"]);
  assert.ok(report.limitations.some((message) => message.includes("filesystem")));

  const direct = await measureVitestImpact({ root, projects: ["fixture"], changedFiles: ["unit/independent.test.mjs"] });
  assert.deepEqual(direct.projects[0].selectedTests, ["unit/independent.test.mjs"]);
  const unmapped = await measureVitestImpact({ root, projects: ["fixture"], changedFiles: ["unmapped.md"] });
  assert.equal(unmapped.projects[0].selectedFiles, 0);
  assert.equal(unmapped.mode, "report-only", "an empty graph is not permission to skip CI");
});
