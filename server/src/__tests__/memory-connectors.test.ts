import { describe, expect, it, vi } from "vitest";
import { classifyRisk } from "../services/tool-access.js";
import { COGNEE_STDIO_TEMPLATE, cogneeCloudUrl, callCogneeCloud } from "../services/cognee-connection.js";

describe("memory tool governance", () => {
  it.each([
    ["mem0", "add_memory", "write"], ["mem0", "search_memories", "read"],
    ["mem0", "delete_entities", "destructive"], ["zep", "add_memory_to_graph", "write"],
    ["supermemory", "add_memory", "destructive"], ["supermemory", "select-space", "write"],
    ["supermemory", "get_profile", "read"], ["cognee", "remember", "write"],
    ["cognee", "recall", "read"], ["cognee", "forget", "destructive"],
    ["honcho", "create_peer", "write"], ["honcho", "future_unknown_action", "write"],
  ])("classifies %s %s even with a misleading read hint", (provider, name, expected) => {
    expect(classifyRisk({ name, annotations: { readOnlyHint: true } }, provider)).toBe(expected);
  });
  it("keeps the approved Cognee bridge free of runtime package resolution", () => {
    expect(COGNEE_STDIO_TEMPLATE.command).toBeNull();
    expect(COGNEE_STDIO_TEMPLATE.args).toEqual([]);
    expect(COGNEE_STDIO_TEMPLATE.envKeys).toEqual(["COGNEE_BASE_URL", "COGNEE_API_KEY"]);
    expect(COGNEE_STDIO_TEMPLATE.tools.map(t => t.name)).toEqual(["remember", "recall", "forget"]);
  });
  it.each(["http://localhost", "https://evil.test", "https://tenant.aws.cognee.ai@evil.test", "https://tenant.aws.cognee.ai/other", "https://tenant.aws.cognee.ai?key=secret", "https://tenant.aws.cognee.ai:8443"])("rejects unreviewed Cognee URL %s", (url) => {
    expect(() => cogneeCloudUrl(url)).toThrow();
  });
  it("accepts the tenant API origin", () => expect(cogneeCloudUrl("https://tenant.aws.cognee.ai").origin).toBe("https://tenant.aws.cognee.ai"));
  it("writes text as a file to the tenant-only Cloud endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ status: "completed" });
    const result = await callCogneeCloud({ baseUrl: "https://fixture.aws.cognee.ai", apiKey: "fixture-key",
      tool: "remember", parameters: { data: "synthetic memory", dataset_name: "fixture" }, request,
      signal: AbortSignal.timeout(1000) });
    const [url, init] = request.mock.calls[0]!;
    expect(url.href).toBe("https://fixture.aws.cognee.ai/api/v1/remember");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: expect.objectContaining({ "x-api-key": "fixture-key" }) });
    expect(Buffer.isBuffer(init.body)).toBe(true);
    const form = await new Response(init.body, { headers: init.headers }).formData();
    expect(form.get("datasetName")).toBe("fixture");
    expect(await (form.get("data") as File).text()).toBe("synthetic memory");
    expect(result).toMatchObject({ isError: false, structuredContent: { result: { status: "completed" } } });
  });
  it("keeps session writes on the Cloud session endpoint", async () => {
    const request = vi.fn().mockResolvedValue({ status: "completed" });
    await callCogneeCloud({ baseUrl: "https://fixture.aws.cognee.ai", apiKey: "key", tool: "remember",
      parameters: { data: "text", session_id: "session", dataset_name: "fixture" }, request, signal: AbortSignal.timeout(1000) });
    expect(request.mock.calls[0]![0].pathname).toBe("/api/v1/remember/entry");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toMatchObject({
      entry: { type: "qa", answer: "text" }, session_id: "session", dataset_name: "fixture" });
  });
  it("preserves scoped recall arguments and does not fetch other datasets", async () => {
    const request = vi.fn().mockResolvedValue(["memory"]);
    await callCogneeCloud({ baseUrl: "https://fixture.aws.cognee.ai", apiKey: "key", tool: "recall",
      parameters: { query: "find", datasets: "one, two", search_type: "chunks", top_k: 3 }, request, signal: AbortSignal.timeout(1000) });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0].pathname).toBe("/api/v1/recall");
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ query: "find", datasets: ["one", "two"], search_type: "CHUNKS", top_k: 3 });
  });
  it("matches the official client's unscoped dataset discovery", async () => {
    const request = vi.fn().mockResolvedValueOnce([{ name: "one" }]).mockResolvedValueOnce(["memory"]);
    await callCogneeCloud({ baseUrl: "https://fixture.aws.cognee.ai", apiKey: "key", tool: "recall",
      parameters: { query: "find" }, request, signal: AbortSignal.timeout(1000) });
    expect(request.mock.calls[0]![0].pathname).toBe("/api/v1/datasets/");
    expect(JSON.parse(request.mock.calls[1]![1].body).datasets).toEqual(["one"]);
  });
  it("requires an explicit delete target and never falls back after a provider failure", async () => {
    const request = vi.fn().mockRejectedValue(new Error("Cloud unavailable"));
    const input = { baseUrl: "https://fixture.aws.cognee.ai", apiKey: "key", tool: "forget", parameters: {}, request, signal: AbortSignal.timeout(1000) };
    await expect(callCogneeCloud(input)).rejects.toThrow("Specify a dataset");
    expect(request).not.toHaveBeenCalled();
    await expect(callCogneeCloud({ ...input, parameters: { dataset: "fixture" } })).rejects.toThrow("Cloud unavailable");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0]![1].body)).toEqual({ dataset: "fixture", everything: false });
  });
});
