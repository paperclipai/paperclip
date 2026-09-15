// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the browser Sentry gate. Unlike the server gate,
 * `@sentry/browser` is a real development dependency of this package (see
 * the constraint in the plan), so most tests here run against the true SDK
 * instead of a stand-in.
 *
 * The module holds module-scoped state (the readiness promise, the client
 * handle), so each test resets the module registry and imports a fresh copy.
 */

const DSN = "https://public@o0.ingest.sentry.io/1";

async function importFreshSentry() {
  vi.resetModules();
  return await import("./sentry");
}

/**
 * Register a fake `@sentry/browser` module for the next dynamic import. Used
 * by the tests that only care about the call the module makes into the SDK,
 * not the shape of a captured event.
 *
 * `init` and `setClient` both write one shared `attachedClient` variable —
 * the real SDK's `Sentry.init` and `Sentry.getCurrentScope().setClient` both
 * mutate the same module-global scope, not a value scoped to one caller. A
 * race that lets a stale `setClient(undefined)` land after a newer
 * `Sentry.init` needs a mock that tracks this shared state to catch it —
 * two mocks that record calls independently cannot see the clobber.
 */
function mockSentryPackage() {
  let nextClientId = 0;
  let attachedClient: { id: string; close: (timeout?: number) => Promise<boolean> } | null = null;

  // One shared `close` mock, attached to every client `init` creates. The
  // fix reads the client with `getClient()` and calls `client.close()`
  // directly, so the mocked client — not the mocked module — needs the
  // `close` method a test can hold open or reject.
  const close = vi.fn(async () => true);
  const init = vi.fn((_options: Record<string, unknown>) => {
    attachedClient = { id: `client-${nextClientId++}`, close };
  });
  const captureException = vi.fn(() => (attachedClient ? "event-id" : undefined));
  const getClient = vi.fn(() => attachedClient ?? undefined);
  const setClient = vi.fn((client: typeof attachedClient | undefined) => {
    attachedClient = client ?? null;
  });
  const getCurrentScope = vi.fn(() => ({ setClient }));

  vi.doMock("@sentry/browser", () => ({ init, captureException, close, getClient, getCurrentScope }));

  return {
    init,
    captureException,
    close,
    getClient,
    getCurrentScope,
    setClient,
    /** The `id` of whichever client `init`/`setClient` last attached, or `null` if none is. */
    attachedClientId: () => attachedClient?.id ?? null,
  };
}

/**
 * Hold a mocked `close()` call open until the test releases it. Returns the
 * release function. Used to put a teardown mid-flight without a second,
 * truly concurrent dynamic `import()` of the mocked `@sentry/browser` module
 * — Vitest does not guarantee two in-flight `import()` calls for one mocked
 * specifier both resolve against the same mock instance, so a test must
 * never rely on that to race two sign-ins.
 */
function holdCloseOpen(mocks: ReturnType<typeof mockSentryPackage>): () => void {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mocks.close.mockImplementationOnce(async () => {
    await gate;
    return true;
  });
  return release;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@sentry/browser");
});

// A representative default-integration list, shaped like the array
// `@sentry/browser@10.71.0`'s `getDefaultIntegrations()` returns. Recorded
// 2026-08-25 with `node -e` against the published package.
const DEFAULT_INTEGRATION_NAMES = [
  "InboundFilters",
  "FunctionToString",
  "ConversationId",
  "BrowserApiErrors",
  "Breadcrumbs",
  "GlobalHandlers",
  "LinkedErrors",
  "Dedupe",
  "HttpContext",
  "CultureContext",
  "BrowserSession",
];

describe("initBrowserErrorMonitoring", () => {
  it("initializes with the DSN it receives", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);

    expect(mocks.init).toHaveBeenCalledTimes(1);
    const initOptions = mocks.init.mock.calls[0][0] as { dsn: string };
    expect(initOptions.dsn).toBe(DSN);
  });

  it("a second call starts no second client", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);
    await initBrowserErrorMonitoring(DSN);

    expect(mocks.init).toHaveBeenCalledTimes(1);
  });
});

describe("teardownBrowserErrorMonitoring", () => {
  it("is a no-op when monitoring never started", async () => {
    const { teardownBrowserErrorMonitoring } = await importFreshSentry();

    await expect(teardownBrowserErrorMonitoring()).resolves.toBeUndefined();
  });

  it("closes the running client and detaches it from the current scope", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring } = await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);

    await teardownBrowserErrorMonitoring();

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.setClient).toHaveBeenCalledWith(undefined);
  });

  it("detaches the client from the current scope before close() settles", async () => {
    // The client stays attached, and stays enabled, for the whole `close()`
    // call — a signed-out page can still reach it until detach runs. Hold
    // `close()` open and assert the detach already ran while it is still
    // pending, so a regression back to close-then-detach fails this test.
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring } = await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);
    const releaseClose = holdCloseOpen(mocks);

    const teardownDone = teardownBrowserErrorMonitoring();
    // Give the queued teardown operation a few turns of the microtask queue
    // to run up to its `await client.close()` call, without waiting for
    // `close()` itself to settle — the gate above holds that call open.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.setClient).toHaveBeenCalledWith(undefined);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    releaseClose();
    await expect(teardownDone).resolves.toBeUndefined();
  });

  it("detaches the client from the current scope even when close() rejects, and still resolves", async () => {
    const mocks = mockSentryPackage();
    mocks.close.mockRejectedValueOnce(new Error("close timed out"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring } = await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);

    // The returned promise must resolve, not reject: SentryGate.tsx discards
    // it with a bare `void` call, so a rejection would surface as an
    // unhandled promise rejection in the browser.
    await expect(teardownBrowserErrorMonitoring()).resolves.toBeUndefined();

    expect(mocks.setClient).toHaveBeenCalledWith(undefined);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("stops captureBrowserException from reaching the client", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring, captureBrowserException } =
      await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);
    await teardownBrowserErrorMonitoring();

    captureBrowserException(new Error("boom after sign-out"));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("a call to initBrowserErrorMonitoring after teardown starts a fresh client", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring } = await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);
    await teardownBrowserErrorMonitoring();

    await initBrowserErrorMonitoring(DSN);

    expect(mocks.init).toHaveBeenCalledTimes(2);
  });

  it("a sign-back-in that overlaps a still-in-flight teardown ends up monitored, not silently disabled", async () => {
    // A sign-out whose `Sentry.close()` call is still in flight when the
    // browser signs back in. `Sentry.init` and `Sentry.getCurrentScope().
    // setClient` both mutate ONE shared scope, so the old teardown's
    // `setClient(undefined)` call, if it lands after the new sign-in's
    // `Sentry.init`, would detach the NEW client rather than the old one —
    // silently disabling monitoring for the session that just signed in.
    // The fix serializes the two: the old teardown's close-and-detach must
    // finish in full before the new sign-in's `Sentry.init` runs.
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, teardownBrowserErrorMonitoring, captureBrowserException } =
      await importFreshSentry();
    await initBrowserErrorMonitoring(DSN);
    expect(mocks.init).toHaveBeenCalledTimes(1);
    const clientAId = mocks.attachedClientId();
    expect(clientAId).not.toBeNull();

    const releaseClose = holdCloseOpen(mocks);
    const teardownDone = teardownBrowserErrorMonitoring();
    // The sign-back-in's own `Sentry.init` is now queued behind the
    // in-flight teardown, so its returned promise settles only once the
    // gate below releases — await it after releasing, not before.
    const signInBDone = initBrowserErrorMonitoring(DSN);

    releaseClose();
    await teardownDone;
    await signInBDone;

    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.init).toHaveBeenCalledTimes(2);
    // The old teardown's close-and-detach ran to completion BEFORE the new
    // sign-in's `Sentry.init`, so the client left attached is the new one —
    // not `undefined`, and not the old client A ever reused.
    const clientBId = mocks.attachedClientId();
    expect(clientBId).not.toBeNull();
    expect(clientBId).not.toBe(clientAId);

    captureBrowserException(new Error("boom after the race"));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe("captureBrowserException", () => {
  it("does not throw when the gate is closed", async () => {
    const { captureBrowserException } = await importFreshSentry();

    expect(() => captureBrowserException(new Error("boom"))).not.toThrow();
  });

  it("reaches the client once the gate opens", async () => {
    const mocks = mockSentryPackage();
    const { initBrowserErrorMonitoring, captureBrowserException } = await importFreshSentry();

    await initBrowserErrorMonitoring(DSN);
    captureBrowserException(new Error("boom"));
    // captureBrowserException resolves asynchronously; give its internal
    // promise a turn to settle before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error));
  });
});

/**
 * Call the `integrations` option with the given default list. The real
 * `@sentry/browser` option type allows `integrations` to be an array instead
 * of a function, so this guard narrows it before the call — this gate always
 * builds a function, never an array, but the type does not know that.
 */
function resolveIntegrations(
  options: ReturnType<typeof import("./sentry")["buildBrowserSentryInitOptions"]>,
  defaults: Array<{ name: string }>,
) {
  if (typeof options.integrations !== "function") {
    throw new Error("expected buildBrowserSentryInitOptions to set a function, not an array");
  }
  return options.integrations(defaults);
}

describe("buildBrowserSentryInitOptions", () => {
  it("sets the recorded built-in privacy options", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);

    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
  });

  it("holds no beforeSend hook and no custom filter function", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);

    expect(options.beforeSend).toBeUndefined();
    expect(options.beforeSendTransaction).toBeUndefined();
  });

  it("the resolved integration list holds no HttpContext integration and no Breadcrumbs integration", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);
    const resolved = resolveIntegrations(options, DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    expect(names).not.toContain("HttpContext");
    expect(names).not.toContain("Breadcrumbs");
  });

  it("the resolved integration list keeps GlobalHandlers, BrowserApiErrors, Dedupe, and LinkedErrors", async () => {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();

    const options = buildBrowserSentryInitOptions(DSN);
    const resolved = resolveIntegrations(options, DEFAULT_INTEGRATION_NAMES.map((name) => ({ name })));
    const names = resolved.map((i) => i.name);

    expect(names).toEqual(
      expect.arrayContaining(["GlobalHandlers", "BrowserApiErrors", "Dedupe", "LinkedErrors"]),
    );
  });
});

/**
 * Tests against the real `@sentry/browser` SDK. `@sentry/browser` is not an
 * optional dependency here — it is a real, always-installed development
 * dependency of this package (see the module comment in `sentry.ts`) — so
 * these tests run unconditionally.
 */
describe("captured event shape against the real @sentry/browser SDK", () => {
  /**
   * Initialize the real SDK with this module's exact options, plus a
   * transport stub so no event leaves the test process, plus `beforeSend`
   * so the test can inspect the resolved event before it would have been
   * sent. `beforeSend` here is test-only introspection — the shipped module
   * adds no `beforeSend` of its own (see the "holds no beforeSend hook"
   * test above).
   */
  async function initRealSentryForTest(onEvent: (event: Record<string, unknown>) => void) {
    const { buildBrowserSentryInitOptions } = await importFreshSentry();
    const Sentry = await import("@sentry/browser");
    Sentry.init({
      ...buildBrowserSentryInitOptions(DSN),
      transport: () => ({ send: async () => ({}), flush: async () => true }),
      beforeSend: (event) => {
        onEvent(event as unknown as Record<string, unknown>);
        return event;
      },
    });
    return Sentry;
  }

  it("an event from a page URL that holds a test capability value carries no request URL, no query string, and no referrer", async () => {
    window.history.pushState({}, "", "/dashboard?token=test-capability-value");
    Object.defineProperty(document, "referrer", {
      value: "https://from.example/previous-page",
      configurable: true,
    });
    let captured: Record<string, unknown> | null = null;
    const Sentry = await initRealSentryForTest((event) => {
      captured = event;
    });

    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    expect(captured).not.toBeNull();
    // `HttpContext` is the only default integration that writes
    // `event.request`. With it removed, the field never appears.
    expect((captured as unknown as Record<string, unknown>).request).toBeUndefined();
  });

  it("an event captured after a console call and a fetch call carries no breadcrumb", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    let captured: Record<string, unknown> | null = null;
    const Sentry = await initRealSentryForTest((event) => {
      captured = event;
    });

    // eslint-disable-next-line no-console
    console.warn("a console call the Breadcrumbs integration would otherwise record");
    await fetch("/api/probe?token=test-capability-value");
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    globalThis.fetch = originalFetch;
    expect(captured).not.toBeNull();
    expect((captured as unknown as Record<string, unknown>).breadcrumbs).toBeUndefined();
  });
});
