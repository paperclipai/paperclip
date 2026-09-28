import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

  assert.equal(capabilities.length, 156);
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

test("standalone capability check reports missing input from a path with spaces and URL characters", async (t) => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "paperclip-capability-check-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const scriptsDir = resolve(fixtureRoot, "package with spaces # percent %", "scripts");
  await mkdir(scriptsDir, { recursive: true });
  const scriptPath = resolve(scriptsDir, "generate-capability-contract.mjs");
  await copyFile(resolve(import.meta.dirname, "../scripts/generate-capability-contract.mjs"), scriptPath);

  // There is deliberately no source contract. The CLI must run its check and
  // report that error, rather than silently return success without calling main.
  const result = spawnSync(process.execPath, [scriptPath, "--check"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.match(result.stderr, /source-contract\.json/);
});
