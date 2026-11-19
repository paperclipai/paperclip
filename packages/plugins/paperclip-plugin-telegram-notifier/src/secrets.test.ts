import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JOB_KEYS } from "./constants.js";
import { outboundQueueSettings } from "./outbound-queue.js";
import {
  BOT_TOKEN_SECRET_REQUIRED_MESSAGE,
  BOT_TOKEN_UNRESOLVED_MESSAGE,
} from "./telegram-client.js";
import { pair, REF_A, setup, TOKEN_A } from "./test-helpers.js";
import { applyConfigPatch, botTokenSecretPatch, withoutLiteralToken } from "./ui/index.js";
import plugin from "./worker.js";

const DEFAULT_QUEUE_SETTINGS = { ...outboundQueueSettings };

afterEach(() => {
  vi.useRealTimers();
  Object.assign(outboundQueueSettings, DEFAULT_QUEUE_SETTINGS);
});

describe("bot token as a secret reference", () => {
  // Fake literal token in the shape a real one has; it must never be used,
  // echoed or shown.
  const LITERAL = "333333:TEST_FAKE_TOKEN_CCCCCCCCCCCCCCCCCCCC";
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return text.includes("TEST_FAKE_TOKEN") || text.includes("CCCC");
  };

  it("rejects a literal token in config validation without echoing it", async () => {
    const result = await plugin.definition.onValidateConfig!({ botToken: LITERAL });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([BOT_TOKEN_SECRET_REQUIRED_MESSAGE]);
    expect(leaks(result)).toBe(false);
    expect(await plugin.definition.onValidateConfig!({ botToken: REF_A })).toEqual({ ok: true });
  });

  it("refuses to poll or send with a literal token saved earlier", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls } = await setup({ "company-a": { botToken: LITERAL } });
    await pair(harness, "company-a", "100");

    await harness.runJob(JOB_KEYS.pollUpdates);
    await expect(
      harness.performAction("startPairing", {}, { companyId: "company-a" }),
    ).rejects.toThrow(BOT_TOKEN_SECRET_REQUIRED_MESSAGE);

    expect(calls).toEqual([]);
    expect(harness.logs.some((l) => l.message.includes(BOT_TOKEN_SECRET_REQUIRED_MESSAGE))).toBe(true);
    expect(leaks(harness.logs)).toBe(false);
  });

  it("resolves the secret reference for the company and gives the client the token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, secretResolves } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");

    await harness.runJob(JOB_KEYS.pollUpdates);

    expect(secretResolves).toContainEqual({ secretRef: REF_A, companyId: "company-a" });
    expect(calls.some((c) => c.botId === "111111" && c.method === "getUpdates")).toBe(true);
  });

  it("keeps a literal token out of the status payload the settings page reads", async () => {
    const { harness } = await setup({ "company-a": { botToken: LITERAL } });
    const status = await harness.getData<Record<string, unknown>>("status", {
      companyId: "company-a",
    });
    expect(status.tokenConfigured).toBe(false);
    expect(status.tokenError).toBe(BOT_TOKEN_SECRET_REQUIRED_MESSAGE);
    expect(leaks(status)).toBe(false);
  });

  it("drops a literal token from the config the settings page loads and saves", () => {
    const stored = { botToken: LITERAL as unknown, silent: true };
    const loaded = withoutLiteralToken(stored);
    expect(leaks(loaded)).toBe(false);
    const saved = applyConfigPatch(loaded, botTokenSecretPatch(REF_A.secretId));
    expect(saved).toEqual({ botToken: REF_A, silent: true });
    expect(leaks(saved)).toBe(false);
  });
});


describe("outbound queue and secret resolution", () => {
  const runFailed = (harness: TestHarness, reason = "boom") =>
    harness.emit(
      "agent.run.failed",
      { runId: "run-1", agentId: "agent-1", error: reason },
      { companyId: "company-a", entityId: "run-1", entityType: "heartbeat_run" },
    );
  const rateLimited = () => {
    const err = new Error("Rate limit exceeded for secret resolution");
    err.name = "RateLimitExceededError";
    return err;
  };
  const sends = (calls: Array<{ method: string }>) =>
    calls.filter((c) => c.method === "sendMessage");
  // Lets queued handlers reach the queue while timers are faked.
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("resolves once per drain for a burst and again for a later event", async () => {
    const { harness, calls, secretResolves } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");

    await Promise.all(Array.from({ length: 5 }, () => runFailed(harness)));
    expect(secretResolves).toHaveLength(1);
    expect(sends(calls)).toHaveLength(5);

    await runFailed(harness);
    expect(secretResolves).toHaveLength(2);
    expect(sends(calls)).toHaveLength(6);
  });

  it("keeps rate-limited items queued and delivers them after backoff", async () => {
    fakeTimers();
    const { harness, calls, secretResolves } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    let attempts = 0;
    harness.ctx.secrets.resolve = async (secretRef, opts) => {
      secretResolves.push({ secretRef, companyId: opts?.companyId });
      attempts += 1;
      if (attempts <= 2) throw rateLimited();
      return TOKEN_A;
    };

    const delivered = Promise.all([runFailed(harness), runFailed(harness), runFailed(harness)]);
    await settle();
    expect(attempts).toBe(1);
    expect(sends(calls)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toBe(2);
    expect(sends(calls)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(4_000);
    await delivered;
    expect(attempts).toBe(3);
    expect(sends(calls)).toHaveLength(3);
  });

  it("sends nothing and reports tokenError when the secret is deleted, queued items included", async () => {
    fakeTimers();
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    let deleted = false;
    harness.ctx.secrets.resolve = async () => {
      if (deleted) throw new Error("Secret not found");
      throw rateLimited();
    };

    const queued = Promise.all([runFailed(harness), runFailed(harness)]);
    await settle();
    deleted = true;
    await vi.advanceTimersByTimeAsync(2_000);
    await queued;
    await runFailed(harness);

    expect(sends(calls)).toHaveLength(0);
    vi.useRealTimers();
    const status = await harness.getData<Record<string, unknown>>("status", {
      companyId: "company-a",
    });
    expect(status.tokenError).toBe(BOT_TOKEN_UNRESOLVED_MESSAGE);
    expect(JSON.stringify(harness.logs)).not.toContain(TOKEN_A);
  });

  it("drops the oldest items when the queue overflows and logs only a count", async () => {
    fakeTimers();
    outboundQueueSettings.maxItems = 3;
    const { harness, calls } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");
    let attempts = 0;
    harness.ctx.secrets.resolve = async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimited();
      return TOKEN_A;
    };

    const all = Promise.all([1, 2, 3, 4, 5].map((n) => runFailed(harness, `boom${n}`)));
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    await all;

    expect(sends(calls).map((c) => String((c as { body?: { text?: unknown } }).body?.text))).toEqual([
      expect.stringContaining("boom3"),
      expect.stringContaining("boom4"),
      expect.stringContaining("boom5"),
    ]);
    const dropLog = harness.logs.find((l) => l.message.includes("dropped oldest"));
    expect(dropLog?.meta).toMatchObject({ companyId: "company-a", dropped: 2 });
    expect(JSON.stringify(harness.logs)).not.toMatch(/boom1|boom2|AAAA/);
  });
});

describe("long polling and secret resolution", () => {
  it("resolves the secret again for each getUpdates call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { harness, calls, secretResolves } = await setup({ "company-a": { botToken: REF_A } });
    await pair(harness, "company-a", "100");

    // The first run also resolves once to cache the bot username.
    await harness.runJob(JOB_KEYS.pollUpdates);
    const before = secretResolves.length;
    calls.length = 0;
    await harness.runJob(JOB_KEYS.pollUpdates);

    const polls = calls.filter((c) => c.method === "getUpdates");
    expect(polls.length).toBeGreaterThan(0);
    // One resolution to group the company by bot, one per getUpdates call.
    expect(secretResolves.length - before).toBe(1 + polls.length);
  });
});
