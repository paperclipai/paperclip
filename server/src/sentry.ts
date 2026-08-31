// Optional Sentry error monitoring for the server process.
//
// Activated only when `SENTRY_DSN` is set. When unset, no Sentry package is
// loaded at all.
//
// The import is dynamic and the package is an optional runtime dependency —
// operators who want server-side error monitoring install `@sentry/node`
// themselves. That keeps Sentry off the default dependency graph and avoids
// forcing a lockfile bump for an opt-in feature. This gate mirrors the
// OpenTelemetry gate in `instrumentation.ts`.
//
// OpenTelemetry keeps ownership of trace setup: the initializer passes
// `skipOpenTelemetrySetup: true` and `tracesSampleRate: 0`, so this module
// adds error monitoring only and starts no span or trace behavior of its
// own.
//
// Default-integration privacy note: `sendDefaultPii: false` filters values
// by name, inside the `RequestData` integration only. Three other default
// integrations copy raw values past that filter, so the initializer removes
// or narrows them with built-in Sentry options — no custom filter code:
//   - `Console` turns a `console.*` call into a breadcrumb with the raw
//     arguments. The initializer drops it.
//   - `ContextLines` reads local source lines around each stack frame off
//     the host disk. The initializer drops it.
//   - `Http` records a breadcrumb for each outbound request, with its URL
//     and query string. The initializer keeps the integration (`RequestData`
//     and request isolation need it) and turns the breadcrumb off with the
//     integration's own `breadcrumbs` option.
//
// `onUnhandledRejectionIntegration` defaults to `mode: "warn"`, which
// registers a `process.on("unhandledRejection")` listener. Node cancels its
// own crash-on-unhandled-rejection behavior when any listener is registered.
// The server relies on that crash today, so the initializer passes
// `mode: "strict"`: Sentry still captures the event, then exits the process,
// so the existing crash-and-restart behavior stays.
//
// Before it imports the package, the bootstrap checks the installed
// `@sentry/node` version against the exact version this manifest's
// `peerDependencies` declares — the same audited version documented in
// `doc/observability.md`. A missing or a mismatched version logs one
// diagnostic and leaves the server running without error monitoring; it
// never throws. This gate mirrors the OpenTelemetry gate in
// `instrumentation.ts`.

import { checkExactPeerVersions } from "./peer-version-check.js";

const dsn = process.env.SENTRY_DSN;

/** The subset of the `@sentry/node` client surface this gate calls. */
interface SentryHandle {
  captureException(error: unknown): string;
  close(timeout?: number): Promise<boolean>;
}

let sentryHandle: SentryHandle | null = null;
let shutdownPromise: Promise<void> | null = null;

/**
 * Resolves once the Sentry SDK has started, or once bootstrap has failed and
 * logged, or at once when `SENTRY_DSN` is unset. No caller needs to await
 * this before calling `captureException` — it is a no-op until ready — but
 * `index.ts` awaits it at startup so the first real error has a live client.
 */
export const sentryReady: Promise<void> = dsn ? bootstrapSentry(dsn) : Promise.resolve();

/**
 * Report an error to Sentry. A no-op before the gate opens, when the gate
 * never opens (`SENTRY_DSN` unset), or when bootstrap failed. Never throws —
 * observability must not change control flow.
 */
export function captureException(error: unknown): void {
  if (!sentryHandle) return;
  try {
    sentryHandle.captureException(error);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[paperclip] Sentry captureException failed", err);
  }
}

/**
 * Flush buffered events and close the Sentry client. Idempotent — concurrent
 * callers share one shutdown. A no-op when monitoring is off or bootstrap
 * failed.
 */
export function shutdownSentry(): Promise<void> {
  shutdownPromise ??= (async () => {
    await sentryReady;
    if (!sentryHandle) return;
    try {
      // Awaiting matters: the client flushes buffered events to Sentry
      // during close; exiting before it settles silently drops them.
      await sentryHandle.close(5_000);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[paperclip] Sentry shutdown failed", err);
    }
  })();
  return shutdownPromise;
}

/**
 * The subset of the `@sentry/node` module surface the initializer needs to
 * build its options object. A structural type, not the real Sentry type —
 * the real type is unavailable at compile time because the package is an
 * optional runtime dependency (see the module comment above).
 */
interface SentryModuleLike {
  httpIntegration(options: { breadcrumbs: boolean }): { name: string };
  onUnhandledRejectionIntegration(options: { mode: string }): { name: string };
}

/** The `Sentry.init` options this gate builds. */
export interface SentryInitOptions {
  dsn: string;
  skipOpenTelemetrySetup: boolean;
  tracesSampleRate: number;
  sendDefaultPii: boolean;
  integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
}

/**
 * Build the `Sentry.init` options object. A pure function, split out from
 * `bootstrapSentry` so a test can call it with a real `@sentry/node` module
 * and assert the resolved integration list and the captured-event shape
 * against the true SDK, not a stand-in.
 */
export function buildSentryInitOptions(
  dsn: string,
  Sentry: SentryModuleLike,
): SentryInitOptions {
  return {
    dsn,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    integrations: (defaults: Array<{ name: string }>) => {
      const kept = defaults.filter(
        (integration) =>
          integration.name !== "Console" &&
          integration.name !== "ContextLines" &&
          integration.name !== "Http" &&
          integration.name !== "OnUnhandledRejection",
      );
      return [
        ...kept,
        // Keep the rest of the Http integration — RequestData and request
        // isolation need it — but turn the outbound breadcrumb off.
        Sentry.httpIntegration({ breadcrumbs: false }),
        // Keep today's crash-on-unhandled-rejection behavior. See the
        // module comment above for why the default mode cannot stay.
        Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      ];
    },
  };
}

async function bootstrapSentry(dsn: string): Promise<void> {
  // Gate on the exact peer version before touching the dynamic import: a
  // package installed at the wrong version can still load and start, which
  // would silently invalidate the privacy audit `doc/observability.md`
  // records against one exact version. Checking first turns that into one
  // precise, fail-open diagnostic.
  const versionCheck = checkExactPeerVersions(["@sentry/node"]);
  if (!versionCheck.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] SENTRY_DSN is set but the @sentry/node package is not " +
        "installed, or is installed at an unsupported version. Install the " +
        "declared version of @sentry/node to enable server error " +
        "monitoring. Continuing without it.",
      versionCheck.detail,
    );
    return;
  }

  try {
    // Dynamic import so type-resolution doesn't require the package to be
    // installed unless the operator actually opts in.
    // @ts-ignore optional peer dep
    const Sentry = await import("@sentry/node");

    Sentry.init(buildSentryInitOptions(dsn, Sentry));

    sentryHandle = {
      captureException: (error) => Sentry.captureException(error),
      close: (timeout) => Sentry.close(timeout),
    };
  } catch (err) {
    // The exact-version gate above already confirmed @sentry/node is
    // installed at the declared version, so only a load or init failure
    // after that point reaches this block.
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] SENTRY_DSN is set and @sentry/node passed the version " +
        "check, but it failed to load or initialize. Continuing without " +
        "error monitoring.",
      err,
    );
  }
}
