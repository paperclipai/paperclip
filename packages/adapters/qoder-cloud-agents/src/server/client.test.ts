import { describe, expect, it } from "vitest";
import { QoderApiError, createQoderClient, normalizeQoderApiBaseUrl } from "./client.js";

describe("normalizeQoderApiBaseUrl", () => {
  it.each([
    ["", "https://api.qoder.com"],
    ["  https://api.qoder.com.cn/  ", "https://api.qoder.com.cn"],
    ["https://api.qoder.com/api/v1/cloud/", "https://api.qoder.com"],
  ])("normalizes %j", (raw, expected) => {
    expect(normalizeQoderApiBaseUrl(raw, "https://api.qoder.com")).toBe(expected);
  });
});

describe("createQoderClient", () => {
  it("turns the Qoder error envelope into a typed error", async () => {
    const client = createQoderClient({
      apiBaseUrl: "https://api.qoder.com",
      token: "pt-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        type: "error",
        request_id: "req-9",
        error: { type: "not_found_error", message: "Session 'sess_x' was not found." },
      }), { status: 404 }),
    });
    const error = await client.getSession("sess_x").catch((err) => err);
    expect(error).toBeInstanceOf(QoderApiError);
    expect(error).toMatchObject({
      status: 404,
      errorType: "not_found_error",
      requestId: "req-9",
      message: "Session 'sess_x' was not found.",
    });
  });

  it("falls back to the HTTP status when the error body is not the Qoder envelope", async () => {
    const client = createQoderClient({
      apiBaseUrl: "https://api.qoder.com",
      token: "pt-secret",
      fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 502 }),
    });
    await expect(client.listModels()).rejects.toThrow("Qoder API request failed with HTTP 502");
  });

  it("sends bearer auth and a JSON body, and escapes path IDs", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const client = createQoderClient({
      apiBaseUrl: "https://api.qoder.com",
      token: "pt-secret",
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ data: [{ id: "evt_1" }, "junk"] }), { status: 200 });
      },
    });
    const events = await client.sendEvents("sess/../x", [{ type: "user.interrupt" }]);
    expect(events).toEqual([{ id: "evt_1" }]);
    expect(seen[0].url).toBe("https://api.qoder.com/api/v1/cloud/sessions/sess%2F..%2Fx/events");
    expect(seen[0].init?.headers).toMatchObject({
      Authorization: "Bearer pt-secret",
      "Content-Type": "application/json",
    });
    expect(seen[0].init?.body).toBe('{"events":[{"type":"user.interrupt"}]}');
  });
});
