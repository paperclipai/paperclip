import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFixtureState, executeFixtureTool, listTools } from "./catalog.mjs";

const kvSet = (tools) => tools.find((tool) => tool.name === "kv.set");

test("each schema flip changes the input schema and preserves the first flip", async () => {
  const state = createFixtureState();
  const baseline = kvSet(listTools());
  const changed = kvSet(listTools({ schemaVariant: "changed" }));
  assert.equal(changed.schemaVersion, 2);
  assert.deepEqual(changed.inputSchema, {
    ...baseline.inputSchema,
    properties: { ...baseline.inputSchema.properties, expiresAt: { type: "string" } },
    required: [...baseline.inputSchema.required, "expiresAt"],
  });

  let previous = baseline.inputSchema;
  for (let i = 0; i < 3; i++) {
    const result = await executeFixtureTool("fixture.schemaFlip", { toolName: "kv.set" }, state);
    assert.deepEqual(result, { ok: true, result: { schemaVariant: "changed", toolName: "kv.set" } });
    const current = kvSet(listTools(state));
    if (i === 0) assert.deepEqual(current, changed);
    assert.notDeepEqual(current.inputSchema, previous);
    previous = current.inputSchema;
  }
});

test("HTTP discovery changes after every flip from baseline and already-changed state", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./servers/http-fixture.mjs", import.meta.url))], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exit = once(child, "exit");
  try {
    const lines = createInterface({ input: child.stdout });
    const [line] = await once(lines, "line");
    lines.close();
    const { port } = JSON.parse(line);
    const base = `http://127.0.0.1:${port}`;
    const rpc = async (method, params = {}) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.error, undefined);
      return body.result;
    };
    const discover = async () => {
      const tool = kvSet((await rpc("tools/list")).tools);
      const catalog = await (await fetch(`${base}/catalog`)).json();
      assert.deepEqual(kvSet(catalog.tools), tool);
      return tool.inputSchema;
    };

    let previous = await discover();
    const schemas = new Set([JSON.stringify(previous)]);
    for (let i = 0; i < 6; i++) {
      const result = await rpc("tools/call", { name: "fixture.schemaFlip", arguments: { toolName: "kv.set" } });
      assert.equal(result.structuredContent.schemaVariant, "changed");
      const current = await discover();
      assert.notDeepEqual(current, previous, `flip ${i + 1} must change the advertised input schema`);
      assert.equal(schemas.has(JSON.stringify(current)), false, `flip ${i + 1} must produce a new input schema`);
      schemas.add(JSON.stringify(current));
      previous = current;
    }
  } finally {
    child.kill();
    await exit;
  }
});
