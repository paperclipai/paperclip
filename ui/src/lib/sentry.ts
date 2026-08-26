// Optional Sentry error monitoring for the browser.
//
// Activated only when the signed-in session carries a Sentry DSN. `SentryGate`
// reads the DSN off `GET /api/auth/get-session` and calls
// `initBrowserErrorMonitoring` once. A signed-out browser, or a browser with
// no DSN, calls this module never — see `SentryGate.tsx`.
//
// Sign-out must stop monitoring, not just stop starting it: `SentryGate`
// calls `teardownBrowserErrorMonitoring` when the session's DSN goes away,
// which closes the running client (`Sentry.close`) and detaches it from the
// current scope (`Sentry.getCurrentScope().setClient(undefined)`), so the
// global handlers `Sentry.init` installed send no more events. Both are
// built-in Sentry client calls — no custom filter code.
//
// `initBrowserErrorMonitoring`, `teardownBrowserErrorMonitoring`, and
// `captureBrowserException` each queue their work on one shared promise
// chain (`enqueue`) instead of running at once. One operation runs at a
// time, in call order, so no operation can ever observe another one
// part-finished — a sign-out always closes the client a sign-in already
// finished starting, never one still starting.
//
// `@sentry/browser` loads through a dynamic import, so Vite puts it in a
// separate chunk that a browser with no DSN never fetches.
//
// Default-integration privacy note: two default integrations copy values
// this app does not want inside a Sentry event, so the initializer removes
// them with a built-in Sentry option — no custom filter code:
//   - `Breadcrumbs` turns a console call, a click, and a fetch call into a
//     breadcrumb with the raw arguments and the raw request URL.
//   - `HttpContext` copies the page URL, the query string, and the referrer
//     onto every event.
// The initializer keeps every other default integration, so the browser
// still captures `window.onerror` and `window.onunhandledrejection`
// (`GlobalHandlers`), the two React error boundaries, deduplicates a repeat
// event (`Dedupe`), and links a caused-by chain (`LinkedErrors`).

let queue: Promise<void> = Promise.resolve();

/** Run gate operations one at a time, in call order. */
function enqueue(op: () => Promise<void>): Promise<void> {
  const next = queue.then(op);
  queue = next.catch(() => {});
  return next;
}

/** The `@sentry/browser` module shape, resolved once. */
type SentryBrowserModule = typeof import("@sentry/browser");

/**
 * The `Sentry.init` options this gate builds. `Sentry.init`'s parameter is
 * optional, so `Parameters<...>[0]` alone carries an `| undefined` arm this
 * gate never returns. `NonNullable` removes only that arm — the object shape
 * underneath stays the true `@sentry/browser` option type.
 */
type BrowserSentryInitOptions = NonNullable<Parameters<SentryBrowserModule["init"]>[0]>;

let sentry: SentryBrowserModule | null = null;

/**
 * Load `@sentry/browser` and start the client with the given DSN. Idempotent
 * — the session query can refetch and call this again, and a second call is
 * a no-op because a client is already started.
 */
export function initBrowserErrorMonitoring(dsn: string): Promise<void> {
  return enqueue(async () => {
    if (sentry) return;
    try {
      const Sentry = await import("@sentry/browser");
      Sentry.init(buildBrowserSentryInitOptions(dsn));
      sentry = Sentry;
    } catch (err) {
      // The dynamic import or the init call failed. Fall through with a
      // single diagnostic. The gate fails open — the app keeps running
      // without error monitoring rather than crashing on an opt-in feature.
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry browser bootstrap failed", err);
    }
  });
}

/**
 * Stop browser error monitoring and forget the started client. Call this on
 * sign-out, so the browser sends Sentry no more events and no more
 * breadcrumbs after the session ends. A no-op when monitoring never started.
 */
export function teardownBrowserErrorMonitoring(): Promise<void> {
  return enqueue(async () => {
    const Sentry = sentry;
    sentry = null;
    if (!Sentry) return;
    try {
      // Awaiting matters: the client flushes buffered events to Sentry
      // during close; detaching before it settles silently drops them.
      await Sentry.close(2_000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry teardownBrowserErrorMonitoring failed", err);
    } finally {
      Sentry.getCurrentScope().setClient(undefined);
    }
  });
}

/**
 * Report an error to Sentry. Never throws — observability must not change
 * control flow. A no-op before the gate opens, when the gate never opens (no
 * DSN on the session), or when bootstrap failed.
 */
export function captureBrowserException(error: unknown): void {
  void enqueue(async () => {
    try {
      sentry?.captureException(error);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry captureBrowserException failed", err);
    }
  });
}

/**
 * Build the `Sentry.init` options object. A pure function, split out from
 * `initBrowserErrorMonitoring` so a test can call it with the real
 * `@sentry/browser` module and assert the resolved integration list and the
 * captured-event shape against the true SDK, not a stand-in.
 */
export function buildBrowserSentryInitOptions(dsn: string): BrowserSentryInitOptions {
  return {
    dsn,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations: (defaults) =>
      defaults.filter(
        (integration) => integration.name !== "HttpContext" && integration.name !== "Breadcrumbs",
      ),
  };
}
