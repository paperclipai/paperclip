import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";
import { authApi } from "./auth";
import { healthApi } from "./health";
import { ApiUnavailableError, isTemporaryApiError, readApiJson } from "./response";

afterEach(() => vi.unstubAllGlobals());

describe("API responses during a restart", () => {
  it.each([200, 502, 503, 504])("handles HTML with status %i on every startup API", async (status) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response("<!doctype html><h1>Restarting</h1>", {
      status,
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    for (const read of [healthApi.get, authApi.getSession, () => api.get("/cli-auth/me")]) {
      await expect(read()).rejects.toMatchObject({
        name: "ApiUnavailableError",
        message: "Paperclip is temporarily unavailable. Please try again in a moment.",
        status,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the gateway's Retry-After on an HTML 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<!doctype html>", {
      status: 503,
      headers: { "Content-Type": "text/html", "Retry-After": "20" },
    })));
    await expect(api.get("/companies")).rejects.toMatchObject({ name: "ApiUnavailableError", retryAfterMs: 20_000 });
  });

  it("does not replay a mutation after an HTML response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<!doctype html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.post("/issues", { title: "Save once" })).rejects.toBeInstanceOf(ApiUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves empty mutation successes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(api.delete("/issues/example")).resolves.toBeUndefined();
  });

  it("preserves valid startup health metadata for sign-in and invitations", async () => {
    const payload = {
      status: "starting",
      deploymentMode: "authenticated",
      cloud: { managed: true, managedBy: "paperclip-cloud", stackSlug: "example", cloudBaseUrl: "https://example.com" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(healthApi.get()).resolves.toEqual(payload);
  });

  it.each([null, {}, { status: "unhealthy" }])("rejects an unusable health payload: %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(healthApi.get()).rejects.toBeInstanceOf(ApiUnavailableError);
  });

  it.each([healthApi.get, authApi.getSession, () => api.get("/cli-auth/me")])(
    "retains the status of JSON gateway errors for retry classification",
    async (read) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Service unavailable" }, { status: 503 })));
      const error = await read().catch((error: unknown) => error);
      expect(isTemporaryApiError(error)).toBe(true);
    },
  );

  it("preserves HTTP denials with or without JSON", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "Access denied" }, { status: 403 })));
    await expect(api.get("/denied")).rejects.toMatchObject({ name: "ApiError", status: 403 });
    await expect(api.get("/denied")).rejects.toMatchObject({ message: "Access denied", status: 403 });
  });

  it("does not swallow an aborted response body", async () => {
    const error = new DOMException("Aborted", "AbortError");
    const response = new Response();
    vi.spyOn(response, "json").mockRejectedValue(error);
    await expect(readApiJson(response)).rejects.toBe(error);
  });

  it.each(["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"])(
    "recognizes the browser network failure: %s", (message) => {
      expect(isTemporaryApiError(new TypeError(message))).toBe(true);
    },
  );

  it.each([
    new ApiError("Unauthorized", 401, null),
    new ApiError("Forbidden", 403, null),
    new ApiError("Not found", 404, null),
    new ApiError("Internal error", 500, null),
    new TypeError("Cannot read properties of undefined"),
    new DOMException("Aborted", "AbortError"),
  ])("does not automatically retry non-transport errors: %s", (error) => {
    expect(isTemporaryApiError(error)).toBe(false);
  });
});
