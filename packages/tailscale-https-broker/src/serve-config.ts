/**
 * Strict parser + invariant checks for `tailscale serve status --json` output.
 *
 * The primary route `:443 -> http://127.0.0.1:3100` is a protected invariant
 * verified before AND after every mutation, and unknown/manual entries are
 * never modified (PAP-17050 verdict requirement #3 + invariants). Parsing fails
 * closed: any ambiguity, parse error, or unexpected shape is an error, never a
 * best-effort guess.
 */
import { assertCanonicalPort } from "./integers.js";
import { PROTECTED_PRIMARY_PORT, PROTECTED_PRIMARY_TARGET } from "./types.js";

export interface ServeHandler {
  path: string;
  proxy: string | null;
}

export interface ServeEntry {
  port: number;
  https: boolean;
  handlers: ServeHandler[];
}

export interface ParsedServe {
  /** Normalized entries keyed by port. */
  entries: Map<number, ServeEntry>;
}

export class ServeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServeParseError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract the trailing `:port` of a `host:port` Web key. */
function portFromWebKey(key: string): number {
  const idx = key.lastIndexOf(":");
  if (idx <= 0 || idx === key.length - 1) {
    throw new ServeParseError(`malformed Web key: ${JSON.stringify(key)}`);
  }
  const portText = key.slice(idx + 1);
  if (!/^[0-9]+$/.test(portText)) {
    throw new ServeParseError(`non-numeric port in Web key: ${JSON.stringify(key)}`);
  }
  return assertCanonicalPort(Number(portText));
}

/**
 * Parse serve status JSON into a normalized, port-keyed model. Tolerates extra
 * top-level fields (Tailscale evolves its schema) but strictly validates the
 * `TCP` and `Web` shapes it depends on.
 */
export function parseServeStatus(json: unknown): ParsedServe {
  if (!isObject(json)) {
    throw new ServeParseError("serve status must be a JSON object");
  }
  const entries = new Map<number, ServeEntry>();

  const tcp = json.TCP;
  const httpsPorts = new Set<number>();
  if (tcp !== undefined && tcp !== null) {
    if (!isObject(tcp)) throw new ServeParseError("TCP must be an object");
    for (const [portKey, value] of Object.entries(tcp)) {
      if (!/^[0-9]+$/.test(portKey)) {
        throw new ServeParseError(`non-numeric TCP port: ${portKey}`);
      }
      const port = assertCanonicalPort(Number(portKey));
      if (!isObject(value)) throw new ServeParseError(`TCP[${portKey}] must be an object`);
      if (value.HTTPS === true) httpsPorts.add(port);
      if (!entries.has(port)) entries.set(port, { port, https: value.HTTPS === true, handlers: [] });
      else entries.get(port)!.https = value.HTTPS === true;
    }
  }

  const web = json.Web;
  if (web !== undefined && web !== null) {
    if (!isObject(web)) throw new ServeParseError("Web must be an object");
    for (const [hostKey, value] of Object.entries(web)) {
      const port = portFromWebKey(hostKey);
      if (!isObject(value)) throw new ServeParseError(`Web[${hostKey}] must be an object`);
      const handlersRaw = value.Handlers;
      const handlers: ServeHandler[] = [];
      if (handlersRaw !== undefined && handlersRaw !== null) {
        if (!isObject(handlersRaw)) throw new ServeParseError(`Handlers for ${hostKey} must be an object`);
        for (const [path, handler] of Object.entries(handlersRaw)) {
          if (!isObject(handler)) throw new ServeParseError(`handler ${path} must be an object`);
          const proxy = handler.Proxy;
          if (proxy !== undefined && typeof proxy !== "string") {
            throw new ServeParseError(`handler ${path} Proxy must be a string`);
          }
          handlers.push({ path, proxy: typeof proxy === "string" ? proxy : null });
        }
      }
      const existing = entries.get(port);
      if (existing) {
        existing.handlers.push(...handlers);
        if (httpsPorts.has(port)) existing.https = true;
      } else {
        entries.set(port, { port, https: httpsPorts.has(port), handlers });
      }
    }
  }

  return { entries };
}

/** Stable, order-independent digest of one entry, for before/after comparison. */
export function entryDigest(entry: ServeEntry | undefined): string {
  if (!entry) return "absent";
  const handlers = [...entry.handlers]
    .map((h) => `${h.path}=>${h.proxy ?? ""}`)
    .sort();
  return JSON.stringify({ port: entry.port, https: entry.https, handlers });
}

/** True when the given entry is exactly a same-number HTTPS->loopback listener. */
export function isSameNumberLoopbackEntry(entry: ServeEntry | undefined, port: number): boolean {
  if (!entry || entry.port !== port || !entry.https) return false;
  if (entry.handlers.length !== 1) return false;
  const [handler] = entry.handlers;
  return handler.path === "/" && handler.proxy === `http://127.0.0.1:${port}`;
}

/**
 * Assert the protected primary `:443 -> http://127.0.0.1:3100` route is present
 * and exactly as expected. Throws otherwise. Called before and after mutation.
 */
export function assertPrimaryIntact(parsed: ParsedServe): void {
  const entry = parsed.entries.get(PROTECTED_PRIMARY_PORT);
  if (!entry) {
    throw new ServeParseError("protected primary :443 route is missing");
  }
  if (!entry.https) {
    throw new ServeParseError("protected primary :443 route is not HTTPS");
  }
  const root = entry.handlers.find((h) => h.path === "/");
  if (!root || root.proxy !== PROTECTED_PRIMARY_TARGET) {
    throw new ServeParseError("protected primary :443 route target changed");
  }
}

/** Digest of the protected :443 entry, for exact before/after equality. */
export function primaryDigest(parsed: ParsedServe): string {
  return entryDigest(parsed.entries.get(PROTECTED_PRIMARY_PORT));
}

/**
 * Protected ports whose entry digest differs between two snapshots (PAP-17285).
 * Empty is the only healthy result for any broker mutation.
 *
 * `entryDigest(undefined)` is the sentinel `"absent"`, so a protected entry that
 * *disappears* changes this digest exactly as loudly as one that is retargeted.
 * That is precisely the failure that went undetected on `42000/52000`: the
 * entries were deleted rather than modified, and the only snapshot comparison
 * that ran (`changedPorts` vs the intended lease ports) treated their removal as
 * the intended effect of the operation.
 */
export function changedProtectedPorts(
  before: ParsedServe,
  after: ParsedServe,
  protectedPorts: readonly number[],
): number[] {
  return [...new Set(protectedPorts)]
    .filter((port) => entryDigest(before.entries.get(port)) !== entryDigest(after.entries.get(port)))
    .sort((a, b) => a - b);
}

/** Ports whose entry digest differs between two snapshots. */
export function changedPorts(before: ParsedServe, after: ParsedServe): number[] {
  const ports = new Set<number>([...before.entries.keys(), ...after.entries.keys()]);
  const changed: number[] = [];
  for (const port of ports) {
    if (entryDigest(before.entries.get(port)) !== entryDigest(after.entries.get(port))) {
      changed.push(port);
    }
  }
  return changed.sort((a, b) => a - b);
}
