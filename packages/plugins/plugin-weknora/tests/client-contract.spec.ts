import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createWeKnoraClient } from "../src/client/weknora-client.js";
import { WeknoraPluginError } from "../src/errors.js";
import { normalizeConfig } from "../src/config.js";
import { createHealthService } from "../src/services/health.js";
import { createRetrievalService } from "../src/services/retrieval.js";
import * as fixtures from "./fixtures/weknora-responses.js";

const config = { baseUrl: "https://weknora.example", apiKeyRef: { type: "secret_ref", secretId: "secret-1" } };

function clientFor(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, configOverrides: Record<string, unknown> = {}) {
  const harness = createTestHarness({ manifest, config: { ...config, ...configOverrides } });
  harness.ctx.secrets.resolve = async () => "fixture-api-key";
  harness.ctx.http.fetch = fetchImpl;
  return { client: createWeKnoraClient(harness.ctx, "company-1", { sleep: async () => undefined, random: () => 0 }), harness };
}

function response(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}

describe("WeKnora HTTP contract", () => {
  it("normalizes paths and injects only the request-scoped credentials", async () => {
    let observed: { url: string; init?: RequestInit } | undefined;
    const { client } = clientFor(async (url, init) => {
      observed = { url, init };
      return response(fixtures.knowledgeBases);
    });
    await client.listKnowledgeBases();
    expect(observed?.url).toBe("https://weknora.example/api/v1/knowledge-bases");
    expect(observed?.init?.redirect).toBe("manual");
    expect(new Headers(observed?.init?.headers).get("X-API-Key")).toBe("fixture-api-key");
    expect(new Headers(observed?.init?.headers).get("X-Tenant-ID")).toBeNull();
    expect(new Headers(observed?.init?.headers).get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("covers fixture codecs for reads and non-retrying writes", async () => {
    const calls: string[] = [];
    const { client } = clientFor(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/knowledge-bases")) return response(fixtures.knowledgeBases);
      if (url.endsWith("/knowledge-bases/kb-1")) return response(fixtures.knowledgeBaseDetail);
      if (url.endsWith("/knowledge-search")) return response(fixtures.search);
      if (url.endsWith("/knowledge/doc-1")) return response(fixtures.knowledge);
      if (url.includes("/chunks/doc-1")) return response(fixtures.chunks);
      if (url.includes("/wiki/pages/operations%2Frunbook")) return response(fixtures.wikiPage);
      if (url.includes("/wiki/pages?")) return response(fixtures.wikiPages);
      if (url.endsWith("/wiki/search?query=runbook&limit=8")) return response(fixtures.wikiSearch);
      if (url.endsWith("/wiki/stats")) return response(fixtures.wikiStats);
      if (url.endsWith("/wiki/lint")) return response(fixtures.wikiLint);
      if (url.endsWith("/wiki/issues")) return response(fixtures.wikiIssues);
      if (init?.method === "POST") return response(fixtures.ingest, { status: 202 });
      return response({ success: false, error: { message: "fixture not found" } }, { status: 404 });
    });
    await expect(client.listKnowledgeBases()).resolves.toMatchObject({ knowledgeBases: [{ id: "kb-1" }] });
    await expect(client.search({ query: "runbook", maxResults: 8 })).resolves.toMatchObject({ results: [{ knowledgeId: "doc-1", chunkIndex: 0 }] });
    await expect(client.readKnowledge("doc-1")).resolves.toMatchObject({ document: { id: "doc-1" }, chunks: [{ index: 0, content: "First chunk." }, { index: 1, content: "Second chunk." }] });
    await expect(client.listChunks("doc-1", 2, 1)).resolves.toMatchObject({ chunks: [{ index: 2 }] });
    await expect(client.listWikiPages("kb-1", 1, 8)).resolves.toMatchObject({ pages: [{ slug: "operations/runbook" }] });
    await expect(client.readWikiPage("kb-1", "operations/runbook")).resolves.toMatchObject({ page: { slug: "operations/runbook" } });
    await expect(client.searchWiki("kb-1", "runbook", 8)).resolves.toMatchObject({ results: [{ slug: "operations/runbook" }] });
    await expect(client.wikiDiagnostics("kb-1")).resolves.toMatchObject({ stats: { pages: 1 }, lintCounts: { broken_links: 1 }, issues: [{ code: "broken_link" }] });
    const detail = await client.knowledgeBaseDetail("kb-1");
    expect(detail).toMatchObject({ id: "kb-1", name: "Engineering", status: "ready" });
    expect(detail).not.toHaveProperty("headers");
    expect(detail).not.toHaveProperty("html");
    expect(detail).not.toHaveProperty("instruction");
    await expect(client.ingestManual("kb-1", { title: "Note", content: "Text" })).resolves.toMatchObject({ id: "task-1" });
    await expect(client.ingestUrl("kb-1", { url: "https://docs.example/runbook", title: "Runbook" })).resolves.toMatchObject({ id: "task-1" });
    await expect(client.rebuildWikiLinks("kb-1")).resolves.toMatchObject({ id: "task-1" });
    await expect(client.autoFixWiki("kb-1")).resolves.toMatchObject({ id: "task-1" });
    expect(calls.some((call) => call.startsWith("POST") && call.includes("knowledge/manual"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST") && call.includes("knowledge/url"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST") && call.includes("wiki/rebuild-links"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST") && call.includes("wiki/auto-fix"))).toBe(true);
    const diagnostics = await client.wikiDiagnostics("kb-1");
    expect(diagnostics).not.toHaveProperty("headers");
    expect(diagnostics).not.toHaveProperty("instruction");
    expect(diagnostics.stats).not.toHaveProperty("html");
    expect(diagnostics.issues?.[0]).not.toHaveProperty("message");
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-api-key");
  });

  it("retries idempotent reads twice, refuses redirects, and never retries writes", async () => {
    let attempts = 0;
    const { client } = clientFor(async () => {
      attempts += 1;
      return attempts < 3 ? response({ error: { message: "temporarily unavailable" } }, { status: 503 }) : response(fixtures.knowledgeBases);
    });
    await expect(client.listKnowledgeBases()).resolves.toMatchObject({ knowledgeBases: [{ id: "kb-1" }] });
    expect(attempts).toBe(3);

    const redirectClient = clientFor(async () => response("<html>redirect api-key=fixture-api-key</html>", { status: 302, headers: { location: "https://evil.example" } })).client;
    await expect(redirectClient.listKnowledgeBases()).rejects.toMatchObject({ message: "WeKnora redirects are not allowed" });

    let writeAttempts = 0;
    const writeClient = clientFor(async () => { writeAttempts += 1; return response({ error: { message: "write failed api-key=fixture-api-key" } }, { status: 503 }); }).client;
    await expect(writeClient.ingestManual("kb-1", { title: "Note", content: "Text" })).rejects.toMatchObject({ kind: "unavailable" });
    expect(writeAttempts).toBe(1);
    try {
      await writeClient.ingestManual("kb-1", { title: "Note", content: "api-key=fixture-api-key" });
    } catch (error) {
      expect(error).toBeInstanceOf(WeknoraPluginError);
      expect(String(error)).not.toContain("fixture-api-key");
    }
  });

  it("passes the tenant header and bounds timeout retries by idempotency", async () => {
    let readAttempts = 0;
    let observedTenant: string | null = null;
    const timeoutClient = clientFor(async (_url, init) => {
      readAttempts += 1;
      observedTenant = new Headers(init?.headers).get("X-Tenant-ID");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("aborted", "AbortError");
    }, { tenantId: "tenant-1" }).client;
    await expect(timeoutClient.listKnowledgeBases()).rejects.toMatchObject({ kind: "timeout" });
    expect(readAttempts).toBe(3);
    expect(observedTenant).toBe("tenant-1");

    let writeAttempts = 0;
    const writeTimeoutClient = clientFor(async () => {
      writeAttempts += 1;
      throw new DOMException("aborted", "AbortError");
    }).client;
    await expect(writeTimeoutClient.ingestUrl("kb-1", { url: "https://docs.example/runbook" })).rejects.toMatchObject({ kind: "timeout" });
    expect(writeAttempts).toBe(1);
  });

  it("makes authentication, missing-secret, and invalid-config health failures unavailable", async () => {
    const unauthorizedClient = clientFor(async () => response({ error: { message: "access denied" } }, { status: 401 })).client;
    const unauthorizedHealth = await createHealthService(unauthorizedClient, normalizeConfig(config)).check("kb-1");
    expect(unauthorizedHealth).toMatchObject({ status: "unavailable", error: { kind: "auth" } });

    const missingSecret = clientFor(async () => response(fixtures.knowledgeBases));
    missingSecret.harness.ctx.secrets.resolve = async () => { throw new Error("secret is missing"); };
    const missingSecretHealth = await createHealthService(missingSecret.client, normalizeConfig(config)).check("kb-1");
    expect(missingSecretHealth).toMatchObject({ status: "unavailable", error: { kind: "auth" } });

    const invalidConfigHarness = createTestHarness({ manifest, config: { baseUrl: "https://weknora.example" } as typeof config });
    const invalidConfigClient = createWeKnoraClient(invalidConfigHarness.ctx, "company-1", { sleep: async () => undefined, random: () => 0 });
    const invalidConfigHealth = await createHealthService(invalidConfigClient, normalizeConfig(config)).check("kb-1");
    expect(invalidConfigHealth).toMatchObject({ status: "unavailable", error: { kind: "invalid_config" } });
  });

  it("caps knowledge-base listings and reports known upstream truncation", async () => {
    const capped = clientFor(async () => response(fixtures.manyKnowledgeBases), { maxResults: 3 });
    const service = createRetrievalService(capped.client, normalizeConfig({ ...config, maxResults: 3 }));
    const result = await service.listKnowledgeBases();
    expect(result).toMatchObject({ total: 12, truncated: true });
    expect(result.knowledgeBases).toHaveLength(3);
  });
});
