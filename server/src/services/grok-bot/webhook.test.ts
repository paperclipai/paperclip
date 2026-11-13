import { afterEach, describe, expect, it, vi } from "vitest";
import { guardedRemoteHttpFetch } from "../remote-http-fetch.js";
import { deliverGrokRoutineWake, type GrokRoutineWake } from "./webhook.js";

vi.mock("../remote-http-fetch.js", () => ({ guardedRemoteHttpFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const secret = { webhookUrl: "https://bot.example.test/routines/synthetic/trigger", webhookKey: "qualification-only-secret" };
const wake: GrokRoutineWake = { schema: "paperclip.external_bot_wake.v1", kind: "verify",
  bindingId: "12345678-1234-4234-8234-123456789012", bindingGeneration: 1,
  correlationId: "87654321-1234-4234-8234-123456789012", challenge: "a-unique-challenge-for-mcp" };

describe("Grok routine delivery", () => {
  it("uses the public, DNS-pinned transport and sends only closed references", async () => {
    vi.mocked(guardedRemoteHttpFetch).mockResolvedValue(new Response("provider body", { status: 200 }));
    expect(await deliverGrokRoutineWake(secret, wake)).toEqual({ delivery: "accepted", httpStatus: 200 });
    const [url, init, options] = vi.mocked(guardedRemoteHttpFetch).mock.calls[0]!;
    expect(url).toBe(secret.webhookUrl);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
      Authorization: `Bearer ${secret.webhookKey}`, "Content-Type": "application/json",
    } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(options).toMatchObject({ allowPrivateNetwork: false, connectTimeoutMs: 5000, responseTimeoutMs: 10000 });
    expect(JSON.parse(String(init.body))).toEqual(wake);
    expect(String(init.body)).not.toContain(secret.webhookKey);
  });

  it.each([201, 202, 204, 301, 302, 307, 408, 500, 502, 504])("holds ambiguous HTTP %s without retry or response-body disclosure", async status => {
    const response = new Response([204].includes(status) ? null : secret.webhookKey, { status });
    const fetcher = vi.fn().mockResolvedValue(response);
    expect(await deliverGrokRoutineWake(secret, wake, fetcher)).toEqual({ delivery: "unknown", httpStatus: status });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(response.body?.locked ?? false).toBe(false);
  });

  it.each([400, 401, 403, 404, 409, 422, 429])("records HTTP %s rejection without retry", async status => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
    expect(await deliverGrokRoutineWake(secret, wake, fetcher)).toEqual({ delivery: "rejected", httpStatus: status });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown delivery after a lost response and removes credential-bearing errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`${secret.webhookUrl} ${secret.webhookKey}`));
    const outcome = await deliverGrokRoutineWake(secret, wake, fetcher);
    expect(outcome).toEqual({ delivery: "unknown", httpStatus: null });
    expect(JSON.stringify(outcome)).not.toContain(secret.webhookKey);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://bot.example.test/trigger", "https://user:password@bot.example.test/trigger",
    "https://bot.example.test/trigger#fragment", "https://bot.example.test/trigger?key=secret",
  ])("rejects unsafe credential URLs before network activity: %s", async webhookUrl => {
    const fetcher = vi.fn();
    expect(await deliverGrokRoutineWake({ ...secret, webhookUrl }, wake, fetcher)).toEqual({ delivery: "rejected", httpStatus: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["key\r\nX-Other: injected", "key\u0000", "key with spaces", " "])("rejects malformed bearer keys before transmission", async webhookKey => {
    const fetcher = vi.fn();
    expect(await deliverGrokRoutineWake({ ...secret, webhookKey }, wake, fetcher)).toEqual({ delivery: "rejected", httpStatus: null });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects extra task contents before transmission", async () => {
    const fetcher = vi.fn();
    expect((await deliverGrokRoutineWake(secret, { ...wake, taskPrompt: "private task contents" } as GrokRoutineWake, fetcher)).delivery).toBe("rejected");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards the response body without downgrading documented acceptance when cleanup fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error(secret.webhookKey));
    const fetcher = vi.fn().mockResolvedValue({ status: 200, body: { cancel } });
    expect(await deliverGrokRoutineWake(secret, wake, fetcher)).toEqual({ delivery: "accepted", httpStatus: 200 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

it.each([undefined, null, 12, {}, { webhookUrl: "not a URL", webhookKey: "key" }, { webhookUrl: secret.webhookUrl }])("rejects malformed persisted credential data without transmission", async malformed => {
  const fetcher = vi.fn();
  expect(await deliverGrokRoutineWake(malformed as typeof secret, wake, fetcher)).toEqual({ delivery: "rejected", httpStatus: null });
  expect(fetcher).not.toHaveBeenCalled();
});
