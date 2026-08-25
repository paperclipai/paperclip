import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { createWeKnoraClient } from "../src/client/weknora-client.js";
import { WeknoraPluginError } from "../src/errors.js";
import * as fixtures from "./fixtures/weknora-responses.js";

const config = { baseUrl: "https://weknora.example", apiKeyRef: { type: "secret_ref", secretId: "secret-1" } };

function clientFor(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const harness = createTestHarness({ manifest, config });
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
    await expect(client.ingestManual("kb-1", { title: "Note", content: "Text" })).resolves.toMatchObject({ id: "task-1" });
    expect(calls.some((call) => call.startsWith("POST") && call.includes("knowledge/manual"))).toBe(true);
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
});
