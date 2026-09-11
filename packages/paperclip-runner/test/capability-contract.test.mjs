import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { validateRows } from "../scripts/generate-capability-contract.mjs";

const phaseDirectory = resolve(import.meta.dirname, "../generated/capability");

async function readRows(file) {
  return JSON.parse(await readFile(resolve(phaseDirectory, file), "utf8")).rows;
}

test("generated Capability inventory has full source coverage", async () => {
  const [capabilities, tools, evals] = await Promise.all([
    readRows("capabilities.yaml"),
    readRows("mcp-tool-map.yaml"),
    readRows("eval-traceability.yaml"),
  ]);

  assert.equal(capabilities.length, 152);
  assert.equal(tools.length, 42);
  assert.equal(evals.length, 106);
  assert.equal(new Set(evals.map((row) => row.group)).size, 16);
  for (const row of [...capabilities, ...tools, ...evals]) {
    assert.match(row.sourceAnchor, /\S/);
    assert.match(row.semanticOperation, /\S/);
    assert.match(row.expectedMockState, /\S/);
  }
});

test("contract validation rejects missing, duplicate, and unclassified entries", () => {
  const row = {
    id: "example:1",
    sourceAnchor: "source.md#L1:example",
    primaryDisposition: "control_plane_owned",
  };

  assert.throws(() => validateRows([{ ...row, sourceAnchor: "" }], "fixture"), /source anchor/);
  assert.throws(() => validateRows([row, { ...row, id: "example:2" }], "fixture"), /duplicate source anchor/);
  assert.throws(() => validateRows([{ ...row, primaryDisposition: "unclassified" }], "fixture"), /valid primary disposition/);
});
