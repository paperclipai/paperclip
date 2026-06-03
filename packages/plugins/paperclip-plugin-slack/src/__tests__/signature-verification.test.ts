import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../worker.js";
import { WEBHOOK_KEYS } from "../constants.js";

// NOTE: `verifySlackSignature` is module-private, so these tests drive it
// through the public `onWebhook` seam and assert on the structured rejection
// log. The worker keeps module-level mutable state: `slackSigningSecret` (reset
// by setup() each test) and the throttle counters `lastSigWarnAt` /
// `suppressedSigWarns`. The throttle keys off `Date.now()` and only emits once
// per 5s window, so we use fake timers and advance >5s before each test to give
// every case a fresh window. `nowTs()` and `sign()` read the same mocked clock,
// so replay-window math stays consistent.

beforeEach(() => {
  vi.useFakeTimers();
  // Start well past epoch and step the clock forward each test so the
  // module-level throttle window (5s) is always clear at the start of a test.
  vi.setSystemTime(new Date("2026-06-02T00:00:00Z").getTime() + nextTick());
});

afterEach(() => {
  vi.useRealTimers();
});

let tick = 0;
// Each call returns a fresh +10s offset so successive tests land in distinct
// throttle windows even though state persists across tests.
function nextTick(): number {
  tick += 10_000;
  return tick;
}

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz1234";
const SIGNING_REF = "secret:slack-signing";
const REJECT_MSG = "Rejected webhook: invalid Slack signature";

function makeContext(configOverrides: Record<string, unknown> = {}) {
  const config = {
    slackTokenRef: "secret:slack-token",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: true,
    ...configOverrides,
  };
  return {
    ctx: {
      config: { get: vi.fn(async () => config) },
      // Resolve the signing secret for the signing ref; a token otherwise
      // (setup() resolves the token ref first, then the signing ref).
      secrets: {
        resolve: vi.fn(
          async (ref: string): Promise<string> =>
            ref === SIGNING_REF ? SIGNING_SECRET : "xoxb-test",
        ),
      },
      companies: { list: vi.fn(async () => [{ id: "fallback-company" }]) },
      issues: { list: vi.fn(async () => []) },
      agents: { list: vi.fn(async () => []) },
      events: { on: vi.fn(), emit: vi.fn(async () => undefined) },
      state: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      metrics: { write: vi.fn(async () => undefined) },
      activity: { log: vi.fn(async () => undefined) },
      tools: { register: vi.fn() },
      webhooks: { register: vi.fn() },
      data: { register: vi.fn() },
      actions: { register: vi.fn() },
      jobs: { register: vi.fn() },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      http: {
        fetch: vi.fn(async () => ({ status: 200, json: async () => ({ ok: true }) })),
      },
      rpc: { call: vi.fn(async () => ({})) },
    },
  };
}

function sign(secret: string, ts: string, rawBody: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex");
}

function nowTs(offsetSeconds = 0): string {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/** Fire one webhook through the public seam with the slashCommand endpoint and
 *  an unrecognized body (so a *passing* signature no-ops harmlessly downstream). */
async function fireWebhook(
  ctx: unknown,
  headers: Record<string, string>,
  rawBody: string,
) {
  await plugin.definition.onWebhook?.({
    endpointKey: WEBHOOK_KEYS.slashCommand,
    headers,
    rawBody,
    parsedBody: { type: "x" },
    requestId: "req-test-1",
  } as any);
}

/** Find the structured rejection log call (message + meta) if it fired. */
function rejectionCall(ctx: any): [string, Record<string, unknown>] | undefined {
  return ctx.logger.warn.mock.calls.find((c: unknown[]) => c[0] === REJECT_MSG) as
    | [string, Record<string, unknown>]
    | undefined;
}

describe("Slack signature verification diagnostics", () => {
  it("accepts a valid signature without a rejection log", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    const rawBody = "command=/x&text=hello";
    await fireWebhook(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(SIGNING_SECRET, ts, rawBody),
    }, rawBody);

    expect(rejectionCall(ctx)).toBeUndefined();
  });

  it("logs reason=missing_headers when signature headers are absent", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    await fireWebhook(ctx, {}, "command=/x");

    const call = rejectionCall(ctx);
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      reason: "missing_headers",
      hasTimestamp: false,
      hasSignature: false,
      endpointKey: WEBHOOK_KEYS.slashCommand,
      requestId: "req-test-1",
    });
  });

  it("logs reason=stale_timestamp with signed skew when the request is old", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs(-600); // 10 minutes in the past
    const rawBody = "command=/x";
    await fireWebhook(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(SIGNING_SECRET, ts, rawBody),
    }, rawBody);

    const call = rejectionCall(ctx);
    expect(call).toBeDefined();
    expect(call![1].reason).toBe("stale_timestamp");
    expect(typeof call![1].skewSeconds).toBe("number");
    expect(call![1].skewSeconds as number).toBeGreaterThanOrEqual(300);
  });

  it("logs reason=hmac_mismatch with a body fingerprint when the body is tampered", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    const rawBody = "command=/x&text=hello";
    const sig = sign(SIGNING_SECRET, ts, rawBody);
    // Same length class; sign over rawBody but deliver rawBody + "X" so the
    // length check passes and we fall through to the HMAC comparison.
    await fireWebhook(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    }, rawBody + "X");

    const call = rejectionCall(ctx);
    expect(call).toBeDefined();
    expect(call![1].reason).toBe("hmac_mismatch");
    expect(call![1].sigPrefix).toBe(sig.slice(0, 8));
    expect(call![1].bodyFp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("logs reason=length_mismatch when the signature is the wrong length", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    const received = "v0=deadbeef"; // 11 chars; valid sig is 67
    await fireWebhook(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": received,
    }, "command=/x");

    const call = rejectionCall(ctx);
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      reason: "length_mismatch",
      expectedLen: 67,
      receivedLen: received.length,
    });
  });

  it("skips verification (no rejection log) when no signing secret is configured", async () => {
    // Force the resolved signing secret to empty (falsy) so the skip path runs
    // deterministically regardless of module-level state left by prior tests
    // (the worker only assigns `slackSigningSecret` when the ref resolves, and
    // never clears a previously cached value).
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    ctx.secrets.resolve = vi.fn(
      async (ref: string): Promise<string> => (ref === SIGNING_REF ? "" : "xoxb-test"),
    );
    await plugin.definition.setup?.(ctx as any);

    await fireWebhook(ctx, {}, "command=/x");

    expect(rejectionCall(ctx)).toBeUndefined();
  });

  // Must run LAST: throttle counters are module-level and persist across tests.
  it("throttles repeated rejections to one warn per window", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    await fireWebhook(ctx, {}, "command=/x");
    await fireWebhook(ctx, {}, "command=/x");

    const rejectionWarns = ctx.logger.warn.mock.calls.filter(
      (c: unknown[]) => c[0] === REJECT_MSG,
    );
    expect(rejectionWarns).toHaveLength(1);
  });
});

// Slack interactivity (Block Kit button clicks) arrives as
// application/x-www-form-urlencoded: rawBody = `payload=<urlencoded-json>`,
// parsedBody = { payload: "<json>" }. The API->worker proxy used to
// JSON.stringify(req.body), so the worker verified HMAC over "{}" and the
// signature NEVER matched -> button dead. These tests prove the interactivity
// endpoint verifies the signature over the real rawBody (so the fix's
// raw-byte forwarding makes buttons work) and rejects a tampered body.
describe("Slack interactivity signature verification", () => {
  // A real block_actions payload (approve button). The urlencoded form body is
  // the exact bytes Slack signs.
  const INTERACTIVITY_JSON = JSON.stringify({
    type: "block_actions",
    user: { id: "U_TEST" },
    response_url: "https://hooks.slack.test/r",
    actions: [{ action_id: "approval_approve", value: "appr-1" }],
  });
  const INTERACTIVITY_RAW = `payload=${encodeURIComponent(INTERACTIVITY_JSON)}`;

  async function fireInteractivity(
    ctx: unknown,
    headers: Record<string, string>,
    rawBody: string,
  ) {
    await plugin.definition.onWebhook?.({
      endpointKey: WEBHOOK_KEYS.interactivity,
      headers,
      rawBody,
      // What express.urlencoded produces from the form body.
      parsedBody: { payload: INTERACTIVITY_JSON },
      requestId: "req-interactivity-1",
    } as any);
  }

  it("accepts a correctly-signed interactivity payload (no rejection over the real rawBody)", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    await fireInteractivity(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(SIGNING_SECRET, ts, INTERACTIVITY_RAW),
    }, INTERACTIVITY_RAW);

    // Signature verifies over the form bytes — the previously-dead path is live.
    expect(rejectionCall(ctx)).toBeUndefined();
  });

  it("rejects an interactivity payload signed over '{}' instead of the real form body (the bug)", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    // Simulate the OLD proxy behavior: Slack signed the form body, but the
    // worker received "{}". Sign over the real body, deliver rawBody="{}".
    await fireInteractivity(ctx, {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(SIGNING_SECRET, ts, INTERACTIVITY_RAW),
    }, "{}");

    const call = rejectionCall(ctx);
    expect(call).toBeDefined();
    expect(call![1].reason).toBe("hmac_mismatch");
    // Ground-truth from prod: the worker saw the literal 2-byte "{}" —
    // sha256("{}").slice(0,12). This is the exact bodyFp logged in the incident.
    expect(call![1].bodyFp).toBe(
      createHash("sha256").update("{}").digest("hex").slice(0, 12),
    );
  });
});

// Proves the corruption MECHANISM on a concrete JSON payload: a Slack JSON body
// whose bytes are NOT reproduced by JSON.stringify(JSON.parse(x)) (here, a
// \u-escaped sequence) verifies over the original rawBody but would fail if the
// proxy re-serialized it. This is why forwarding raw bytes (not req.body) is
// required for the rich-message event class too — not just interactivity.
describe("Slack rich-JSON event signature over original bytes", () => {
  it("the re-serialized body differs from the original \\u-escaped bytes", () => {
    // A realistic rich Slack payload fragment with a \u escape. Slack delivers
    // these bytes verbatim; JSON.parse + JSON.stringify does NOT reproduce them.
    const original = '{"text":"caf\\u00e9 \\u2014 done"}';
    const reSerialized = JSON.stringify(JSON.parse(original));
    expect(reSerialized).not.toBe(original);
  });

  it("verifies a \\u-escaped JSON event over its original rawBody", async () => {
    const { ctx } = makeContext({ slackSigningSecretRef: SIGNING_REF });
    await plugin.definition.setup?.(ctx as any);

    const ts = nowTs();
    const rawBody = '{"type":"event_callback","event":{"text":"caf\\u00e9"}}';
    await plugin.definition.onWebhook?.({
      endpointKey: WEBHOOK_KEYS.slackEvents,
      headers: {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(SIGNING_SECRET, ts, rawBody),
      },
      rawBody,
      parsedBody: JSON.parse(rawBody),
      requestId: "req-rich-1",
    } as any);

    // Forwarded raw bytes verify; a re-serialized body would have failed.
    expect(rejectionCall(ctx)).toBeUndefined();
  });
});
