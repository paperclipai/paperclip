import { describe, it, expect, vi } from "vitest";
import { sendPushover, sendGlance } from "../src/pushover-client.js";

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

describe("sendGlance", () => {
  it("POSTs the expected form-encoded payload to api.pushover.net/1/glances.json", async () => {
    const ctx = makeCtx(async () => new Response("{}", { status: 200 }));

    const res = await sendGlance(ctx, {
      userKey: "u-key",
      appToken: "a-token",
      title: "[WHI] CEO erledigt",
      text: "Cleanup database",
      subtext: "WHI-42",
    });

    expect(res).toEqual({ ok: true, status: 200 });
    expect(ctx.http.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = ctx.http.fetch.mock.calls[0];
    expect(calledUrl).toBe("https://api.pushover.net/1/glances.json");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(opts.body as string);
    expect(body.get("token")).toBe("a-token");
    expect(body.get("user")).toBe("u-key");
    expect(body.get("title")).toBe("[WHI] CEO erledigt");
    expect(body.get("text")).toBe("Cleanup database");
    expect(body.get("subtext")).toBe("WHI-42");
  });

  it("truncates title/text/subtext to Pushover's 100-char limit", async () => {
    const ctx = makeCtx(async () => new Response("{}", { status: 200 }));
    const longTitle = "T".repeat(150);
    const longText = "X".repeat(150);

    await sendGlance(ctx, {
      userKey: "u",
      appToken: "t",
      title: longTitle,
      text: longText,
      subtext: "ok",
    });

    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body as string);
    expect(body.get("title")!.length).toBe(100);
    expect(body.get("text")!.length).toBe(100);
  });

  it("omits empty fields so Pushover doesn't reject the call", async () => {
    const ctx = makeCtx(async () => new Response("{}", { status: 200 }));

    await sendGlance(ctx, {
      userKey: "u",
      appToken: "t",
      title: "only-title",
    });

    const body = new URLSearchParams(ctx.http.fetch.mock.calls[0][1].body as string);
    expect(body.has("text")).toBe(false);
    expect(body.has("subtext")).toBe(false);
  });

  it("returns ok:false on non-2xx and logs a warning", async () => {
    const ctx = makeCtx(async () => new Response("err", { status: 400 }));

    const res = await sendGlance(ctx, {
      userKey: "u",
      appToken: "t",
      title: "x",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "pushover_glance_failed",
      expect.objectContaining({ status: 400 }),
    );
  });
});
