import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createKvDemoHttpServer, type KvDemoHttpServer } from "./http.js";
import type { KvStateSnapshot } from "./store.js";

const servers: KvDemoHttpServer[] = [];

async function startServer(token?: string) {
  const instance = createKvDemoHttpServer({ token });
  const port = await instance.listen(0, "127.0.0.1");
  servers.push(instance);
  return { instance, base: `http://127.0.0.1:${port}` };
}

async function mcpClient(base: string, headers?: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  while (servers.length) {
    const instance = servers.pop();
    if (instance) await instance.close();
  }
});

describe("kv demo HTTP server", () => {
  it("reflects an MCP tool write in GET /api/state (shared process state)", async () => {
    const { base } = await startServer();
    const client = await mcpClient(base);

    await client.callTool({ name: "kv_set", arguments: { key: "color", value: "blue" } });

    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as KvStateSnapshot;
    expect(state.count).toBe(1);
    expect(state.entries).toEqual([
      expect.objectContaining({ key: "color", value: "blue" }),
    ]);

    await client.close();
  });

  it("serves an HTML values table at GET / that includes written keys", async () => {
    const { base } = await startServer();
    const client = await mcpClient(base);
    await client.callTool({ name: "kv_set", arguments: { key: "fruit", value: "mango" } });
    await client.close();

    const res = await fetch(`${base}/`);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("fruit");
    expect(html).toContain("mango");
  });

  it("requires KV_DEMO_TOKEN on data routes without exposing it in URLs", async () => {
    const token = "s3cret-demo-token";
    const { base } = await startServer(token);

    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/api/state?token=${token}`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(200);

    const page = await (await fetch(`${base}/`)).text();
    expect(page).not.toContain(token);
    expect(page).toContain("#token=YOUR_TOKEN");

    const client = await mcpClient(base, { authorization: `Bearer ${token}` });
    await client.callTool({ name: "kv_set", arguments: { key: "k", value: "v" } });
    const stateResponse = await fetch(`${base}/api/state`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = (await stateResponse.json()) as KvStateSnapshot;
    expect(state.count).toBe(1);
    await client.close();
  });

  it("streams progress for slow_with_progress on the call's response, before the result", async () => {
    const { base } = await startServer();
    const client = await mcpClient(base);
    const updates: Array<{ progress: number; total?: number; message?: string }> = [];
    const result = await client.callTool(
      { name: "slow_with_progress", arguments: { steps: 3, stepMs: 5 } },
      undefined,
      { onprogress: (update) => { updates.push(update); } },
    );
    expect(updates).toEqual([
      { progress: 1, total: 3, message: "Finished step 1 of 3" },
      { progress: 2, total: 3, message: "Finished step 2 of 3" },
      { progress: 3, total: 3, message: "Finished step 3 of 3" },
    ]);
    expect(JSON.stringify(result.content)).toContain("completed");
    const indeterminate: Array<{ total?: number }> = [];
    await client.callTool({ name: "slow_with_progress", arguments: { steps: 1, stepMs: 0, withTotal: false } }, undefined,
      { onprogress: (update) => { indeterminate.push(update); } });
    expect(indeterminate[0]?.total).toBeUndefined();
    await client.close();
  });
});
