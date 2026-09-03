import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const fixedFastUriVersion = "3.1.6";
const repoRoot = new URL("../../../", import.meta.url);

test("fast-uri SSRF override is active and synchronized", async () => {
  const [packageJsonSource, workspaceSource] = await Promise.all([
    readFile(new URL("package.json", repoRoot), "utf8"),
    readFile(new URL("pnpm-workspace.yaml", repoRoot), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource);

  assert.equal(packageJson.pnpm?.overrides?.["fast-uri"], fixedFastUriVersion);
  assert.match(
    workspaceSource,
    new RegExp(`^overrides:\\n(?:  .+\\n)*  fast-uri: ${fixedFastUriVersion}$`, "m"),
  );
});
