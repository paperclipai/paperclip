import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const acpxPatch = await readFile(new URL("../patches/acpx@0.12.0.patch", import.meta.url), "utf8");

test("repo registers the acpx dependency patch", () => {
  assert.equal(
    rootPackage.pnpm?.patchedDependencies?.["acpx@0.12.0"],
    "patches/acpx@0.12.0.patch",
  );
});

test("acpx patch preserves uppercase env keys inside persisted session_options.env", () => {
  assert.match(acpxPatch, /acpx\.session_options\.env/);
  assert.match(acpxPatch, /MAP_OBJECT_PATHS/);
});
