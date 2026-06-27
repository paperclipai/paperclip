import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const rootPackageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const serverPackageJson = JSON.parse(
  await readFile(new URL("../server/package.json", import.meta.url), "utf8"),
);

test("production audit overrides keep high-risk dependency paths on patched ranges", () => {
  assert.equal(
    rootPackageJson.pnpm.overrides["@connectrpc/connect-node>undici"],
    ">=6.27.0 <7",
  );
  assert.equal(rootPackageJson.pnpm.overrides["jsdom>undici"], ">=7.28.0 <8");
  assert.equal(rootPackageJson.pnpm.overrides.multer, ">=2.2.0 <3");
  assert.equal(serverPackageJson.dependencies.multer, "^2.2.0");
});
