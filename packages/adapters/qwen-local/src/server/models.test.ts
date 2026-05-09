import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidQwenModelId } from "../index.js";
import { listQwenModels, requireQwenModelId } from "./models.js";

describe("isValidQwenModelId", () => {
  it("accepts non-empty trimmed strings", () => {
    expect(isValidQwenModelId("Qwen/Qwen3.6-35B-A3B-FP8")).toBe(true);
    expect(isValidQwenModelId("any-id")).toBe(true);
  });

  it("rejects non-strings, empty, and whitespace-only", () => {
    expect(isValidQwenModelId(undefined)).toBe(false);
    expect(isValidQwenModelId("")).toBe(false);
    expect(isValidQwenModelId("   ")).toBe(false);
    expect(isValidQwenModelId(42)).toBe(false);
  });
});

describe("requireQwenModelId", () => {
  it("returns the trimmed id for valid input", () => {
    expect(requireQwenModelId(" Qwen/x ")).toBe("Qwen/x");
  });
  it("throws on missing/invalid input", () => {
    expect(() => requireQwenModelId("")).toThrow(/qwen_local requires/);
    expect(() => requireQwenModelId(undefined)).toThrow();
  });
});

describe("listQwenModels", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls baseUrl/models with bearer token, returns sorted, deduped models", async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe("http://dgx:8000/v1/models");
      expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-9999" });
      return new Response(
        JSON.stringify({
          data: [
            { id: "Qwen/Qwen3.6-7B" },
            { id: "Qwen/Qwen3.6-35B-A3B-FP8" },
            { id: "Qwen/Qwen3.6-7B" },
          ],
        }),
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const models = await listQwenModels({ baseUrl: "http://dgx:8000/v1/", apiKey: "sk-9999" });
    expect(models.map((m) => m.id)).toEqual(["Qwen/Qwen3.6-7B", "Qwen/Qwen3.6-35B-A3B-FP8"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on non-2xx", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401, statusText: "Unauthorized" })) as unknown as typeof fetch;
    await expect(
      listQwenModels({ baseUrl: "http://dgx:8000/v1", apiKey: "bad" }),
    ).rejects.toThrow(/401 Unauthorized/);
  });
});
