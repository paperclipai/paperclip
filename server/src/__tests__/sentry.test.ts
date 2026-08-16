import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { CaptureContext } from "../sentry.js";

/**
 * Tests for the Sentry error-report gate and the two-level scrubber.
 *
 * The `@sentry/node` package is an optional dependency. The disabled path and
 * the package-absent path are part of the contract: with `SENTRY_DSN` unset the
 * module loads no SDK, and when the dynamic import fails the module warns once
 * and keeps the server booting. Each level test drives the SDK through a
 * structural fake, so a test asserts the outbound event shape without transport.
 * One test runs against the real SDK to record the true event shape.
 *
 * The module reads `SENTRY_DSN` and `SENTRY_TRUST_LEVEL` at import time, so each
 * test resets the module registry and imports a fresh copy. This copies the
 * `instrumentation.test.ts` pattern.
 */

const DSN_ENV = "SENTRY_DSN";
const TRUST_ENV = "SENTRY_TRUST_LEVEL";
const TEST_DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

const originalDsn = process.env[DSN_ENV];
const originalTrust = process.env[TRUST_ENV];

async function importFreshSentry() {
  vi.resetModules();
  return await import("../sentry.js");
}

/**
 * A structural fake of the `@sentry/node` surface the gate calls. It records the
 * `init` options and runs a pushed event through the registered `beforeSend`, so
 * a test can assert the outbound event shape without the real SDK. `vi.mock`
 * intercepts the dynamic import of `@sentry/node`.
 */
type FakeSentry = {
  initOptions: Record<string, unknown> | undefined;
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown) => string;
  flush: (timeout?: number) => Promise<boolean>;
  /** Run an event through the registered `beforeSend` as the SDK would. */
  runBeforeSend: (event: Record<string, unknown>) => Record<string, unknown> | null;
};

function installFakeSentry(): FakeSentry {
  const state: FakeSentry = {
    initOptions: undefined,
    init(options) {
      state.initOptions = options;
    },
    captureException() {
      return "fake-event-id";
    },
    async flush() {
      return true;
    },
    runBeforeSend(event) {
      const beforeSend = state.initOptions?.beforeSend as
        | ((event: Record<string, unknown>, hint?: unknown) => Record<string, unknown> | null)
        | undefined;
      if (!beforeSend) return event;
      return beforeSend(event, {});
    },
  };
  // `vi.doMock` is not hoisted, so it applies to the dynamic import that the
  // fresh `sentry.js` runs after this call. A hoisted `vi.mock` would not let a
  // test choose the fake per case.
  vi.doMock("@sentry/node", () => ({
    init: (options: Record<string, unknown>) => state.init(options),
    captureException: (error: unknown) => state.captureException(error),
    flush: (timeout?: number) => state.flush(timeout),
  }));
  return state;
}

beforeEach(() => {
  delete process.env[DSN_ENV];
  delete process.env[TRUST_ENV];
});

afterEach(() => {
  if (originalDsn === undefined) delete process.env[DSN_ENV];
  else process.env[DSN_ENV] = originalDsn;
  if (originalTrust === undefined) delete process.env[TRUST_ENV];
  else process.env[TRUST_ENV] = originalTrust;
  vi.restoreAllMocks();
  vi.doUnmock("@sentry/node");
  vi.resetModules();
});

describe("sentry gate — disabled path", () => {
  it("resolves readiness, loads no SDK, and never throws when SENTRY_DSN is unset", async () => {
    const sentry = await importFreshSentry();

    await expect(sentry.sentryReady).resolves.toBeUndefined();
    expect(sentry.isSentryEnabled()).toBe(false);
    // A capture on the disabled path returns undefined and does not throw.
    expect(sentry.captureException(new Error("boom"))).toBeUndefined();
    await expect(sentry.flushSentry()).resolves.toBeUndefined();
  });

  it("never initializes the SDK when SENTRY_DSN is unset", async () => {
    // The fake records an `init` call. With the DSN unset, the gate must not
    // reach the dynamic import, so `init` never runs.
    const fake = installFakeSentry();
    const sentry = await importFreshSentry();
    await sentry.sentryReady;
    expect(sentry.isSentryEnabled()).toBe(false);
    expect(fake.initOptions).toBeUndefined();
  });
});

describe("sentry gate — package absent", () => {
  it("resolves readiness and warns once with no DSN value when the import fails", async () => {
    // Simulate the optional package being absent: the dynamic import throws.
    // The gate must absorb it, warn once, and keep the server booting.
    vi.doMock("@sentry/node", () => {
      throw new Error("Cannot find module '@sentry/node'");
    });
    process.env[DSN_ENV] = TEST_DSN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const sentry = await importFreshSentry();

    await expect(sentry.sentryReady).resolves.toBeUndefined();
    expect(sentry.isSentryEnabled()).toBe(false);
    expect(warn).toHaveBeenCalled();
    // The diagnostic must never print the DSN value.
    for (const call of warn.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(TEST_DSN);
        expect(String(arg)).not.toContain("examplePublicKey");
      }
    }
  });
});

describe("sentry gate — init profiles", () => {
  it("uses the low-trust profile when SENTRY_TRUST_LEVEL is unset", async () => {
    const fake = installFakeSentry();
    process.env[DSN_ENV] = TEST_DSN;

    const sentry = await importFreshSentry();
    await sentry.sentryReady;

    expect(sentry.isSentryEnabled()).toBe(true);
    expect(sentry.sentryTrustLevel()).toBe("low");
    expect(sentry.isHighTrust()).toBe(false);
    expect(fake.initOptions).toMatchObject({
      skipOpenTelemetrySetup: true,
      sendDefaultPii: false,
      includeLocalVariables: false,
      defaultIntegrations: false,
    });
  });

  it("uses the high-trust profile when SENTRY_TRUST_LEVEL=high", async () => {
    const fake = installFakeSentry();
    process.env[DSN_ENV] = TEST_DSN;
    process.env[TRUST_ENV] = "high";

    const sentry = await importFreshSentry();
    await sentry.sentryReady;

    expect(sentry.sentryTrustLevel()).toBe("high");
    expect(sentry.isHighTrust()).toBe(true);
    expect(fake.initOptions).toMatchObject({
      skipOpenTelemetrySetup: true,
      sendDefaultPii: false,
      includeLocalVariables: true,
    });
    // The high-trust profile keeps the SDK default integrations, so it must not
    // set the disable override.
    expect(fake.initOptions?.defaultIntegrations).toBeUndefined();
  });

  it("falls to the low-trust profile for an unrecognized SENTRY_TRUST_LEVEL", async () => {
    const fake = installFakeSentry();
    process.env[DSN_ENV] = TEST_DSN;
    process.env[TRUST_ENV] = "maybe";

    const sentry = await importFreshSentry();
    await sentry.sentryReady;

    expect(sentry.sentryTrustLevel()).toBe("low");
    expect(fake.initOptions).toMatchObject({
      sendDefaultPii: false,
      includeLocalVariables: false,
      defaultIntegrations: false,
    });
  });

  it("keeps sendDefaultPii false in both trust levels", async () => {
    for (const level of [undefined, "high"] as const) {
      vi.resetModules();
      const fake = installFakeSentry();
      process.env[DSN_ENV] = TEST_DSN;
      if (level === undefined) delete process.env[TRUST_ENV];
      else process.env[TRUST_ENV] = level;

      const sentry = await import("../sentry.js");
      await sentry.sentryReady;

      expect(fake.initOptions?.sendDefaultPii).toBe(false);
      expect(fake.initOptions?.skipOpenTelemetrySetup).toBe(true);
      vi.doUnmock("@sentry/node");
    }
  });
});

/**
 * First acceptance criterion of the high-trust work: initialize the high-trust
 * profile against the real `@sentry/node` SDK, push an event through the SDK,
 * and record the outbound event shape. This proves whether the SDK default
 * integrations attach cookies, headers, the caller IP address, or the user
 * identity when `sendDefaultPii: false`. Phase 2 uses this record to size the
 * high-trust scrubber. The test skips when the optional package is not
 * installed, as `instrumentation.test.ts` does for the OTel SDK.
 */
const realSentry = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require("@sentry/node") as typeof import("@sentry/node");
  } catch {
    return null;
  }
})();

describe.skipIf(!realSentry)("sentry gate — real SDK high-trust event shape", () => {
  it("records the outbound event shape under sendDefaultPii: false", async () => {
    const Sentry = realSentry!;
    const captured: Record<string, unknown>[] = [];
    Sentry.init({
      dsn: TEST_DSN,
      skipOpenTelemetrySetup: true,
      sendDefaultPii: false,
      includeLocalVariables: true,
      // Capture the outbound event instead of sending it to transport.
      beforeSend(event) {
        captured.push(event as unknown as Record<string, unknown>);
        return null;
      },
    });
    try {
      Sentry.captureException(new Error("real-sdk-shape-probe"));
      await Sentry.flush(2000);
      expect(captured.length).toBeGreaterThan(0);
      const event = captured[0]!;
      // Record the shape. This documents what the SDK attaches with
      // sendDefaultPii: false so the high-trust scrubber names every field to
      // remove. The scrubber does not trust these observations as a gate; it
      // removes the identity fields unconditionally.
      const user = event.user as Record<string, unknown> | undefined;
      // With sendDefaultPii: false and no app-set user, the SDK must not attach
      // the caller IP address. The scrubber still removes it if present.
      expect(user?.ip_address).toBeUndefined();
      // The event must carry an exception. The rest of the shape (request,
      // contexts, breadcrumbs) is optional here; the recorded run in the task
      // notes shows the SDK does attach an app-set user and request in full, so
      // the high-trust scrubber removes user, cookies, and the IP address.
      expect(event.exception).toBeDefined();
    } finally {
      await Sentry.close(2000);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — the two-level `beforeSend` scrubber.
// ---------------------------------------------------------------------------

// Sentinels pushed through the event. The scrubber must remove each one at the
// level under test. `SECRET_URL` carries credentials in a URL, so the secret
// pass strips them from any string. `BEARER` sits under a sensitive key, so the
// key denylist redacts it.
const SECRET_URL = "postgres://dbuser:dbpass@db.internal:5432/app";
const BEARER = "Bearer sk-live-TOPSECRET";
const COOKIE_VALUE = "session=topsecretcookievalue";
const CALLER_IP = "203.0.113.77";
const USER_EMAIL = "alice@example.test";
const USER_ID = "user-abc-123";

/** Load a fresh gate at the given trust level with the SDK fake installed. */
async function loadGateAtLevel(level: "high" | "low") {
  vi.resetModules();
  const fake = installFakeSentry();
  process.env[DSN_ENV] = TEST_DSN;
  if (level === "low") delete process.env[TRUST_ENV];
  else process.env[TRUST_ENV] = "high";
  const sentry = await import("../sentry.js");
  await sentry.sentryReady;
  return { sentry, fake };
}

/**
 * Build a rich event that mirrors the real SDK shape recorded in Phase 1. It
 * carries the sentinels in every field the scrubber must protect. The
 * `paperclip_capture` context is where `captureException` stashes the typed
 * `CaptureContext`, so the low-trust allowlist keeps those fields.
 */
function buildRichEvent(): Record<string, unknown> {
  return {
    event_id: "evt-1",
    timestamp: 1,
    platform: "node",
    level: "error",
    environment: "test",
    sdk: { name: "sentry.javascript.node", version: "10.68.0" },
    server_name: "test-host",
    user: { id: USER_ID, email: USER_EMAIL, ip_address: CALLER_IP },
    request: {
      method: "POST",
      url: "https://host/api/adapters/abc",
      headers: {
        authorization: BEARER,
        cookie: COOKIE_VALUE,
        "x-forwarded-for": CALLER_IP,
        "user-agent": "curl/8",
      },
      cookies: { session: "topsecretcookievalue" },
      env: { REMOTE_ADDR: CALLER_IP },
      data: { password: BEARER },
      query_string: "q=1",
    },
    breadcrumbs: [
      { category: "http", message: `connect ${SECRET_URL}`, data: { url: SECRET_URL } },
    ],
    contexts: {
      trace: { trace_id: "t1", span_id: "s1" },
      runtime: { name: "node", version: "22" },
      // The serialized error properties. The secret pass strips the URL
      // credentials. The low-trust level drops this context in full.
      Error: { details: { dbUrl: SECRET_URL }, cause: SECRET_URL },
      paperclip_capture: {
        source: "startup-fatal",
      },
    },
    extra: { connString: SECRET_URL },
    exception: {
      values: [
        {
          type: "Error",
          value: `boom while reading ${SECRET_URL}`,
          stacktrace: {
            frames: [
              {
                filename: "a.js",
                function: "f",
                lineno: 1,
                colno: 2,
                in_app: true,
                vars: { connectionUrl: SECRET_URL, retries: 3 },
              },
            ],
          },
        },
      ],
    },
    sdkProcessingMetadata: {
      normalizedRequest: { headers: { authorization: BEARER, cookie: COOKIE_VALUE } },
    },
  };
}

describe("scrubber — low-trust strategy (default)", () => {
  it("drops SDK request, user, extra, breadcrumbs, and non-allowlisted contexts", async () => {
    const { fake } = await loadGateAtLevel("low");
    const out = fake.runBeforeSend(buildRichEvent());
    expect(out).not.toBeNull();
    expect(out!.request).toBeUndefined();
    expect(out!.user).toBeUndefined();
    expect(out!.extra).toBeUndefined();
    expect(out!.breadcrumbs).toBeUndefined();
    expect(out!.sdkProcessingMetadata).toBeUndefined();
    // Only the allowlisted capture context survives; SDK contexts are dropped.
    const contexts = (out!.contexts ?? {}) as Record<string, unknown>;
    expect(contexts.trace).toBeUndefined();
    expect(contexts.runtime).toBeUndefined();
    expect(contexts.Error).toBeUndefined();
    // No sentinel value survives anywhere in the serialized envelope.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("dbuser");
    expect(serialized).not.toContain("dbpass");
    expect(serialized).not.toContain("sk-live-TOPSECRET");
    expect(serialized).not.toContain("topsecretcookievalue");
    expect(serialized).not.toContain(CALLER_IP);
    expect(serialized).not.toContain(USER_EMAIL);
    expect(serialized).not.toContain(USER_ID);
  });

  it("keeps the typed CaptureContext source and a scrubbed, vars-free exception", async () => {
    const { fake } = await loadGateAtLevel("low");
    const out = fake.runBeforeSend(buildRichEvent());
    const capture = ((out!.contexts as Record<string, unknown>).paperclip_capture ??
      {}) as Record<string, unknown>;
    expect(capture.source).toBe("startup-fatal");
    // The exception survives but its message is secret-scrubbed and its frame
    // local variables are removed.
    const frame = (out!.exception as any).values[0].stacktrace.frames[0];
    expect(frame.vars).toBeUndefined();
    const message = (out!.exception as any).values[0].value as string;
    expect(message).not.toContain("dbuser");
    expect(message).not.toContain("dbpass");
    expect(message).toContain("db.internal");
  });

  it("drops a non-allowlisted key from the capture context and scrubs its secret", async () => {
    const { fake } = await loadGateAtLevel("low");
    const event = buildRichEvent();
    // A caller cannot add this key through the typed `CaptureContext`, but the
    // allowlist is the runtime guard. A non-allowlisted key never survives, and
    // the secret pass scrubs the whole event as a second line of defense.
    (event.contexts as any).paperclip_capture.rogueKey = SECRET_URL;
    const out = fake.runBeforeSend(event);
    const capture = ((out!.contexts as Record<string, unknown>).paperclip_capture ??
      {}) as Record<string, unknown>;
    expect(capture.source).toBe("startup-fatal");
    expect(capture.rogueKey).toBeUndefined();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("dbuser");
    expect(serialized).not.toContain("dbpass");
  });
});

describe("scrubber — high-trust strategy", () => {
  it("keeps request metadata, breadcrumbs, contexts, and locals", async () => {
    const { fake } = await loadGateAtLevel("high");
    const out = fake.runBeforeSend(buildRichEvent());
    expect(out).not.toBeNull();
    // Debug data survives.
    expect((out!.request as Record<string, unknown>).method).toBe("POST");
    expect((out!.request as Record<string, unknown>).url).toBe("https://host/api/adapters/abc");
    expect(Array.isArray(out!.breadcrumbs)).toBe(true);
    expect((out!.contexts as Record<string, unknown>).trace).toBeDefined();
    expect((out!.contexts as Record<string, unknown>).runtime).toBeDefined();
    const frame = (out!.exception as any).values[0].stacktrace.frames[0];
    expect(frame.vars).toBeDefined();
  });

  it("removes the user identity, cookies, and caller IP address", async () => {
    const { fake } = await loadGateAtLevel("high");
    const out = fake.runBeforeSend(buildRichEvent());
    expect(out!.user).toBeUndefined();
    const request = out!.request as Record<string, unknown>;
    expect(request.cookies).toBeUndefined();
    expect(request.env).toBeUndefined();
    const headers = request.headers as Record<string, unknown>;
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    // The IP-bearing header is stripped, so the caller IP never reaches Sentry
    // through the request headers.
    expect(headers["x-forwarded-for"]).toBeUndefined();
    // A non-sensitive header survives, so the scrubber did not blank the set.
    expect(headers["user-agent"]).toBe("curl/8");
    // The caller IP address, the user identity, and the cookie value never reach
    // the envelope.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(CALLER_IP);
    expect(serialized).not.toContain(USER_EMAIL);
    expect(serialized).not.toContain(USER_ID);
    expect(serialized).not.toContain("topsecretcookievalue");
  });

  it("still runs the secret-redaction pass over every string value", async () => {
    const { fake } = await loadGateAtLevel("high");
    const out = fake.runBeforeSend(buildRichEvent());
    const serialized = JSON.stringify(out);
    // URL credentials are stripped from the message, the breadcrumb, and the
    // local variable. The authorization header and password are redacted by the
    // key denylist.
    expect(serialized).not.toContain("dbuser");
    expect(serialized).not.toContain("dbpass");
    expect(serialized).not.toContain("sk-live-TOPSECRET");
    // The kept debug string still shows the non-secret host, so redaction did
    // not blank the whole value.
    expect(serialized).toContain("db.internal");
  });
});

describe("scrubber — free-form secret values", () => {
  // A bare credential can reach the event without a denylist key around it: a
  // bearer token in an exception message, a breadcrumb, or a stack-frame local
  // variable. The secret pass must redact the bare value, not only the URL
  // credentials, so the high-trust debug data never carries a live token.
  const RAW_TOKEN = "sk-live-abcdef0123456789";
  const BEARER_HEADER = `Bearer ${RAW_TOKEN}`;

  it("redacts a bare bearer token in the high-trust message, breadcrumb, and locals", async () => {
    const { fake } = await loadGateAtLevel("high");
    const event = buildRichEvent();
    const values = (event.exception as any).values;
    values[0].value = `auth failed with ${BEARER_HEADER}`;
    values[0].stacktrace.frames[0].vars = { authHeader: BEARER_HEADER, retries: 3 };
    (event.breadcrumbs as any)[0].message = `sent ${BEARER_HEADER}`;

    const out = fake.runBeforeSend(event);
    const serialized = JSON.stringify(out);
    // The bare token never reaches the envelope through any high-trust field.
    expect(serialized).not.toContain(RAW_TOKEN);
    // The scheme word stays, so the reader still sees an auth header was present.
    expect(serialized).toContain("Bearer [REDACTED]");
    // The non-secret local variable survives, so redaction did not blank locals.
    const frame = (out!.exception as any).values[0].stacktrace.frames[0];
    expect(frame.vars.retries).toBe(3);
  });

  it("redacts a bare bearer token in the low-trust exception message", async () => {
    const { fake } = await loadGateAtLevel("low");
    const event = buildRichEvent();
    (event.exception as any).values[0].value = `boom ${BEARER_HEADER}`;

    const out = fake.runBeforeSend(event);
    const message = (out!.exception as any).values[0].value as string;
    expect(message).not.toContain(RAW_TOKEN);
    expect(message).toContain("Bearer [REDACTED]");
  });
});

describe("scrubber — high-trust credential headers", () => {
  // The high-trust scrubber keeps the request headers for debug use, but a
  // credential can ride an unlisted header such as `proxy-authorization` or
  // `x-api-key`. The scrubber must redact the value of such a header, because a
  // bare API key has no recognizable pattern the string pass can find.
  it("redacts a credential-bearing header outside the removed set", async () => {
    const { fake } = await loadGateAtLevel("high");
    const event = buildRichEvent();
    const headers = (event.request as any).headers;
    headers["proxy-authorization"] = "Basic dXNlcjpwYXNzd29yZA==";
    headers["x-api-key"] = "raw-opaque-key-value-1234567890";

    const out = fake.runBeforeSend(event);
    const outHeaders = (out!.request as any).headers as Record<string, unknown>;
    expect(outHeaders["proxy-authorization"]).toBe("[REDACTED]");
    expect(outHeaders["x-api-key"]).toBe("[REDACTED]");
    // A non-sensitive header still survives, so the scrubber kept the debug set.
    expect(outHeaders["user-agent"]).toBe("curl/8");
    // Neither raw credential value reaches the envelope.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(serialized).not.toContain("raw-opaque-key-value-1234567890");
  });
});

describe("CaptureContext type", () => {
  it("allows the source field and rejects a raw request object and a free-form key", () => {
    // A compile-time contract. `pnpm --dir server typecheck` enforces it: an
    // over-broad type would make each `@ts-expect-error` unused and fail the
    // build. The runtime body only anchors the test.
    const ok: CaptureContext = { source: "startup-fatal" };
    expect(ok.source).toBe("startup-fatal");

    // @ts-expect-error — `source` is required.
    const missingSource: CaptureContext = {};
    void missingSource;

    // @ts-expect-error — an unknown source value is rejected.
    const badSource: CaptureContext = { source: "http-500" };
    void badSource;

    // @ts-expect-error — a raw request object is not a valid key.
    const withRequest: CaptureContext = { source: "startup-fatal", request: {} };
    void withRequest;

    // @ts-expect-error — a free-form key is rejected.
    const freeForm: CaptureContext = { source: "startup-fatal", anythingElse: "nope" };
    void freeForm;

    // @ts-expect-error — the request body is not a valid key.
    const withBody: CaptureContext = { source: "startup-fatal", body: { a: 1 } };
    void withBody;

    // @ts-expect-error — headers are not a valid key.
    const withHeaders: CaptureContext = { source: "startup-fatal", headers: {} };
    void withHeaders;
  });
});

describe("scrubber — fail-closed in both levels", () => {
  it.each(["low", "high"] as const)("drops the whole event when the scrubber throws (%s)", async (level) => {
    const { fake } = await loadGateAtLevel(level);
    // An event whose property access throws forces an internal scrubber error.
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "exception", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const out = fake.runBeforeSend(evil);
    expect(out).toBeNull();
  });
});

describe("high-trust warning helper", () => {
  it("returns the warning text with the exposed categories when SENTRY_TRUST_LEVEL=high", async () => {
    process.env[DSN_ENV] = TEST_DSN;
    process.env[TRUST_ENV] = "high";
    const sentry = await importFreshSentry();

    const warning = sentry.highTrustWarning();
    expect(warning).toBeDefined();
    const text = String(warning);
    // The warning names the data categories that now cross the boundary.
    expect(text).toContain("local variables");
    expect(text).toContain("breadcrumbs");
    expect(text).toContain("context");
    expect(text).toContain("request metadata");
    // The warning states that the identity data stays off.
    expect(text).toContain("cookies");
    expect(text).toContain("IP address");
    expect(text).toContain("user identity");
    // The warning never prints the DSN value.
    expect(text).not.toContain(TEST_DSN);
    expect(text).not.toContain("examplePublicKey");
  });

  it("returns nothing in the low-trust level", async () => {
    process.env[DSN_ENV] = TEST_DSN;
    delete process.env[TRUST_ENV];
    const sentry = await importFreshSentry();

    expect(sentry.highTrustWarning()).toBeUndefined();
  });
});
