/**
 * Strict parser and invariant checks for `tailscale serve status --json` output.
 *
 * Requirement #3 (manual-state TOCTOU / atomic ownership) and the required
 * invariants of the threat-model verdict: before and after every mutation the
 * broker re-reads Serve state, confirms the protected `:443 -> 127.0.0.1:3100`
 * mapping is structurally identical, and confirms that *only* the intended port
 * entry changed. On any parse ambiguity we fail closed rather than reconstruct
 * unknown state.
 *
 * The Serve config shape modeled here is the documented subset the broker uses:
 *   { "TCP": { "<port>": { "HTTPS": true } },
 *     "Web": { "<host>:<port>": { "Handlers": { "/": { "Proxy": "<target>" } } } },
 *     "AllowFunnel": { ... } }
 * Anything the broker does not understand (extra handler paths, funnel entries,
 * TCP forwards, etc.) is preserved opaquely and treated as protected/unknown.
 */

import { PROTECTED_PRIMARY_PORT, PROTECTED_PRIMARY_TARGET } from "./policy.js";

export interface ServeEntry {
  port: number;
  /** The single "/" proxy target, or null if the web entry is shaped unexpectedly. */
  target: string | null;
  /** Whether the TCP entry marks this port as HTTPS-terminated. */
  https: boolean;
}

export class ServeStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServeStateError";
    this.code = code;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deterministic canonical stringify for structural digests/equality. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface ParsedServeState {
  /** The raw config, retained verbatim for structural comparison. */
  raw: Record<string, unknown>;
  /** Normalized HTTPS-to-loopback web entries keyed by port. */
  entries: Map<number, ServeEntry>;
}

/**
 * Parse the JSON produced by `tailscale serve status --json`. Rejects
 * non-object roots and malformed port keys (fail closed).
 */
export function parseServeState(json: string): ParsedServeState {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (err) {
    throw new ServeStateError("parse_error", `could not parse serve state: ${(err as Error).message}`);
  }
  if (!isRecord(root)) {
    // An empty serve config may legitimately serialize as `null`; treat as empty.
    if (root === null) return { raw: {}, entries: new Map() };
    throw new ServeStateError("bad_root", "serve state root is not an object");
  }
  const web = isRecord(root.Web) ? root.Web : {};
  const tcp = isRecord(root.TCP) ? root.TCP : {};
  const entries = new Map<number, ServeEntry>();

  for (const [key, value] of Object.entries(web)) {
    const portStr = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    if (!/^[1-9][0-9]*$/.test(portStr)) {
      throw new ServeStateError("bad_web_key", `unparseable Web key ${JSON.stringify(key)}`);
    }
    const port = Number(portStr);
    let target: string | null = null;
    if (isRecord(value) && isRecord(value.Handlers)) {
      const handlers = value.Handlers;
      const handlerKeys = Object.keys(handlers);
      // The broker only ever creates a single "/" proxy handler. If a web entry
      // has any other handler shape it is treated as unknown/manual (target=null).
      if (handlerKeys.length === 1 && handlerKeys[0] === "/" && isRecord(handlers["/"])) {
        const proxy = (handlers["/"] as Record<string, unknown>).Proxy;
        target = typeof proxy === "string" ? proxy : null;
      }
    }
    const tcpEntry = tcp[String(port)];
    const https = isRecord(tcpEntry) ? tcpEntry.HTTPS === true : false;
    entries.set(port, { port, target, https });
  }
  return { raw: root, entries };
}

/**
 * Confirm the protected primary `:443 -> 127.0.0.1:3100` HTTPS mapping is present
 * and correctly shaped. Called before and after every mutation.
 */
export function assertPrimaryPresent(state: ParsedServeState): void {
  const entry = state.entries.get(PROTECTED_PRIMARY_PORT);
  if (!entry) {
    throw new ServeStateError("primary_missing", `protected :${PROTECTED_PRIMARY_PORT} mapping is absent`);
  }
  if (entry.target !== PROTECTED_PRIMARY_TARGET || !entry.https) {
    throw new ServeStateError(
      "primary_altered",
      `protected :${PROTECTED_PRIMARY_PORT} mapping is not ${PROTECTED_PRIMARY_TARGET} (HTTPS)`,
    );
  }
}

/** Structural digest of the protected `:443` web + tcp entries only. */
export function primaryDigest(state: ParsedServeState): string {
  const web = isRecord(state.raw.Web) ? (state.raw.Web as Record<string, unknown>) : {};
  const tcp = isRecord(state.raw.TCP) ? (state.raw.TCP as Record<string, unknown>) : {};
  const webKeys = Object.keys(web).filter((k) => k.endsWith(`:${PROTECTED_PRIMARY_PORT}`) || k === String(PROTECTED_PRIMARY_PORT));
  const picked: Record<string, unknown> = { Web: {}, TCP: {} };
  for (const k of webKeys) (picked.Web as Record<string, unknown>)[k] = web[k];
  if (tcp[String(PROTECTED_PRIMARY_PORT)] !== undefined) (picked.TCP as Record<string, unknown>)[String(PROTECTED_PRIMARY_PORT)] = tcp[String(PROTECTED_PRIMARY_PORT)];
  return canonicalize(picked);
}

/**
 * Verify that `after` differs from `before` in exactly the single web/tcp entry
 * for `changedPort` (either added, removed, or replaced) and in nothing else,
 * and that the protected `:443` mapping is byte-identical across both.
 * Throws on any unexpected diff (verdict #3).
 */
export function assertOnlyPortChanged(
  before: ParsedServeState,
  after: ParsedServeState,
  changedPort: number,
): void {
  if (primaryDigest(before) !== primaryDigest(after)) {
    throw new ServeStateError("primary_drift", "protected :443 mapping changed during mutation");
  }
  const beforeWeb = isRecord(before.raw.Web) ? (before.raw.Web as Record<string, unknown>) : {};
  const afterWeb = isRecord(after.raw.Web) ? (after.raw.Web as Record<string, unknown>) : {};
  const beforeTcp = isRecord(before.raw.TCP) ? (before.raw.TCP as Record<string, unknown>) : {};
  const afterTcp = isRecord(after.raw.TCP) ? (after.raw.TCP as Record<string, unknown>) : {};

  const isChangedKey = (k: string) => k === String(changedPort) || k.endsWith(`:${changedPort}`);

  const compareMaps = (b: Record<string, unknown>, a: Record<string, unknown>, label: string) => {
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
    for (const k of keys) {
      if (isChangedKey(k)) continue;
      if (canonicalize(b[k]) !== canonicalize(a[k])) {
        throw new ServeStateError("unexpected_diff", `unexpected change to ${label} entry ${JSON.stringify(k)}`);
      }
    }
  };
  compareMaps(beforeWeb, afterWeb, "Web");
  compareMaps(beforeTcp, afterTcp, "TCP");

  // Any top-level key other than Web/TCP must be unchanged (e.g. AllowFunnel).
  const otherKeys = new Set([...Object.keys(before.raw), ...Object.keys(after.raw)].filter((k) => k !== "Web" && k !== "TCP"));
  for (const k of otherKeys) {
    if (canonicalize((before.raw as Record<string, unknown>)[k]) !== canonicalize((after.raw as Record<string, unknown>)[k])) {
      throw new ServeStateError("unexpected_diff", `unexpected change to top-level serve key ${JSON.stringify(k)}`);
    }
  }
}
