// Optional Sentry error monitoring for the browser.
//
// Activated only when the signed-in session carries a Sentry DSN. `SentryGate`
// reads the DSN off `GET /api/auth/get-session` and calls
// `initBrowserErrorMonitoring` once. A signed-out browser, or a browser with
// no DSN, calls this module never — see `SentryGate.tsx`.
//
// Sign-out must stop monitoring, not just stop starting it: `SentryGate`
// calls `teardownBrowserErrorMonitoring` when the session's DSN goes away.
// The function detaches the client from the current scope first
// (`Sentry.getCurrentScope().setClient(undefined)`), then closes that same
// client (`client.close()`), so a signed-out page's global handlers find no
// attached client at any point. Detach runs first because a client stays
// attached, and stays enabled, for the whole close call — closing first
// would leave the signed-out page able to send one more event to Sentry for
// as long as the close call takes. Both calls are built-in Sentry client
// calls — no custom filter code.
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
 *
 * Detaches the client from the current scope, then closes that same client.
 * A client stays attached, and stays enabled, for the whole close call — a
 * signed-out page's `window.onerror` or `window.onunhandledrejection`
 * handler would still reach it for as long as the close call takes.
 * Detaching first removes that window instead of leaving it open.
 */
export function teardownBrowserErrorMonitoring(): Promise<void> {
  return enqueue(async () => {
    const Sentry = sentry;
    sentry = null;
    if (!Sentry) return;
    // Read the client before detaching it. The scope holds no client after
    // detach, so the close step below needs this reference to flush and
    // close the right client.
    const client = Sentry.getClient();
    // Detach first, close second — the opposite order from a plain
    // `Sentry.close()` call, which reads the client off the current scope
    // and would find nothing to close if detach ran first. A separate
    // guarded try keeps this step unable to reject, unlike a bare finally
    // block: a thrown error here would still reach the caller, and
    // `SentryGate.tsx` discards this function's returned promise with a
    // bare `void` call, so a rejection would surface as an unhandled
    // promise rejection in the browser.
    try {
      Sentry.getCurrentScope().setClient(undefined);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry client detach failed", err);
    }
    // A second, separate guarded try, for the same reason as the one
    // above: this step must never reject the returned promise.
    try {
      // Awaiting matters: the client flushes buffered events to Sentry
      // during close; a caller that does not wait may navigate away, or
      // the page may unload, before the flush finishes.
      await client?.close(2_000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry teardownBrowserErrorMonitoring failed", err);
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
