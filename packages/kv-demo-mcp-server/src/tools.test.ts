import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createKvDemoMcpServer } from "./index.js";

function firstJson(result: CallToolResult): unknown {
  const block = result.content.find((entry) => entry.type === "text");
  const text = block?.type === "text" ? block.text : "";
  return JSON.parse(text);
}

async function connectedClient() {
  const { server, store } = createKvDemoMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, store };
}

describe("kv demo MCP tools", () => {
  it("exposes exactly kv_set, kv_get, kv_list, kv_delete", async () => {
    const { client } = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["kv_delete", "kv_get", "kv_list", "kv_set"]);
  });

  it("reflects kv_set writes in the shared store", async () => {
    const { client, store } = await connectedClient();
    const result = (await client.callTool({
      name: "kv_set",
      arguments: { key: "greeting", value: "hello" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(firstJson(result)).toMatchObject({ ok: true, key: "greeting", value: "hello" });
    expect(store.get("greeting")?.value).toBe("hello");
  });

  it("gets, lists, and deletes through the tools", async () => {
    const { client } = await connectedClient();
    await client.callTool({ name: "kv_set", arguments: { key: "a", value: "1" } });
    await client.callTool({ name: "kv_set", arguments: { key: "b", value: "2" } });

    const got = firstJson((await client.callTool({ name: "kv_get", arguments: { key: "a" } })) as CallToolResult);
    expect(got).toMatchObject({ found: true, key: "a", value: "1" });

    const missing = firstJson((await client.callTool({ name: "kv_get", arguments: { key: "z" } })) as CallToolResult);
    expect(missing).toMatchObject({ found: false, key: "z" });

    const listed = firstJson((await client.callTool({ name: "kv_list", arguments: {} })) as CallToolResult) as {
      count: number;
      entries: { key: string }[];
    };
    expect(listed.count).toBe(2);
    expect(listed.entries.map((e) => e.key)).toEqual(["a", "b"]);

    const deleted = firstJson((await client.callTool({ name: "kv_delete", arguments: { key: "a" } })) as CallToolResult);
    expect(deleted).toMatchObject({ ok: true, deleted: true, key: "a" });
  });

  it("returns a tool error for an empty key", async () => {
    const { client } = await connectedClient();
    const result = (await client.callTool({ name: "kv_set", arguments: { key: "", value: "x" } })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
