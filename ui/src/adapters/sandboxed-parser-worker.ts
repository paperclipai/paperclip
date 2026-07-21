/**
 * Sandboxed Worker bootstrap for external adapter UI parsers.
 *
 * Security boundary: parser code runs inside a dedicated Web Worker with
 * network and DOM APIs explicitly disabled.  Communication uses a narrow
 * postMessage protocol (see {@link SandboxRequest} / {@link SandboxResponse}).
 *
 * The worker is created from an inline Blob URL so no extra file needs to
 * be served.  On initialisation the main thread sends the parser source;
 * the bootstrap evaluates it in a scope where dangerous globals are shadowed
 * by `undefined`, then responds to parse requests.
 */

// ── Message protocol ────────────────────────────────────────────────────────

/** Messages sent from the main thread to the worker. */
export type SandboxRequest =
  | { type: "init"; source: string }
  | { type: "parse"; id: number; line: string; ts: string };

/** Messages sent from the worker back to the main thread. */
export type SandboxResponse =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; id: number; entries: unknown[] };

// ── Worker bootstrap source ─────────────────────────────────────────────────

/**
 * Inline JS that runs inside the Worker.  It:
 *  1. Shadows dangerous globals (`fetch`, `XMLHttpRequest`, `WebSocket`,
 *     `importScripts`, `EventSource`, `navigator.sendBeacon`, etc.) with
 *     no-ops or `undefined`.
 *  2. Waits for an `init` message carrying the adapter's parser source.
 *  3. Evaluates the source via `new Function()` and extracts exports.
 *  4. Responds to `parse` messages with `TranscriptEntry[]` results.
 */
const WORKER_BOOTSTRAP = `
"use strict";

// ── 1. Lock down dangerous globals ──────────────────────────────────────────
// Workers have no DOM, but they still have network and import APIs.

const _undefined = void 0;

function disableGlobal(name) {
  Object.defineProperty(self, name, {
    value: _undefined,
    writable: false,
    configurable: false,
  });
}

// Network
for (const name of [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "RTCPeerConnection",
  "RTCDataChannel",
  "Request",
  "Response",
  "Headers",
  "Cache",
  "CacheStorage",
  "caches",
]) disableGlobal(name);

// Import / eval escape hatches
for (const name of ["importScripts", "Worker", "SharedWorker", "Blob"]) disableGlobal(name);
if (self.URL) {
  try { Object.defineProperty(self.URL, "createObjectURL", { value: _undefined, writable: false, configurable: false }); } catch {}
  try { Object.defineProperty(self.URL, "revokeObjectURL", { value: _undefined, writable: false, configurable: false }); } catch {}
}

// Beacon / reporting
if (self.navigator) {
  try { Object.defineProperty(self.navigator, "sendBeacon", { value: _undefined, writable: false, configurable: false }); } catch {}
}
for (const name of ["BroadcastChannel"]) disableGlobal(name);

// IndexedDB (prevents persistent state exfiltration)
for (const name of ["indexedDB", "IDBFactory"]) disableGlobal(name);

// ── 2. Parser state ─────────────────────────────────────────────────────────

let parseStdoutLine = null;
let createStdoutParser = null;
let fallbackParser = null;

// ── 3. Message handler ──────────────────────────────────────────────────────

self.onmessage = function (e) {
  const msg = e.data;

  if (msg.type === "init") {
    try {
      // Evaluate the parser source in a constrained scope.
      // We use a Function constructor to avoid giving the source access to
      // our local variables.  The only value we inject is a module-like
      // \`exports\` object so both CJS-style and ESM-compiled code works.
      //
      // ESM sources compiled to IIFE typically assign to an \`exports\` param
      // or use \`export\`.  Since we can't use real ESM import() here (the
      // source is a string, not a URL), we wrap it.
      const exports = {};
      const module = { exports };

      // Build a function that receives common CJS shims.
      // \`self\` is shadowed to prevent the parser from un-deleting globals.
      const factory = new Function(
        "exports", "module", "self", "globalThis",
        // Wrap in a block to prevent hoisted declarations from leaking.
        "\\"use strict\\";\\n{\\n" + msg.source + "\\n}"
      );
      factory(exports, module, _undefined, _undefined);

      // Resolve exports — try module.exports first (CJS), then named exports.
      const resolved = module.exports && typeof module.exports === "object" && Object.keys(module.exports).length > 0
        ? module.exports
        : exports;

      if (typeof resolved.parseStdoutLine === "function") {
        parseStdoutLine = resolved.parseStdoutLine;
      }
      if (typeof resolved.createStdoutParser === "function") {
        createStdoutParser = resolved.createStdoutParser;
      }
      if (!parseStdoutLine && createStdoutParser) {
        fallbackParser = createStdoutParser();
        if (fallbackParser && typeof fallbackParser.parseLine === "function") {
          parseStdoutLine = (line, ts) => fallbackParser.parseLine(line, ts);
        }
      }

      if (!parseStdoutLine) {
        self.postMessage({ type: "error", message: "Parser module exports no usable parseStdoutLine or createStdoutParser" });
        return;
      }

      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: "Parser init failed: " + (err && err.message || String(err)) });
    }
    return;
  }

  if (msg.type === "parse") {
    try {
      const entries = parseStdoutLine ? parseStdoutLine(msg.line, msg.ts) : [];
      self.postMessage({ type: "result", id: msg.id, entries: entries || [] });
    } catch (err) {
      self.postMessage({ type: "result", id: msg.id, entries: [] });
    }
    return;
  }

};
`;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Return the inline Worker bootstrap source.
 * Exported for testing (so test code can verify the lockdown behaviour).
 */
export function getWorkerBootstrapSource(): string {
  return WORKER_BOOTSTRAP;
}

/**
 * Create a sandboxed Web Worker from the inline bootstrap.
 * The caller must send an `init` message with the parser source before
 * sending parse requests.
 */
export function createSandboxedWorker(): Worker {
  const blob = new Blob([WORKER_BOOTSTRAP], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    // Revoke after construction; the Worker has already captured the Blob URL source.
    URL.revokeObjectURL(url);
  }
}
