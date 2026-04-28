import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("turns fetch failures into actionable connection errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api.get("/companies")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "Paperclip couldn't reach the API. Check your connection, then verify the dashboard is pointed at the right URL (PAPERCLIP_API_URL).",
    });
  });

  it("preserves server error messages when a response is returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: vi.fn().mockResolvedValue({ error: "Service unavailable" }),
      }),
    );

    const request = api.get("/companies");
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      message: "Service unavailable",
      status: 503,
    });
  });
});
