import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const verifier = path.resolve(here, "verify-ui-bundle.mjs");

test("the published CK Office UI entry is a self-contained bundle", async () => {
  assert.equal(fs.existsSync(verifier), true);
  await import(`${new URL(`file://${verifier}`).href}?test=${Date.now()}`);
});
