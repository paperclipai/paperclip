import { afterEach, describe, expect, it, vi } from "vitest";
import { probePaperclipHealth } from "../utils/net.js";

describe("probePaperclipHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes loopback when configured host is 0.0.0.0", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probePaperclipHealth("0.0.0.0", 3100);

    expect(result).toEqual({
      healthy: true,
      url: "http://127.0.0.1:3100/api/health",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to loopback when the configured host probe fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await probePaperclipHealth("paperclip.internal", 3100);

    expect(result).toEqual({
      healthy: true,
      url: "http://127.0.0.1:3100/api/health",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
