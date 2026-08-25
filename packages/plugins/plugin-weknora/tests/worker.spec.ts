import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest, { ROUTE_KEYS, TOOL_NAMES } from "../src/manifest.js";
import plugin from "../src/worker.js";
import * as fixtures from "./fixtures/weknora-responses.js";

const config = { baseUrl: "https://weknora.example", apiKeyRef: { type: "secret_ref", secretId: "secret-1" } };

function routeInput(routeKey: string, overrides: Record<string, unknown> = {}) {
  return {
    routeKey, method: "GET", path: "/", params: {}, query: {}, body: null,
    actor: { actorType: "user" as const, actorId: "board-1", userId: "board-1", agentId: null },
    companyId: "company-1", headers: {}, ...overrides,
  };
}

function setupHarness(writeEnabled = false, failWikiLint = false, configOverrides: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { ...config, ...configOverrides, enableWriteActions: writeEnabled } });
  harness.ctx.secrets.resolve = async () => "fixture-api-key";
  harness.ctx.http.fetch = async (url, init) => {
    if (url.endsWith("/knowledge-bases")) return new Response(JSON.stringify(configOverrides.manyKnowledgeBases ? fixtures.manyKnowledgeBases : fixtures.knowledgeBases));
    if (url.endsWith("/knowledge-bases/kb-1")) return new Response(JSON.stringify(fixtures.knowledgeBaseDetail));
    if (url.endsWith("/knowledge-search")) return new Response(JSON.stringify(configOverrides.longContent ? fixtures.searchLong : fixtures.search));
    if (url.endsWith("/wiki/stats")) return new Response(JSON.stringify(fixtures.wikiStats));
    if (failWikiLint && url.endsWith("/wiki/lint")) return new Response(JSON.stringify({ error: { message: "lint service unavailable" } }), { status: 503 });
    if (url.endsWith("/wiki/lint")) return new Response(JSON.stringify(fixtures.wikiLint));
    if (url.endsWith("/wiki/issues")) return new Response(JSON.stringify(fixtures.wikiIssues));
    if (url.includes("/wiki/pages/")) return new Response(JSON.stringify(fixtures.wikiPage));
    if (url.includes("/wiki/pages?")) return new Response(JSON.stringify(fixtures.wikiPages));
    if (init?.method === "POST") return new Response(JSON.stringify(fixtures.ingest), { status: 202 });
    return new Response(JSON.stringify(configOverrides.longContent ? fixtures.knowledgeLong : fixtures.knowledge));
  };
  return harness;
}

describe("WeKnora worker surfaces", () => {
  it("registers exactly seven read tools and no write tool", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);
    for (const name of Object.values(TOOL_NAMES)) {
      await expect(harness.executeTool(name, { companyId: "company-1", ...(name === TOOL_NAMES.search ? { query: "runbook" } : {}), ...(name === TOOL_NAMES.readDocument ? { knowledgeId: "doc-1" } : {}), ...(name.includes("wiki") && name !== TOOL_NAMES.search ? { knowledgeBaseId: "kb-1", ...(name === TOOL_NAMES.readWikiPage ? { slug: "operations/runbook" } : {}), ...(name === TOOL_NAMES.searchWiki ? { query: "runbook" } : {}) } : {}) }, { companyId: "company-1" })).resolves.toHaveProperty("data");
    }
    await expect(harness.executeTool("weknora_ingest_manual", { companyId: "company-1" })).rejects.toThrow(/No tool handler/);
  });

  it("keeps all write actions board-only and disabled by default", async () => {
    const writeActions = ["ingest-manual", "ingest-url", "rebuild-wiki-links", "auto-fix-wiki"] as const;
    const disabled = setupHarness();
    await plugin.definition.setup(disabled.ctx);
    for (const action of writeActions) {
      const params = { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text", url: "https://docs.example/runbook" };
      await expect(disabled.performAction(action, params, { actor: { type: "agent", agentId: "agent-1", companyId: "company-1" } })).rejects.toMatchObject({ kind: "forbidden" });
      await expect(disabled.performAction(action, params, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).rejects.toMatchObject({ message: "WeKnora write actions are disabled by operator configuration" });
    }

    const enabled = setupHarness(true);
    await plugin.definition.setup(enabled.ctx);
    for (const action of writeActions) {
      const params = { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text", url: "https://docs.example/runbook" };
      await expect(enabled.performAction(action, params, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).resolves.toMatchObject({ id: "task-1" });
    }
    expect(enabled.activity).toHaveLength(writeActions.length);
    expect(enabled.activity.map((entry) => entry.message)).toEqual(expect.arrayContaining(writeActions.map((action) => expect.stringContaining(action))));
    await expect(enabled.performAction("ingest-manual", { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text", metadata: { oversized: "x".repeat(1_000_000) } }, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).rejects.toMatchObject({ message: "Manual ingest request body exceeds the 1 MB limit" });
    await expect(enabled.performAction("ingest-url", { companyId: "company-1", knowledgeBaseId: "kb-1", url: "https://docs.example/runbook", metadata: { oversized: "x".repeat(1_000_000) } }, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).rejects.toMatchObject({ message: "URL ingest request body exceeds the 1 MB limit" });
  });

  it("enforces board-only write routes and returns degraded health with partial warnings", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);
    const worker = plugin.definition.onApiRequest;
    expect(worker).toBeDefined();
    const writeRoutes = [
      [ROUTE_KEYS.ingestManual, { title: "Note", content: "Text" }],
      [ROUTE_KEYS.ingestUrl, { url: "https://docs.example/runbook" }],
      [ROUTE_KEYS.rebuildWikiLinks, {}],
      [ROUTE_KEYS.autoFixWiki, {}],
    ] as const;
    for (const [routeKey, body] of writeRoutes) {
      const agentResult = await worker!(routeInput(routeKey, { actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", userId: null }, method: "POST", params: { knowledgeBaseId: "kb-1" }, body }));
      expect(agentResult.status).toBe(403);
      const boardResult = await worker!(routeInput(routeKey, { method: "POST", params: { knowledgeBaseId: "kb-1" }, body }));
      expect(boardResult.status).toBe(403);
    }
    const health = await harness.getData("health", { companyId: "company-1", knowledgeBaseId: "kb-1" });
    expect(health).toMatchObject({ status: "ok" });

    const partial = setupHarness(false, true);
    await plugin.definition.setup(partial.ctx);
    const partialHealth = await partial.getData("health", { companyId: "company-1", knowledgeBaseId: "kb-1" });
    expect(partialHealth).toMatchObject({ status: "degraded" });
    expect((partialHealth as { warnings?: string[] }).warnings).toEqual(["Wiki lint unavailable: lint service unavailable"]);
  });

  it("bounds the knowledge-base list and reports truncation", async () => {
    const harness = setupHarness(false, false, { maxResults: 3, manyKnowledgeBases: true });
    await plugin.definition.setup(harness.ctx);
    const result = await harness.getData("knowledge-bases", { companyId: "company-1" });
    expect(result).toMatchObject({ total: 12, truncated: true });
    expect((result as { knowledgeBases: unknown[] }).knowledgeBases).toHaveLength(3);
  });

  it("caps search results, chunk characters, and document paging", async () => {
    const harness = setupHarness(false, false, { maxResults: 1, maxChunkChars: 200, longContent: true });
    await plugin.definition.setup(harness.ctx);
    const search = await harness.getData("search", { companyId: "company-1", query: "runbook" });
    expect(search).toMatchObject({ results: [{ truncated: true }] });
    expect((search as { results: Array<{ content: string }> }).results).toHaveLength(1);
    expect((search as { results: Array<{ content: string }> }).results[0]?.content).toHaveLength(200);
    const document = await harness.getData("document", { companyId: "company-1", knowledgeId: "doc-1", page: 1, pageSize: 50 });
    expect(document).toMatchObject({ page: 1, pageSize: 50, hasMore: false });
    expect((document as { chunks: Array<{ content: string; truncated: boolean }> }).chunks[0]).toMatchObject({ truncated: true });
    expect((document as { chunks: Array<{ content: string; truncated: boolean }> }).chunks[0]?.content).toHaveLength(200);
  });
});
