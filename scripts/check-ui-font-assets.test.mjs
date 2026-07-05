import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("source-only font asset check passes without requiring a UI build", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-ui-font-assets.mjs", "--source-only"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ui\/public\/fonts/);
  assert.doesNotMatch(result.stdout, /ui\/dist\/fonts/);
});
