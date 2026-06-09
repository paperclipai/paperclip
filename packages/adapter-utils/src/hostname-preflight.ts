export type HostnamePreflightAddress = { address: string; family: number };

export type HostnamePreflightOutcome =
  | { ok: true; host: string; addresses: HostnamePreflightAddress[] }
  | { ok: false; host: string; reason: "lookup_failed" | "timeout" | "empty_result"; errorCode: string; message: string };

export type HostnamePreflightOptions = {
  /** Per-attempt timeout in milliseconds. Default 1500. */
  timeoutMs?: number;
  /**
   * Override the resolver. Defaults to `node:dns/promises` `lookup`. Tests
   * can stub this to simulate resolver failures without monkey-patching
   * global modules.
   */
  resolver?: (host: string) => Promise<HostnamePreflightAddress[] | undefined>;
};

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(onTimeoutMessage);
      (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Best-effort hostname reachability probe. Used by local CLI adapters to
 * short-circuit runs that would otherwise burn the full reconnect budget
 * (typically 5 attempts × ~16s) on a host the system cannot resolve.
 *
 * The probe never throws — every failure mode is returned as a typed
 * `ok: false` outcome so the caller can map it to a stable
 * `errorCode`/`errorFamily` and skip the upstream invocation entirely.
 */
export async function preflightHostnameLookup(
  host: string,
  options: HostnamePreflightOptions = {},
): Promise<HostnamePreflightOutcome> {
  const trimmed = host.trim();
  if (!trimmed) {
    return {
      ok: false,
      host,
      reason: "lookup_failed",
      errorCode: "hostname_empty",
      message: "preflight host was empty",
    };
  }

  const resolver =
    options.resolver ??
    (async (host) => {
      // Loaded dynamically so this module stays browser-safe. The UI
      // imports the type-only surface from `@paperclipai/adapter-utils`;
      // a static `import "node:dns/promises"` at the top of this file
      // would break the UI Vite build (it cannot resolve Node built-ins
      // in the browser bundle). The adapters that actually call this
      // function run in Node, so the dynamic import resolves there.
      const dnsPromises = await import("node:dns/promises");
      return (await dnsPromises.lookup(host)) as unknown as HostnamePreflightAddress[];
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;

  try {
    const addresses = await withTimeout(resolver(trimmed), timeoutMs, `preflight lookup timeout after ${timeoutMs}ms`);
    if (!addresses || addresses.length === 0) {
      return {
        ok: false,
        host: trimmed,
        reason: "empty_result",
        errorCode: "hostname_unresolvable",
        message: `preflight lookup for ${trimmed} returned no addresses`,
      };
    }
    return { ok: true, host: trimmed, addresses };
  } catch (err) {
    const nodeError = err as NodeJS.ErrnoException;
    const code = typeof nodeError?.code === "string" && nodeError.code ? nodeError.code : "ENOTFOUND";
    const reason: "timeout" | "lookup_failed" =
      code === "ETIMEDOUT" || (err instanceof Error && /timeout/i.test(err.message))
        ? "timeout"
        : "lookup_failed";
    return {
      ok: false,
      host: trimmed,
      reason,
      errorCode: code,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
