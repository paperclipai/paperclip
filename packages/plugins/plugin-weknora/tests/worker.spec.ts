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

function setupHarness(writeEnabled = false, failWikiLint = false) {
  const harness = createTestHarness({ manifest, config: { ...config, enableWriteActions: writeEnabled } });
  harness.ctx.secrets.resolve = async () => "fixture-api-key";
  harness.ctx.http.fetch = async (url, init) => {
    if (url.endsWith("/knowledge-bases")) return new Response(JSON.stringify(fixtures.knowledgeBases));
    if (url.endsWith("/knowledge-search")) return new Response(JSON.stringify(fixtures.search));
    if (url.endsWith("/wiki/stats")) return new Response(JSON.stringify(fixtures.wikiStats));
    if (failWikiLint && url.endsWith("/wiki/lint")) return new Response(JSON.stringify({ error: { message: "lint service unavailable" } }), { status: 503 });
    if (url.endsWith("/wiki/lint")) return new Response(JSON.stringify(fixtures.wikiLint));
    if (url.endsWith("/wiki/issues")) return new Response(JSON.stringify(fixtures.wikiIssues));
    if (url.includes("/wiki/pages/")) return new Response(JSON.stringify(fixtures.wikiPage));
    if (url.includes("/wiki/pages?")) return new Response(JSON.stringify(fixtures.wikiPages));
    if (init?.method === "POST") return new Response(JSON.stringify(fixtures.ingest), { status: 202 });
    return new Response(JSON.stringify(fixtures.knowledge));
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

  it("keeps write actions board-only and disabled by default", async () => {
    const disabled = setupHarness();
    await plugin.definition.setup(disabled.ctx);
    await expect(disabled.performAction("ingest-manual", { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text" }, { actor: { type: "agent", agentId: "agent-1", companyId: "company-1" } })).rejects.toMatchObject({ kind: "forbidden" });
    await expect(disabled.performAction("ingest-manual", { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text" }, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).rejects.toMatchObject({ message: "WeKnora write actions are disabled by operator configuration" });

    const enabled = setupHarness(true);
    await plugin.definition.setup(enabled.ctx);
    await expect(enabled.performAction("ingest-manual", { companyId: "company-1", knowledgeBaseId: "kb-1", title: "Note", content: "Text" }, { actor: { type: "user", userId: "board-1", companyId: "company-1" } })).resolves.toMatchObject({ id: "task-1" });
    expect(enabled.activity).toHaveLength(1);
    expect(enabled.activity[0]?.message).toContain("ingest-manual");
  });

  it("enforces board-only write routes and returns degraded health with partial warnings", async () => {
    const harness = setupHarness();
    await plugin.definition.setup(harness.ctx);
    const worker = plugin.definition.onApiRequest;
    expect(worker).toBeDefined();
    const agentResult = await worker!(routeInput(ROUTE_KEYS.ingestManual, { actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", userId: null }, method: "POST", params: { knowledgeBaseId: "kb-1" }, body: { title: "Note", content: "Text" } }));
    expect(agentResult.status).toBe(403);
    const health = await harness.getData("health", { companyId: "company-1", knowledgeBaseId: "kb-1" });
    expect(health).toMatchObject({ status: "ok" });

    const partial = setupHarness(false, true);
    await plugin.definition.setup(partial.ctx);
    const partialHealth = await partial.getData("health", { companyId: "company-1", knowledgeBaseId: "kb-1" });
    expect(partialHealth).toMatchObject({ status: "degraded" });
    expect((partialHealth as { warnings?: string[] }).warnings).toEqual(["Wiki lint unavailable: lint service unavailable"]);
  });
});
