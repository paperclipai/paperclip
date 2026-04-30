import { describe, it, expect } from "vitest";
import {
  shouldNotify,
  buildSummary,
  computeContentHash,
} from "../services/routine-checks/notify.ts";

describe("shouldNotify", () => {
  it("silent + stable ok → no notify", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("silent + first-run warn → no notify (no recovery context)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "warn", previousStatus: null, findings: 1 })).toBe(false);
  });

  it("silent + state-change error→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "error", findings: 0 })).toBe(true);
  });

  it("silent + state-change warn→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });

  it("silent + state-change ok→warn → no notify", () => {
    expect(shouldNotify({ channel: "silent", currentStatus: "warn", previousStatus: "ok", findings: 1 })).toBe(false);
  });

  it("threshold(warn) + warn (state-change) → notify", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "warn", previousStatus: "ok", findings: 1 })).toBe(true);
  });

  it("threshold(warn) + ok stable → no notify", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("threshold(warn) + state-change warn→ok → notify (recovery)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "warn", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });

  it("threshold(error) + warn → no notify (below severity)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "error", currentStatus: "warn", previousStatus: "warn", findings: 1 })).toBe(false);
  });

  it("threshold(error) + error stable → notify (meets severity)", () => {
    expect(shouldNotify({ channel: "threshold", thresholdSeverity: "error", currentStatus: "error", previousStatus: "error", findings: 0 })).toBe(true);
  });

  it("telegram + findings=0 stable → no notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "ok", previousStatus: "ok", findings: 0 })).toBe(false);
  });

  it("telegram + findings>0 → notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "warn", previousStatus: "warn", findings: 5 })).toBe(true);
  });

  it("telegram + findings=0 with state-change → notify", () => {
    expect(shouldNotify({ channel: "telegram", currentStatus: "ok", previousStatus: "warn", findings: 0 })).toBe(true);
  });
});

describe("buildSummary", () => {
  it("prefixes recovery on warn→ok", () => {
    expect(buildSummary({ original: "all clean", previousStatus: "warn", currentStatus: "ok" })).toBe("✅ recovery — all clean");
  });

  it("prefixes recovery on error→ok", () => {
    expect(buildSummary({ original: "restored", previousStatus: "error", currentStatus: "ok" })).toBe("✅ recovery — restored");
  });

  it("passes through on stable warn", () => {
    expect(buildSummary({ original: "3 drift", previousStatus: "warn", currentStatus: "warn" })).toBe("3 drift");
  });

  it("passes through on first-run", () => {
    expect(buildSummary({ original: "hello", previousStatus: null, currentStatus: "ok" })).toBe("hello");
  });

  it("passes through on first-run warn", () => {
    expect(buildSummary({ original: "hello", previousStatus: null, currentStatus: "warn" })).toBe("hello");
  });
});

describe("computeContentHash", () => {
  it("returns deterministic sha256 prefix", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[0-9a-f]{32}$/);
  });

  it("changes when examples change", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["b"] });
    expect(a).not.toBe(b);
  });

  it("uses only top-3 examples", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c"] });
    const b = computeContentHash({ summary: "x", findings: 1, examples: ["a", "b", "c", "d", "e"] });
    expect(a).toBe(b);
  });

  it("changes when findings change", () => {
    const a = computeContentHash({ summary: "x", findings: 1, examples: [] });
    const b = computeContentHash({ summary: "x", findings: 2, examples: [] });
    expect(a).not.toBe(b);
  });

  it("changes when summary changes", () => {
    const a = computeContentHash({ summary: "x", findings: 0, examples: [] });
    const b = computeContentHash({ summary: "y", findings: 0, examples: [] });
    expect(a).not.toBe(b);
  });
});

import { postWebhook, type WebhookPayload } from "../services/routine-checks/notify.ts";

const samplePayload = (): WebhookPayload => ({
  check: "demo",
  status: "warn",
  previous_status: "ok",
  findings: 1,
  summary: "x",
  content_hash: "sha256-abc",
  scheduled_for: "2026-04-30T09:00:00Z",
  details_hint: "paperclip checks history demo --limit 1",
});

describe("postWebhook", () => {
  it("POSTs payload with bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    };
    const ok = await postWebhook({ url: "http://localhost:9999/x", token: "secret", payload: samplePayload(), fetcher });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.check).toBe("demo");
    expect(body.findings).toBe(1);
    expect(body.status).toBe("warn");
    expect(body.previous_status).toBe("ok");
    expect(body.summary).toBe("x");
    expect(body.content_hash).toBe("sha256-abc");
    expect(body.scheduled_for).toBe("2026-04-30T09:00:00Z");
    expect(body.details_hint).toBe("paperclip checks history demo --limit 1");
  });

  it("logs warn on non-2xx response", async () => {
    const logs: any[] = [];
    const logger = {
      info: () => {},
      warn: (obj: object | string, msg?: string) => logs.push({ level: "warn", obj, msg }),
      error: () => {},
    };
    const fetcher: typeof fetch = async () => new Response("nope", { status: 401 });
    await postWebhook({ url: "http://x", token: "t", payload: samplePayload(), fetcher, logger });
    expect(logs.some((l) => l.level === "warn" && (l.obj as any).status === 401)).toBe(true);
  });

  it("logs error on network failure", async () => {
    const logs: any[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (obj: object | string, msg?: string) => logs.push({ level: "error", obj, msg }),
    };
    const fetcher: typeof fetch = async () => { throw new Error("connect refused"); };
    await postWebhook({ url: "http://x", token: "t", payload: samplePayload(), fetcher, logger });
    expect(logs.some((l) => l.level === "error" && String((l.obj as any).err).includes("connect refused"))).toBe(true);
  });

  it("returns false on non-2xx", async () => {
    const fetcher: typeof fetch = async () => new Response("nope", { status: 401 });
    const ok = await postWebhook({ url: "http://x", token: "t", payload: samplePayload(), fetcher });
    expect(ok).toBe(false);
  });

  it("returns false on network error", async () => {
    const fetcher: typeof fetch = async () => { throw new Error("connect refused"); };
    const ok = await postWebhook({ url: "http://x", token: "t", payload: samplePayload(), fetcher });
    expect(ok).toBe(false);
  });

  it("uses global fetch when fetcher omitted (smoke)", async () => {
    const original = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (url: any) => {
      calledUrl = String(url);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const ok = await postWebhook({ url: "http://example.invalid/x", token: "t", payload: samplePayload() });
      expect(ok).toBe(true);
      expect(calledUrl).toBe("http://example.invalid/x");
    } finally {
      globalThis.fetch = original;
    }
  });
});
