import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/refresh-lockfile.yml", import.meta.url), "utf8");
const nodeStep = workflow.split("      - name: Setup Node.js\n")[1]?.split("      - name:")[0];
assert.ok(nodeStep, "the refresh workflow must set up Node");
const input = (name) => nodeStep.match(new RegExp(`^          ${name}: (.+)$`, "m"))?.[1].trim();

// setup-node's explicit cache input enables a store cache independently of its
// automatic npm detection. Disabling only automatic detection is insufficient.
function cacheProvider(explicitCache, automaticCache, packageManager) {
  if (explicitCache) return explicitCache;
  if (automaticCache !== "false" && packageManager.startsWith("npm@")) return "npm";
  return undefined;
}

for (const packageManager of ["pnpm@9.15.4", "npm@11.0.0"]) {
  test(`resolution-only refresh cannot write a package-store cache (${packageManager})`, () => {
    assert.match(workflow, /run: pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile/);
    assert.equal(
      cacheProvider(input("cache"), input("package-manager-cache"), packageManager),
      undefined,
      "a metadata-only job must not claim the shared cache key with an empty store",
    );
    // This is the original failure mode, even with automatic caching disabled.
    assert.equal(cacheProvider("pnpm", "false", packageManager), "pnpm");
  });
}
