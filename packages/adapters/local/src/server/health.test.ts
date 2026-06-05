import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalInferenceHealth, listLocalModels } from "./health.js";

const fetchMock = vi.fn<typeof fetch>();

describe("local inference health", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delete process.env.INFERENCE_LOCAL_FORCE;
    delete process.env.INFERENCE_LOCAL_AVAILABLE;
    delete process.env.INFERENCE_LOCAL_MODELS;
    delete process.env.INFERENCE_LOCAL_URL_OVERRIDE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("honors INFERENCE_LOCAL_FORCE=off for fallback testing", async () => {
    process.env.INFERENCE_LOCAL_FORCE = "off";

    await expect(getLocalInferenceHealth()).resolves.toEqual({
      available: false,
      url: "http://localhost:1234/v1",
      models: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("probes /models and returns served model ids", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "qwen/qwen3-coder-30b" }, { id: "text-embedding-bge-m3" }],
    }), { status: 200 }));

    const health = await getLocalInferenceHealth({ baseUrl: "http://local.test/v1/" });

    expect(health).toEqual({
      available: true,
      url: "http://local.test/v1",
      models: ["qwen/qwen3-coder-30b", "text-embedding-bge-m3"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://local.test/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends the configured API key as a bearer token", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "qwen/qwen3-coder-30b" }],
    }), { status: 200 }));

    await getLocalInferenceHealth({
      apiKey: "local-secret",
      baseUrl: "http://local.test/v1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://local.test/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-secret" },
      }),
    );
  });

  it("keeps embedding models out of selectable chat models", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "qwen/qwen3-coder-30b" }, { id: "text-embedding-bge-m3" }],
    }), { status: 200 }));

    await expect(listLocalModels()).resolves.toEqual([
      { id: "qwen/qwen3-coder-30b", label: "qwen/qwen3-coder-30b" },
    ]);
  });
});
