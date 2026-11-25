// Attribute an unhandled `fetch` rejection that has no stack.
//
// Chromium creates the `TypeError: Failed to fetch` network error with no
// stack frames. This app also removes the SDK's `Breadcrumbs` integration
// (see `sentry.ts`), which is what would otherwise wrap `fetch` and add a
// call-site stack. So an unhandled network rejection reaches Sentry with no
// caller at all, and nobody can tell whether app code, a browser extension,
// or another page script dropped it.
//
// `startFetchRejectionDiagnostics` wraps `window.fetch` once. Each call keeps
// an unread `Error` for its call site. Only when that request rejects is the
// stack classified, into an enum: `app`, `extension`, `other` or `unknown`.
// The rejected value is the key of a `WeakMap`; no property of it is read.
// URLs, paths and stack text stay in this module and are never sent.
//
// The wrapper returns a promise derived from the original one, which
// rethrows the identical rejection value. A caller that drops the returned
// promise still produces the same unhandled rejection it did before.

export type FetchInitiator = "app" | "extension" | "other" | "unknown";
export type FetchWrapperState = "none" | "before" | "after" | "both";

const EXTENSION_FRAME = /\b(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;
const FRAME_LOCATION = /:\d+:\d+\)?$/;
const FRAME_ORIGIN = /\b(https?:\/\/[^/\s)]+)/i;

const initiators = new WeakMap<object, FetchInitiator>();

let installed:
  | { target: Window; original: typeof fetch; wrapper: typeof fetch; wrappedBefore: boolean }
  | undefined;

/**
 * Classify the stack captured inside the fetch wrapper. Its first frame is
 * the wrapper itself; the next frame is the code that called `fetch`.
 * Exported for tests.
 */
export function classifyFetchCaller(stack: string | undefined, origin: string): FetchInitiator {
  if (typeof stack !== "string") return "unknown";
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FRAME_LOCATION.test(line));
  const callers = frames.slice(1);
  if (callers.length === 0) return "unknown";
  if (callers.some((frame) => EXTENSION_FRAME.test(frame))) return "extension";
  const callerOrigin = FRAME_ORIGIN.exec(callers[0])?.[1];
  return origin && callerOrigin?.toLowerCase() === origin.toLowerCase() ? "app" : "other";
}

function isNativeFunction(fn: unknown): boolean {
  try {
    return typeof fn === "function" && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

/**
 * Wrap `target.fetch` for rejection attribution. Idempotent, and kept for
 * the page lifetime, like the other page diagnostics. Never throws.
 */
export function startFetchRejectionDiagnostics(target: Window = window): void {
  if (installed) return;
  try {
    const original = target.fetch;
    if (typeof original !== "function") return;
    const origin = target.location?.origin ?? "";
    const wrapper = function fetch(this: unknown, ...args: Parameters<typeof globalThis.fetch>) {
      const site = new Error();
      const response = original.apply(this ?? target, args);
      try {
        if (typeof response?.then !== "function") return response;
        return response.then(undefined, (reason: unknown) => {
          try {
            if (typeof reason === "object" && reason !== null && !initiators.has(reason)) {
              initiators.set(reason, classifyFetchCaller(site.stack, origin));
            }
          } catch { /* diagnostic unavailable */ }
          throw reason;
        });
      } catch {
        return response;
      }
    } as typeof fetch;
    target.fetch = wrapper;
    installed = { target, original, wrapper, wrappedBefore: !isNativeFunction(original) };
  } catch { /* diagnostic unavailable */ }
}

/**
 * Who started the request that rejected with this value, or `unrecorded`
 * when the value did not come from a wrapped `fetch` call. Reads no property
 * of the value.
 */
export function readFetchInitiator(reason: unknown): FetchInitiator | "unrecorded" {
  if (typeof reason !== "object" || reason === null) return "unrecorded";
  return initiators.get(reason) ?? "unrecorded";
}

/**
 * Whether code other than this module wrapped `fetch`: `before` this module
 * was installed, `after` it, or both. `undefined` when not installed.
 */
export function readFetchWrapperState(): FetchWrapperState | undefined {
  if (!installed) return undefined;
  let after = false;
  try {
    after = installed.target.fetch !== installed.wrapper;
  } catch {
    after = true;
  }
  if (installed.wrappedBefore) return after ? "both" : "before";
  return after ? "after" : "none";
}

/** Test-only: restore the original `fetch` and forget the installation. */
export function __resetFetchRejectionDiagnostics() {
  if (installed && installed.target.fetch === installed.wrapper) installed.target.fetch = installed.original;
  installed = undefined;
}
