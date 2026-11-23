import type { PluginTracer } from "@paperclipai/plugin-sdk";

export type LeaseSpanName =
  | "lease.wait_for_teardown"
  | "lease.lookup"
  | "lease.refresh"
  | "lease.channel_cleanup"
  | "lease.start"
  | "lease.recover"
  | "lease.wait_transition"
  | "lease.force_stop"
  | "lease.verify"
  | "lease.workspace"
  | "lease.sentinel"
  | "lease.shell"
  | "lease.create"
  | "lease.expiry"
  | "lease.cleanup";

// A closed set: the settled states plus the transitions a start waits out.
const LABELLED_STATES: ReadonlySet<string> = new Set([
  "started", "stopped", "archived", "error",
  "starting", "stopping", "restoring", "archiving", "resizing",
]);

/** Keep provider state useful without exporting a new SDK value as free text. */
export function leaseStateAttributes(state: unknown): Record<string, string> {
  return {
    "paperclip.sandbox.startup.state":
      typeof state === "string" && LABELLED_STATES.has(state) ? state : "other",
  };
}

/** Use the invocation's async parent, while keeping tracer faults out of work. */
export async function withLeaseSpan<T>(
  tracer: PluginTracer,
  name: LeaseSpanName,
  work: () => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  let result: Promise<T> | undefined;
  // A tracer can fail before or after invoking work. Preserve its exact result
  // or error and never repeat provider operations in either case.
  const runOnce = () => result ??= Promise.resolve().then(work);
  try {
    if (tracer.withSpan) {
      await tracer.withSpan(name, runOnce, {
        "paperclip.sandbox.startup.provider": "daytona",
        ...attributes,
      });
    }
  } catch {
    // The operation's error is still held by result and is rethrown below.
  }
  return runOnce();
}
