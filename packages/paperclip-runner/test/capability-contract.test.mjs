import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { decodeInventory } from "../scripts/lib/capability-inventory.mjs";
import { validateRows } from "../scripts/generate-capability-contract.mjs";

const run = promisify(execFile);
const scriptPath = resolve(import.meta.dirname, "../scripts/generate-capability-contract.mjs");
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

  assert.equal(capabilities.length, 158);
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

test("conversational answer guidance has the same agent-operation classification in both inventories", async () => {
  const generated = (await readRows("capabilities.yaml")).filter(row => row.heading === "Conversational confirmation answers");
  const spec = decodeInventory(await readFile(resolve(import.meta.dirname, "../spec/capability/capabilities.yaml"), "utf8")).rows
    .filter(row => row.title === "Conversational confirmation answers");
  assert.equal(generated.length, 2);
  assert.equal(spec.length, 2);
  for (const row of [...generated, ...spec]) assert.equal(row.primaryDisposition, "always_agent_tool");
  for (const row of generated) assert.equal(row.semanticOperation, "call_api");
});

test("entry-point guard runs the check when the script is invoked directly", async () => {
  // Regression: on a Windows checkout the old guard compared a raw path with a
  // file URL, so it was false and the script exited without running the drift
  // check. A clean --check produces no output, so silence alone cannot tell a
  // passing check from a skipped one. Force drift in a generated file and assert
  // the check actually runs and reports it: if the guard regressed to false, the
  // script would exit 0 silently and this assertion would fail.
  const target = resolve(phaseDirectory, "capabilities.yaml");
  const original = await readFile(target, "utf8");
  try {
    await writeFile(target, `${original}\n{"drift": true}\n`);
    await assert.rejects(
      run(process.execPath, [scriptPath, "--check"]),
      (err) => {
        assert.match(`${err.stderr}${err.stdout}`, /drift/i);
        return true;
      },
    );
  } finally {
    await writeFile(target, original);
  }
});

test("module imports without a script path (node --eval / stdin)", async () => {
  // Regression: with no process.argv[1] the old guard called pathToFileURL on
  // undefined and threw before the caller could use the exports. Importing the
  // module from a context with no script argument must succeed and expose the
  // exported helpers.
  const href = pathToFileURL(scriptPath).href;
  const evalScript =
    `import(${JSON.stringify(href)}).then((m) => { ` +
    `m.validateRows([{ id: 'x:1', sourceAnchor: 'a.md#L1:x', primaryDisposition: 'control_plane_owned' }], 'fixture'); ` +
    `process.stdout.write('imported'); });`;
  const { stdout } = await run(process.execPath, ["--eval", evalScript]);
  assert.equal(stdout, "imported");
});
