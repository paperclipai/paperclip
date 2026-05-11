import { describe, it, expect, vi } from "vitest";
import { sendPushover } from "../src/pushover-client.js";

function makeCtx(fetchImpl: (url: string, opts: any) => Promise<Response>) {
  return {
    http: { fetch: vi.fn(fetchImpl) },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as any;
}

describe("sendPushover", () => {
  it("POSTs the expected form-encoded payload to api.pushover.net", async () => {
    const ctx = makeCtx(async () => new Response("{}", { status: 200 }));

    const res = await sendPushover(ctx, {
      userKey: "u-key",
      appToken: "a-token",
      title: "[WHI] CEO erledigt: Cleanup",
      message: "issue body…",
      url: "https://company.whitestag.ai/WHI/issues/WHI-1",
      urlTitle: "In Paperclip öffnen",
      priority: 0,
    });

    expect(res).toEqual({ ok: true, status: 200 });
    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = ctx.http.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.pushover.net/1/messages.json");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("token")).toBe("a-token");
    expect(body.get("user")).toBe("u-key");
    expect(body.get("title")).toBe("[WHI] CEO erledigt: Cleanup");
    expect(body.get("priority")).toBe("0");
  });

  it("returns ok:false on non-2xx and logs a warning", async () => {
    const ctx = makeCtx(async () => new Response("nope", { status: 401 }));

    const res = await sendPushover(ctx, {
      userKey: "u",
      appToken: "t",
      title: "x",
      message: "y",
      url: "https://example.com",
      urlTitle: "open",
      priority: 0,
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "pushover_send_failed",
      expect.objectContaining({ status: 401 }),
    );
  });
});
