import { describe, expect, it, vi } from "vitest";
import {
  OpenCrabClient,
  OpenCrabClientError,
  clampOpenCrabLimit,
  redactOpenCrabEndpoint,
} from "./opencrab-client.js";

describe("OpenCrabClient", () => {
  const endpoint = "https://opencrab.sh/api/mcp/test-secret-key";

  it("redacts embedded endpoint keys", () => {
    expect(redactOpenCrabEndpoint(endpoint)).toBe("https://opencrab.sh/api/mcp/[REDACTED]");
    expect(redactOpenCrabEndpoint("not-a-url/secret")).toBe("[REDACTED]");
  });

  it("clamps result limits and topK values", () => {
    expect(clampOpenCrabLimit(undefined)).toBe(10);
    expect(clampOpenCrabLimit(0)).toBe(1);
    expect(clampOpenCrabLimit(999)).toBe(50);
    expect(clampOpenCrabLimit(7)).toBe(7);
  });

  it("normalizes status tool responses", async () => {
    const transport = vi.fn(async () => ({ status: "ok", tools: ["opencrab_query"] }));
    const client = new OpenCrabClient({ endpoint, transport });

    await expect(client.status()).resolves.toEqual({
      status: "ok",
      tools: ["opencrab_query"],
    });
    expect(transport).toHaveBeenCalledWith({ tool: "opencrab_status", arguments: {} });
  });

  it("bounds query topK before transport call", async () => {
    const transport = vi.fn(async () => ({ answer: "result" }));
    const client = new OpenCrabClient({ endpoint, transport });

    await client.query({ query: "Paperclip ontology", topK: 999, workspaceId: "workspace-1" });

    expect(transport).toHaveBeenCalledWith({
      tool: "opencrab_query",
      arguments: {
        query: "Paperclip ontology",
        top_k: 50,
        workspace_id: "workspace-1",
      },
    });
  });

  it("normalizes search document requests", async () => {
    const transport = vi.fn(async () => ({ documents: [] }));
    const client = new OpenCrabClient({ endpoint, transport });

    await client.searchDocuments({ query: "FMG", limit: 0, sourceType: "paperclip" });

    expect(transport).toHaveBeenCalledWith({
      tool: "opencrab_search_documents",
      arguments: {
        query: "FMG",
        limit: 1,
        source_type: "paperclip",
      },
    });
  });

  it("converts transport failures into safe redacted errors", async () => {
    const transport = vi.fn(async () => {
      throw new Error(`failed to call ${endpoint}`);
    });
    const client = new OpenCrabClient({ endpoint, transport });

    await expect(client.searchNodes({ query: "secret" })).rejects.toMatchObject({
      name: "OpenCrabClientError",
      safeEndpoint: "https://opencrab.sh/api/mcp/[REDACTED]",
    });
    await expect(client.searchNodes({ query: "secret" })).rejects.not.toThrow("test-secret-key");
  });

  it("rejects ingest calls unless ingestEnabled is true", async () => {
    const transport = vi.fn(async () => ({ ok: true }));
    const client = new OpenCrabClient({ endpoint, transport, ingestEnabled: false });

    await expect(client.ingestText({ text: "knowledge" })).rejects.toBeInstanceOf(OpenCrabClientError);
    expect(transport).not.toHaveBeenCalled();
  });

  it("allows ingest when explicitly enabled", async () => {
    const transport = vi.fn(async () => ({ ok: true }));
    const client = new OpenCrabClient({ endpoint, transport, ingestEnabled: true });

    await expect(client.ingestText({ text: "knowledge", sourceId: "paperclip" })).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledWith({
      tool: "opencrab_ingest_text",
      arguments: {
        text: "knowledge",
        source_id: "paperclip",
      },
    });
  });
});
