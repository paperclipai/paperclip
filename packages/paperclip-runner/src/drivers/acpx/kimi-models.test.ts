import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiMetadataProbeError, probeKimiModels } from "./kimi-models.js";

const model = "kimi-for-coding";
const key = "selected-key-canary";
const payload = { data: [{ id: "別のモデル", limit: { context: 262144 } }, { id: model, limit: { context: 1048576 } }] };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const dependency = (value: Response) => ({ fetch: vi.fn<typeof fetch>().mockResolvedValue(value) });

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Kimi Code authenticated model metadata", () => {
  it("uses only the selected key, pinned endpoint and official client identity without inference", async () => {
    vi.stubEnv("KIMI_API_KEY", "ambient-unselected-key");
    vi.stubEnv("KIMI_CODE_BASE_URL", "https://unselected.example");
    const bytes = Buffer.from(JSON.stringify(payload));
    const split = bytes.indexOf(Buffer.from("別")) + 1;
    const deps = dependency(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close();
    } })));
    await expect(probeKimiModels(model, key, deps)).resolves.toEqual({
      code: "kimi_metadata_verified", model, contextLength: 1048576,
      message: expect.stringContaining("No model prompt was sent"),
    });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = deps.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.kimi.ai/coding/v1/models");
    expect(init).toMatchObject({ method: "GET", redirect: "error", headers: {
      Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "KimiCLI/2.3.3",
    } });
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects absent credentials before fetching and never falls back to ambient login", async () => {
    vi.stubEnv("KIMI_API_KEY", key);
    const deps = dependency(response(payload));
    for (const invalid of ["", "  ", "x\ny", "x\ry", "x\0y", "x".repeat(16385)]) {
      await expect(probeKimiModels(model, invalid, deps)).rejects.toMatchObject({ code: "KIMI_AUTH_REQUIRED" });
    }
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 402, 403])("preserves typed HTTP %i credential/access rejection without reading its body", async status => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    const getReader = vi.spyOn(body, "getReader");
    const deps = dependency(new Response(body, { status }));
    await expect(probeKimiModels(model, key, deps)).rejects.toMatchObject({
      name: "KimiMetadataProbeError", code: "KIMI_AUTH_REJECTED", status,
    });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
  });

  it("requires the exact selected model without aliases or fallback", async () => {
    for (const selected of ["KIMI-FOR-CODING", "kimi-for-coding ", "unlisted", "", "x\0y", "x".repeat(513)]) {
      await expect(probeKimiModels(selected, key, dependency(response(payload))))
        .rejects.toMatchObject({ code: "KIMI_MODEL_UNAVAILABLE" });
    }
  });

  it.each([
    null, [], {}, { data: {} }, { data: [null] }, { data: [{ id: "", limit: { context: 1 } }] },
    { data: [{ id: model }] }, { data: [{ id: model, limit: { context: 0 } }] },
    { data: [{ id: model, limit: { context: -1 } }] }, { data: [{ id: model, limit: { context: 1.2 } }] },
    { data: [{ id: model, limit: { context: true } }] }, { data: [{ id: model, limit: { context: "" } }] },
    { data: [{ id: model, limit: { context: Number.MAX_SAFE_INTEGER + 1 } }] },
    { data: [{ id: model, limit: { context: 1 } }, { id: model, limit: { context: 2 } }] },
  ])("rejects invalid or ambiguous metadata %#", async value => {
    await expect(probeKimiModels(model, key, dependency(response(value)))).rejects.toMatchObject({ code: "KIMI_METADATA_INVALID" });
  });

  it("accepts the native numeric-string context representation", async () => {
    await expect(probeKimiModels(model, key, dependency(response({ data: [{ id: model, limit: { context: "1048576" } }] }))))
      .resolves.toMatchObject({ contextLength: 1048576 });
  });

  it("bounds streamed bytes even when Content-Length is missing or false", async () => {
    for (const headers of [{}, { "content-length": "10" }]) {
      const cancel = vi.fn();
      const deps = dependency(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1));
      }, cancel }), { headers }));
      await expect(probeKimiModels(model, key, deps)).rejects.toMatchObject({ code: "KIMI_METADATA_INVALID" });
      expect(deps.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(cancel).toHaveBeenCalled();
    }
  });

  it("rejects oversized declared bodies before consuming them", async () => {
    const cancel = vi.fn();
    const deps = dependency(new Response(new ReadableStream({ cancel }), { headers: { "content-length": "262145" } }));
    await expect(probeKimiModels(model, key, deps)).rejects.toMatchObject({ code: "KIMI_METADATA_INVALID" });
    expect(cancel).toHaveBeenCalled();
  });

  it.each([new Uint8Array([0xff]), Buffer.from("invalid JSON")])("rejects invalid UTF-8 or JSON %#", async bytes => {
    await expect(probeKimiModels(model, key, dependency(new Response(bytes))))
      .rejects.toMatchObject({ code: "KIMI_METADATA_INVALID" });
  });

  it("aborts an outstanding request at the fixed eight-second deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const aborted = vi.fn();
    const deps = { fetch: vi.fn<typeof fetch>((_url, init) => new Promise((_, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => { aborted(); reject(new Error(`request failure ${key}`)); });
    })) };
    const rejected = expect(probeKimiModels(model, key, deps)).rejects.toMatchObject({ code: "KIMI_METADATA_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(7999);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline active after headers and cancels a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const deps = dependency(new Response(new ReadableStream({ cancel })));
    const rejected = expect(probeKimiModels(model, key, deps)).rejects.toMatchObject({ code: "KIMI_METADATA_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(deps.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("sanitizes provider responses and transport exceptions", async () => {
    for (const deps of [dependency(new Response(`private response ${key}`, { status: 500 })),
      { fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error(`private request ${key}`)) }]) {
      let failure: unknown;
      try { await probeKimiModels(model, key, deps); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(KimiMetadataProbeError);
      expect(failure).toMatchObject({ code: "KIMI_PROVIDER_ERROR" });
      expect(JSON.stringify(failure)).not.toContain(key);
      expect(String(failure)).not.toContain(key);
      expect(failure).not.toHaveProperty("cause");
    }
  });
});
