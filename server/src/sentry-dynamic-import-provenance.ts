// Bounded provenance for `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` events.
//
// This error has reached Sentry with no first-party frame: an anonymous
// `setTimeout` callback at `<anonymous>:1:N` calls `import()`, and the
// unhandled rejection stops the server. In local reproduction only two paths
// produce that exact frame: `vm.compileFunction` without a filename, and code
// that a client evaluates in the process through the Node inspector. No
// shipped server code takes either path. This hook records whether an
// inspector session was open in the reporting process when the event was
// reported. That state is evidence, not proof of origin: code compiled
// without a filename fails the same way while a debugger is attached. A
// `closed` state rules out an evaluated expression from a session that is
// still open; an `open` state needs other evidence before blaming a debugger.
//
// Privacy: the inspector URL embeds a session secret, so only a three-value
// state leaves the process. Flag values are dropped; only allow-listed Node
// flag names remain. Every other event passes through unchanged.

import { isMainThread } from "node:worker_threads";

const DYNAMIC_IMPORT_CALLBACK_MISSING = "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING";

// Node flags that open, configure, or disable the inspector, plus the flag
// that changes `vm` dynamic import behavior. Nothing else is reported.
const REPORTED_NODE_FLAGS = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--inspect-port",
  "--debug-port",
  "--disable-sigusr1",
  "--experimental-vm-modules",
]);

export type InspectorState = "open" | "closed" | "unavailable";

export interface ProvenanceEvent {
  tags?: Record<string, string | number | boolean | bigint | symbol | null | undefined>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
}

export interface ProvenanceHint {
  originalException?: unknown;
}

/** Reads the inspector state of this process. Never returns the URL. */
export async function readInspectorState(): Promise<InspectorState> {
  try {
    // A Node build without the inspector throws on import. Load it lazily so
    // that build still starts and still reports the event.
    const inspector = await import("node:inspector");
    return inspector.url() === undefined ? "closed" : "open";
  } catch {
    return "unavailable";
  }
}

function reportedNodeFlags(): string[] {
  const tokens = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  const names = tokens.map((token) => token.split("=", 1)[0]).filter((name) => REPORTED_NODE_FLAGS.has(name));
  return [...new Set(names)].sort();
}

/**
 * Add inspector and process provenance to a dynamic-import-callback event.
 * Other events are returned unchanged. Never throws: provenance must not
 * discard the original error.
 */
export async function addDynamicImportProvenance<T extends ProvenanceEvent>(
  event: T,
  hint?: ProvenanceHint,
  readState: () => Promise<InspectorState> = readInspectorState,
): Promise<T> {
  try {
    const error = hint?.originalException;
    if (typeof error !== "object" || error === null ||
        (error as { code?: unknown }).code !== DYNAMIC_IMPORT_CALLBACK_MISSING) return event;
    const inspector = await readState();
    event.tags = { ...event.tags, dynamic_import_inspector: inspector };
    event.contexts = { ...event.contexts, dynamic_import_provenance: {
      inspector,
      nodeFlags: reportedNodeFlags(),
      mainThread: isMainThread,
      pid: process.pid,
      ppid: process.ppid,
      uptimeSeconds: Math.round(process.uptime()),
    } };
  } catch { /* Provenance enrichment must not discard the original error. */ }
  return event;
}
