import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { devRunnerApi } from "./devRunner";

describe("devRunnerApi.restart", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("prefers the backend restart route when it is available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      return new Response(JSON.stringify({ accepted: true, requestId: "req-1" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("window", {
      location: {
        origin: "http://127.0.0.1:3102",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(devRunnerApi.restart()).resolves.toMatchObject({ accepted: true, requestId: "req-1" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/instance/dev-server/restart",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("falls back to the derived runner control port when the backend route is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "API route not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true, requestId: "req-2" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3102",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(devRunnerApi.restart()).resolves.toMatchObject({ accepted: true, requestId: "req-2" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/instance/dev-server/restart",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:23103/restart",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "text/plain;charset=UTF-8",
        }),
        body: "",
      }),
    );
  });

  it("falls back to the derived runner control port when the backend child is unreachable", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true, requestId: "req-3" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("window", {
      location: {
        origin: "http://127.0.0.1:3102",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(devRunnerApi.restart()).resolves.toMatchObject({ accepted: true, requestId: "req-3" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/instance/dev-server/restart",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:23103/restart",
      expect.objectContaining({
        method: "POST",
        body: "",
      }),
    );
  });

  it("surfaces the backend route error when restart is forbidden", async () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://localhost:3102",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(devRunnerApi.restart()).rejects.toEqual(
      expect.objectContaining<ApiError>({
        message: "Origin not allowed",
        status: 403,
        name: "ApiError",
        body: { error: "Origin not allowed" },
      }),
    );
  });
});
