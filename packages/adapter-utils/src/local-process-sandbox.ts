import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LocalProcessSandboxAccess = "ro" | "rw";
export type LocalProcessNetworkScope = "deny" | "allowlist";

export interface LocalProcessSandboxPath {
  path: string;
  access: LocalProcessSandboxAccess;
}

export interface LocalProcessSandboxPathAlias {
  path: string;
  target: string;
}

/**
 * Schema version carried by every `sandbox.network.*` event.
 *
 * Bump it for a rename, a removal, or a type change on any field of any event in this family. Do
 * **not** bump it for a purely additive field, or for a new event kind: a reader that ignores
 * unknown fields keeps working, and pushing churn at consumers trains them to widen their accepted
 * range until the check means nothing.
 *
 * The reason this exists: every liveness rule downstream keys on the *presence* of
 * `sandbox.network.proxy.started`, not on the readability of the decision events. A release that
 * renames a decision field while leaving the lifecycle event intact would leave the control looking
 * live while every decision line silently failed its reader's field access — deny alerting goes
 * quiet, and that is byte-indistinguishable from a quiet, healthy fleet. A version on the line lets
 * a reader alert on "I cannot read this" instead of skipping it.
 *
 * `2` replaced the `hostnameSanitized` / `portSanitized` booleans with the single
 * {@link SandboxNetworkDecision.targetSanitized} array. That is a removal, so it bumps — a reader
 * still asking for the old booleans gets `undefined`, which is falsy, which would have read as
 * "nothing was sanitized" on exactly the events that were.
 *
 * {@link SandboxNetworkProxyStopped.droppedEventCount} arrived after that and did *not* bump: it is
 * an addition, and a reader that ignores it reads every other field correctly. Its own absence is
 * still informative — see that field.
 */
export const SANDBOX_NETWORK_EVENT_SCHEMA_VERSION = 2;

/**
 * Component of the request target that {@link boundAndScrubEventField} altered on its way onto an
 * event. A closed literal set on purpose: the flag exists to cap log amplification, so no member of
 * it may be derived from request bytes.
 *
 * A single boolean was the obvious shape and is the wrong one. Downstream alerting partitions events
 * into "the hostname is a real name, key on it" and "the hostname is mangled, count it instead"; a
 * flag that answers "was *anything* sanitized" cannot express that, and collapsing to it routes a
 * port-only or scheme-only sanitization into the mangled-hostname bucket — which carries no hostname
 * keys by design, so a probe across many valid hostnames stops being distinguishable from one host.
 * The target is attacker-chosen, so that would hand the attacker the partition that classifies them.
 */
export type SandboxNetworkTargetField = "hostname" | "port" | "scheme";

/** Fields stamped on every `sandbox.network.*` event by the sink, never by an emit site. */
export interface SandboxNetworkEventEnvelope {
  /** Host clock at the moment of emission, ISO 8601 UTC. */
  ts: string;
  /** See {@link SANDBOX_NETWORK_EVENT_SCHEMA_VERSION} for the bump rule. */
  schemaVersion: number;
}

export type SandboxNetworkDecisionOutcome = "allow" | "deny";

export type SandboxNetworkDecisionReason =
  | "allowlist_match"
  | "trusted_url_match"
  | "network_target_denied"
  | "invalid_request_url"
  | "invalid_connect_target"
  | "https_requires_connect";

/**
 * One allow/deny decision made by the sandbox egress proxy.
 *
 * Deliberately carries only the inputs to the decision. The request path, query string, headers and
 * body are attacker-influenced and never included, so a reviewer can trust every field here.
 */
export interface SandboxNetworkDecision extends SandboxNetworkEventEnvelope {
  event: "sandbox.network.decision";
  decision: SandboxNetworkDecisionOutcome;
  reason: SandboxNetworkDecisionReason;
  /**
   * Hostname normalized by the same helper the policy check uses, so the event and the decision
   * cannot disagree. Null only when the request URL could not be parsed at all.
   *
   * Byte-equal to the string the policy check compared whenever `targetSanitized` omits
   * `"hostname"`. When it contains `"hostname"` this is a bounded, charset-scrubbed rendering of that
   * input instead, and is not a name — it must not be used as an aggregation key.
   */
  hostname: string | null;
  /**
   * Bounded to {@link EVENT_PORT_MAX_BYTES} and scrubbed to digits. A malformed `CONNECT` target
   * reaches this field having failed the numeric check by definition, so it is arbitrary
   * request-line bytes until it is bounded here.
   */
  port: string | null;
  /** Literal "CONNECT" on the tunnel path; the client's method on the plain HTTP path. */
  method: string | null;
  /**
   * Null on the CONNECT path: the proxy does not terminate TLS and must not infer a scheme. On the
   * HTTP path, bounded to {@link EVENT_SCHEME_MAX_BYTES}. The WHATWG parser already constrains the
   * charset, so no path, query, credential or fragment byte can reach here — but it does not
   * constrain the *length*, so a 16 KB scheme parses and would otherwise land in the audit trail once
   * per request with no throttle. Charset-clean is not the same guarantee as bounded.
   */
  scheme: string | null;
  /**
   * Which components of the target {@link boundAndScrubEventField} altered, in a fixed order; `[]`
   * when the target is verbatim. Affirmatively `[]` rather than omitted, so a reviewer can tell
   * "verbatim" from "emitted by a build that did not report this".
   */
  targetSanitized: readonly SandboxNetworkTargetField[];
  /**
   * True when `method` was truncated or charset-scrubbed. See the scrub note on
   * {@link describeEventMethod}. Stays a separate boolean rather than joining `targetSanitized`: the
   * method is not part of the target, and folding it in would make "the target is trustworthy" false
   * for a reason that says nothing about the target.
   */
  methodSanitized: boolean;
  /** Correlates a CONNECT decision with its `sandbox.network.tunnel.closed` event. Null off that path. */
  tunnelId: string | null;
}

/**
 * Emitted once the proxy is listening. Without it, an empty decision stream cannot distinguish "no
 * egress attempted" from "proxy never started" from "sink broken".
 */
export interface SandboxNetworkProxyStarted extends SandboxNetworkEventEnvelope {
  event: "sandbox.network.proxy.started";
  /**
   * Version of the `@paperclipai/adapter-utils` that emitted this event, read from its own package
   * manifest. Makes a dropped or replaced install pin visible *positively* — a reader can assert
   * which build is enforcing the allowlist instead of inferring it from the absence of a complaint.
   * Null only when the manifest could not be read, which never blocks the proxy from starting.
   */
  emitterVersion: string | null;
  /** Configured `networkAllowlist` entries — the input count. */
  allowlistEntryCount: number;
  /** Configured `networkTrustedUrls` entries — the input count. */
  trustedUrlCount: number;
  /** Rules that survived parsing. Below the input total means a trusted URL was silently dropped. */
  ruleCount: number;
  /** SHA-256 over the sorted `hostname:port` rule tuples, 16 hex chars, comparable across runs. */
  rulesetDigest: string;
}

/**
 * Emitted on the graceful teardown path only. A hard death of the host process yields no stopped
 * event, which is the intended reading: a `started` with no `stopped` is abnormal termination.
 */
export interface SandboxNetworkProxyStopped extends SandboxNetworkEventEnvelope {
  event: "sandbox.network.proxy.stopped";
  allowCount: number;
  denyCount: number;
  /**
   * Sink invocations that threw and were swallowed. Reported here because the sink is the transport:
   * a failing sink cannot report its own failure in real time.
   */
  sinkErrorCount: number;
  /**
   * Events the sink refused to hand the observer because {@link SINK_MAX_OUTSTANDING_WRITES} writes
   * were already outstanding. Non-zero means individual records are missing from the stream — but
   * `allowCount` and `denyCount` are counted before the cap applies, so the totals on this event stay
   * authoritative and a reader can quantify its own undercount instead of silently having one.
   *
   * `sinkErrorCount` cannot cover this: a write that was never issued never rejects.
   */
  droppedEventCount: number;
}

/**
 * Byte accounting for one closed CONNECT tunnel. Forensic, not real-time: it fires at tunnel close
 * and is the only signal covering exfiltration to an already-allowlisted host.
 */
export interface SandboxNetworkTunnelClosed extends SandboxNetworkEventEnvelope {
  event: "sandbox.network.tunnel.closed";
  tunnelId: string;
  hostname: string | null;
  port: string | null;
  /** Bytes the confined process sent upstream. */
  bytesOut: number;
  /** Bytes the upstream returned. */
  bytesIn: number;
  durationMs: number;
  /**
   * Mirrors the decision event's field, carried forward from the CONNECT that opened this tunnel so
   * the two records cannot disagree. A tunnel only opens on a hostname that matched a rule and a port
   * that passed the range check, so in practice this is `[]`; it is still emitted, because a reader
   * must not have to know that invariant to trust `hostname` as a key. `"scheme"` cannot appear — the
   * proxy tunnels CONNECT opaquely and never infers one.
   */
  targetSanitized: readonly SandboxNetworkTargetField[];
  /**
   * True when teardown flushed this tunnel because it was still open, rather than the client closing
   * it. Absence of a `tunnel.closed` has no complement the way a missing `proxy.stopped` does — it
   * reads as "no tunnel was opened" — so a tunnel held open for the whole run, the exact
   * exfiltration shape this event exists for, must not vanish at teardown.
   */
  closedAtTeardown: boolean;
}

/** Every event the proxy can emit, all carried on the one observer — no second seam. */
export type SandboxNetworkEvent =
  | SandboxNetworkDecision
  | SandboxNetworkProxyStarted
  | SandboxNetworkProxyStopped
  | SandboxNetworkTunnelClosed;

export interface LocalProcessSandboxOptions {
  workspaceDir: string;
  filesystemScope?: "workspace" | null;
  managedPaths?: LocalProcessSandboxPath[];
  extraPaths?: LocalProcessSandboxPath[];
  pathAliases?: LocalProcessSandboxPathAlias[];
  outboundRestorePaths?: string[];
  homeDir?: string | null;
  networkScope?: LocalProcessNetworkScope | null;
  networkAllowlist?: string[];
  networkTrustedUrls?: string[];
  /**
   * Observer for every egress decision and for proxy/tunnel lifecycle. Runs in the host process,
   * never inside the sandbox. Throwing from it is contained: it cannot change a policy outcome or
   * stop the proxy.
   *
   * Returns `unknown` so an async observer can be accounted for. A production observer writes to a
   * host sink and returns a promise; a `void` contract let the sink only see a *synchronous* throw,
   * so a persistently failing async write reported `sinkErrorCount: 0` — a gap that affirmatively
   * reports health. Return the write promise and the sink counts its rejection. The proxy still
   * never awaits it.
   */
  onNetworkDecision?: (event: SandboxNetworkEvent) => unknown;
  command?: string;
}

export interface LocalProcessSandboxSpawnTarget {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cleanup?: () => Promise<void>;
}

interface NetworkAllowlistRule {
  hostname: string;
  port: string | null;
  /** Which configuration surface contributed the rule, so a match can say why it matched. */
  source: "allowlist" | "trusted_url";
}

interface NetworkAllowlistProxy {
  close: () => Promise<void>;
}

/** One opened CONNECT tunnel that has not yet been accounted for by a `tunnel.closed` event. */
interface LiveTunnel {
  tunnelId: string;
  /** Null when `net.connect` threw, so the tunnel never had a socket to account for. */
  upstream: net.Socket | null;
  openedAt: number;
  hostname: string | null;
  port: string | null;
  targetSanitized: readonly SandboxNetworkTargetField[];
}

const SYSTEM_READ_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/timezone",
  "/etc/gitconfig",
] as const;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const SANDBOX_PROXY_PORT = 31_337;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const NETWORK_PROXY_TEMP_PREFIX = "paperclip-network-sandbox-";

function normalizeAbsolutePath(candidate: string, label: string): string {
  const trimmed = candidate.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(trimmed);
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(() => true).catch(() => false);
}

function parentDirectories(candidate: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function addParentDirectories(args: string[], created: Set<string>, candidate: string): void {
  for (const directory of parentDirectories(candidate)) {
    if (created.has(directory)) continue;
    args.push("--dir", directory);
    created.add(directory);
  }
}

async function nearestPackageRoot(candidate: string): Promise<string> {
  let current = path.dirname(candidate);
  while (current !== path.dirname(current)) {
    if (await pathExists(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }
  return path.dirname(candidate);
}

async function executableReadPaths(command: string): Promise<string[]> {
  const paths = new Set<string>();
  paths.add(path.dirname(command));
  const realCommand = await fs.realpath(command).catch(() => command);
  paths.add(await nearestPackageRoot(realCommand));
  return Array.from(paths);
}

function parseNetworkAllowlistEntry(entry: string, index: number): NetworkAllowlistRule {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error(`networkAllowlist[${index}] must not be empty.`);
  let hostname: string;
  let port: string | null;
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("path");
    }
    // WHATWG URL retains brackets on an IPv6 literal while the target side strips them, so an
    // unnormalized rule could never match and quietly denied every IPv6 target.
    hostname = normalizeNetworkHostname(parsed.hostname);
    port = parsed.port || null;
  } catch {
    throw new Error(`networkAllowlist[${index}] must be a hostname, hostname:port, or origin URL.`);
  }
  if (!hostname || hostname === "*" || hostname.startsWith("*.")) {
    throw new Error(`networkAllowlist[${index}] must use an exact hostname; wildcards are not supported.`);
  }
  return { hostname, port, source: "allowlist" };
}

export function parseLocalProcessNetworkAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`networkAllowlist[${index}] must be a string.`);
    const rule = parseNetworkAllowlistEntry(entry, index);
    return formatNetworkRuleTarget(rule);
  });
}

export function parseLocalProcessNetworkScope(value: unknown): LocalProcessNetworkScope | null {
  if (value == null || value === "") return null;
  if (value === "deny" || value === "allowlist") return value;
  throw new Error('networkScope must be "deny" or "allowlist".');
}

export function parseLocalProcessFilesystemScope(value: unknown): "workspace" | null {
  if (value == null || value === "") return null;
  if (value === "workspace") return value;
  throw new Error('filesystemScope must be "workspace".');
}

/**
 * Single source of truth for hostname normalization. The policy check and the decision event both
 * call this, so an emitted hostname is always the exact value the allowlist was compared against.
 */
function normalizeNetworkHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * Renders a rule back into allowlist syntax. IPv6 needs its brackets restored: rules are normalized
 * without them, and `hostname:port` is unparseable for an address that already contains colons.
 */
function formatNetworkRuleTarget(rule: NetworkAllowlistRule): string {
  const hostname = rule.hostname.includes(":") ? `[${rule.hostname}]` : rule.hostname;
  return rule.port ? `${hostname}:${rule.port}` : hostname;
}

/** Longest legal DNS name. A CONNECT target is arbitrary request-line bytes and gets capped here. */
const EVENT_HOSTNAME_MAX_BYTES = 253;
/** `:` is permitted so a valid IPv6 literal is not scrubbed; `%` is not, as downstream readers decode it. */
const EVENT_HOSTNAME_DISALLOWED = /[^a-z0-9.\-:]/g;
/**
 * A legal port is at most five digits. The slack keeps an out-of-range *numeric* target legible
 * instead of silently truncating it into a different, plausible port.
 */
const EVENT_PORT_MAX_BYTES = 8;
const EVENT_PORT_DISALLOWED = /[^0-9]/g;
/**
 * The longest scheme anyone routes through a proxy is five bytes (`https`); 16 is generous and still
 * a bound. The WHATWG parser accepts a scheme of any length, so this cap — not the charset — is what
 * stops a 16 KB one being written to the audit trail once per request.
 */
const EVENT_SCHEME_MAX_BYTES = 16;
/** The WHATWG scheme charset. Re-asserted locally so the bound does not depend on the parser's. */
const EVENT_SCHEME_DISALLOWED = /[^a-zA-Z0-9+.\-]/g;
/** Comfortably past the longest verb in llhttp's table (`UNSUBSCRIBE`), short enough to stay a bound. */
const EVENT_METHOD_MAX_BYTES = 24;
/** `-` is permitted for `M-SEARCH`. Nothing else: a method is a token, never free text. */
const EVENT_METHOD_DISALLOWED = /[^A-Za-z-]/g;

interface BoundedEventField {
  value: string;
  sanitized: boolean;
}

/**
 * Bounds and charset-scrubs one event field. Fixed order — truncate, then scrub — so the result is
 * deterministic, and the returned flag makes any mutation visible rather than silent. Every field on
 * an event that originates in the request line goes through this, because the docblock at the top of
 * this module promises a reviewer can trust every field, and an unbounded one turns the audit trail
 * into an amplifier for whatever the confined process chose to send.
 */
function boundAndScrubEventField(raw: string, maxBytes: number, disallowed: RegExp): BoundedEventField {
  let value = raw;
  let sanitized = false;
  if (Buffer.byteLength(value) > maxBytes) {
    value = Buffer.from(value).subarray(0, maxBytes).toString("utf8");
    sanitized = true;
  }
  const scrubbed = value.replace(disallowed, "?");
  if (scrubbed !== value) sanitized = true;
  return { value: scrubbed, sanitized };
}

interface EventTargetDescription {
  hostname: string | null;
  port: string | null;
  scheme: string | null;
  targetSanitized: readonly SandboxNetworkTargetField[];
}

/**
 * Bounds every component of the request target and reports which ones it had to alter.
 *
 * One function rather than one per field, so the flag and the values are produced together: a fourth
 * target component added later cannot reach an event unbounded by being forgotten at an emit site,
 * because there is no emit site that assembles these itself.
 *
 * Each component needs this for a different reason. `hostname` is normalized by the policy helper
 * first, so an unsanitized one is byte-equal to the string the decision compared. `port` on the
 * malformed-`CONNECT` branch has failed `/^\d+$/` by definition, so it is up to `maxHeaderSize`
 * (16 KB) of attacker-chosen request-line bytes. `scheme` comes from a parser that constrains its
 * charset but not its length, so it is charset-clean and still unbounded.
 */
function describeEventTarget(raw: {
  hostname: string | null;
  port: string | null;
  scheme: string | null;
}): EventTargetDescription {
  // Appended in the declared order of SandboxNetworkTargetField, which is what makes the emitted
  // array sorted without a sort — two events sanitized the same way compare byte-for-byte.
  const targetSanitized: SandboxNetworkTargetField[] = [];
  const hostname = raw.hostname
    ? boundAndScrubEventField(normalizeNetworkHostname(raw.hostname), EVENT_HOSTNAME_MAX_BYTES, EVENT_HOSTNAME_DISALLOWED)
    : null;
  if (hostname?.sanitized) targetSanitized.push("hostname");
  const port = raw.port ? boundAndScrubEventField(raw.port, EVENT_PORT_MAX_BYTES, EVENT_PORT_DISALLOWED) : null;
  if (port?.sanitized) targetSanitized.push("port");
  const scheme = raw.scheme
    ? boundAndScrubEventField(raw.scheme, EVENT_SCHEME_MAX_BYTES, EVENT_SCHEME_DISALLOWED)
    : null;
  if (scheme?.sanitized) targetSanitized.push("scheme");
  return {
    hostname: hostname?.value ?? null,
    port: port?.value ?? null,
    scheme: scheme?.value ?? null,
    targetSanitized,
  };
}

interface EventMethod {
  method: string | null;
  methodSanitized: boolean;
}

/**
 * Scrubbed rather than trusted. Today llhttp rejects any method outside its fixed table before the
 * request handler runs, so this is a no-op — but that safety is a property of a dependency's default
 * configuration, and enabling `insecureHTTPParser` anywhere upstream would silently turn `method`
 * into free text on a security record. Bounding it here makes the guarantee local.
 */
function describeEventMethod(rawMethod: string | null): EventMethod {
  if (!rawMethod) return { method: null, methodSanitized: false };
  const bounded = boundAndScrubEventField(rawMethod, EVENT_METHOD_MAX_BYTES, EVENT_METHOD_DISALLOWED);
  return { method: bounded.value, methodSanitized: bounded.sanitized };
}

/** Sorted, or the digest is not comparable between two runs holding the same effective ruleset. */
function computeRulesetDigest(rules: NetworkAllowlistRule[]): string {
  const tuples = rules.map((rule) => `${rule.hostname}:${rule.port ?? "*"}`).sort();
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex").slice(0, 16);
}

/** Returns the rule that permitted the target, or null when policy denies it. */
function matchNetworkTarget(
  hostname: string,
  port: string,
  rules: NetworkAllowlistRule[],
): NetworkAllowlistRule | null {
  const normalizedHostname = normalizeNetworkHostname(hostname);
  return rules.find((rule) => rule.hostname === normalizedHostname && (rule.port === null || rule.port === port)) ?? null;
}

function isNetworkTargetAllowed(hostname: string, port: string, rules: NetworkAllowlistRule[]): boolean {
  return matchNetworkTarget(hostname, port, rules) !== null;
}

function assertUnixSocketPathLength(socketPath: string): void {
  const pathBytes = Buffer.byteLength(socketPath);
  if (pathBytes > UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `Paperclip sandbox proxy socket path is ${pathBytes} bytes, exceeding the Linux limit of ${UNIX_SOCKET_PATH_MAX_BYTES}: ${socketPath}`,
    );
  }
}

async function createNetworkProxyTempDir(): Promise<string> {
  const candidates = Array.from(new Set(["/tmp", os.tmpdir()]));
  let lastError: unknown;
  for (const baseDir of candidates) {
    try {
      const tempDir = await fs.mkdtemp(path.join(baseDir, NETWORK_PROXY_TEMP_PREFIX));
      try {
        assertUnixSocketPathLength(path.join(tempDir, "proxy.sock"));
        return tempDir;
      } catch (error) {
        await fs.rm(tempDir, { recursive: true, force: true });
        lastError = error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Unable to create a Linux-safe Paperclip sandbox proxy socket directory.", { cause: lastError });
}

function parseTrustedNetworkUrl(value: string): NetworkAllowlistRule | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return {
      hostname: normalizeNetworkHostname(parsed.hostname),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      source: "trusted_url",
    };
  } catch {
    return null;
  }
}

type SandboxNetworkEventInput = SandboxNetworkEvent extends infer Event
  ? Event extends SandboxNetworkEvent ? Omit<Event, keyof SandboxNetworkEventEnvelope> : never
  : never;

interface SandboxNetworkEventSink {
  emit: (event: SandboxNetworkEventInput) => void;
  counters: () => {
    allowCount: number;
    denyCount: number;
    sinkErrorCount: number;
    droppedEventCount: number;
  };
  /**
   * Settles once every observer write issued so far has settled, or once the budget expires.
   * Teardown calls this before reading the counters, so `sinkErrorCount` is the real tally rather
   * than whatever had happened to resolve by then.
   */
  drain: () => Promise<void>;
}

/**
 * Teardown waits this long for outstanding observer writes. A hung sink must delay the run's exit,
 * not hold it open: it is an observability dependency and never a gate on the sandbox shutting down.
 */
const SINK_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Ceiling on observer writes in flight at once. Arrival is the confined process's rate — a denied
 * CONNECT costs it one socket write and no round trip — while the drain is one store transaction at a
 * time, so the queue between them is the asymmetry. Unbounded, that queue is a heap growth path in the
 * process hosting every run, and worse: teardown's drain budget expires, `proxy.stopped` queues behind
 * the remaining backlog, and the one record carrying the authoritative allow/deny/sinkError totals
 * never persists. A reader then cannot tell "stream ended" from "stream truncated".
 *
 * Chosen to bound heap rather than to tune throughput: an event serializes to a few hundred bytes, so
 * this is tens of kilobytes per sandbox, and a healthy sink never reaches it because the chain drains
 * far faster than a run generates requests. A run that does reach it is a flood, which is itself the
 * finding — recorded as `droppedEventCount` on `proxy.stopped` rather than inferred from a gap.
 *
 * Lifecycle events bypass the cap: see {@link UNDROPPABLE_SANDBOX_NETWORK_EVENTS}.
 */
const SINK_MAX_OUTSTANDING_WRITES = 256;

/**
 * The two events that bracket the stream are never dropped, whatever the backlog.
 *
 * `proxy.started` and `proxy.stopped` are what let a reader interpret everything between them:
 * `started` distinguishes "no egress attempted" from "proxy never ran", and `stopped` carries the
 * totals and is the end-of-stream marker. Dropping either converts a bounded, quantified loss into an
 * unreadable stream. Reserving capacity for them is also what makes the cap sufficient rather than
 * merely bounded — it is why `proxy.stopped` clears teardown's first drain instead of queueing behind
 * a backlog. The alternative, emitting `proxy.stopped` ahead of the queue, would trade away the FIFO
 * ordering the whole chain exists to provide.
 */
const UNDROPPABLE_SANDBOX_NETWORK_EVENTS: ReadonlySet<string> = new Set([
  "sandbox.network.proxy.started",
  "sandbox.network.proxy.stopped",
]);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as PromiseLike<unknown>).then === "function";
}

let emitterVersion: string | null | undefined;

/**
 * This package's own version, read from its manifest at runtime rather than imported.
 *
 * Read rather than imported for two reasons: `rootDir` is `src`, so a JSON import of
 * `../package.json` does not compile; and the published manifest carries a release version the
 * source tree never holds, so the literal in the repo is not the number a reader needs. Both `src/`
 * and `dist/` sit one level under the package root, so the relative path is the same either way.
 *
 * Cached after the first read, and never fatal: this field is provenance, and failing to read it
 * must not keep the proxy — a security control — from starting.
 */
function readEmitterVersion(): string | null {
  if (emitterVersion !== undefined) return emitterVersion;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    );
    const version = (manifest as { version?: unknown }).version;
    emitterVersion = typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    emitterVersion = null;
  }
  return emitterVersion;
}

/**
 * Hands events to the observer without letting it affect egress. A sink that throws is an
 * observability bug; it must never become a policy bug or take the proxy down. Swallowed throws are
 * counted instead and reported once at teardown, because the sink is the only transport available.
 */
function createNetworkEventSink(
  onNetworkDecision: ((event: SandboxNetworkEvent) => unknown) | undefined,
): SandboxNetworkEventSink {
  let allowCount = 0;
  let denyCount = 0;
  let sinkErrorCount = 0;
  let droppedEventCount = 0;
  const inflight = new Set<Promise<void>>();
  return {
    emit: (event) => {
      // Counted before the cap, and deliberately: an event the cap drops still happened, so the
      // totals reported at teardown stay correct while `droppedEventCount` says how many individual
      // records are missing. Losing the aggregate as well would make the drop undetectable.
      if (event.event === "sandbox.network.decision") {
        if (event.decision === "allow") allowCount += 1;
        else denyCount += 1;
      }
      if (!onNetworkDecision) return;
      if (
        inflight.size >= SINK_MAX_OUTSTANDING_WRITES &&
        !UNDROPPABLE_SANDBOX_NETWORK_EVENTS.has(event.event)
      ) {
        droppedEventCount += 1;
        return;
      }
      let result: unknown;
      try {
        // Envelope is stamped here and only here. An emit site cannot forget the version, and a
        // future event kind gets it by construction rather than by review.
        result = onNetworkDecision({
          ts: new Date().toISOString(),
          schemaVersion: SANDBOX_NETWORK_EVENT_SCHEMA_VERSION,
          ...event,
        } as SandboxNetworkEvent);
      } catch {
        // Intentionally swallowed: see the doc comment above.
        sinkErrorCount += 1;
        return;
      }
      if (!isPromiseLike(result)) return;
      // The observer writes asynchronously, so its failure arrives as a rejection rather than a
      // throw. The sink attaches the handler itself: that is what keeps a failed observability
      // write from becoming an unhandled rejection *and* makes it countable, which the observer
      // swallowing its own rejection never could.
      const settled = Promise.resolve(result).then(
        () => undefined,
        () => {
          sinkErrorCount += 1;
        },
      );
      inflight.add(settled);
      void settled.then(() => {
        inflight.delete(settled);
      });
    },
    counters: () => ({ allowCount, denyCount, sinkErrorCount, droppedEventCount }),
    drain: async () => {
      const outstanding = Array.from(inflight);
      if (outstanding.length === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SINK_DRAIN_TIMEOUT_MS);
        timer.unref();
      });
      // `settled` never rejects, so this races completion against the budget and nothing else.
      await Promise.race([Promise.all(outstanding).then(() => undefined), budget]);
      if (timer) clearTimeout(timer);
    },
  };
}

function writeProxyError(response: http.ServerResponse, status: number, code: string, message: string): void {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  }).end(body);
}

function connectProxyError(code: string, message: string): string {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
}

async function startNetworkAllowlistProxy(
  allowlist: string[],
  trustedUrls: string[],
  socketPath: string,
  onNetworkDecision?: (event: SandboxNetworkEvent) => unknown,
): Promise<NetworkAllowlistProxy> {
  assertUnixSocketPathLength(socketPath);
  const sink = createNetworkEventSink(onNetworkDecision);
  const rules = [
    ...allowlist.map(parseNetworkAllowlistEntry),
    ...trustedUrls.map(parseTrustedNetworkUrl).filter((rule): rule is NetworkAllowlistRule => rule !== null),
  ];
  if (rules.length === 0) {
    throw new Error(
      'networkScope="allowlist" requires at least one valid networkAllowlist hostname or HTTP(S) networkTrustedUrl.',
    );
  }
  const server = http.createServer((request, response) => {
    const { method, methodSanitized } = describeEventMethod(request.method ?? null);
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "invalid_request_url",
        hostname: null,
        port: null,
        method,
        scheme: null,
        targetSanitized: [],
        methodSanitized,
        tunnelId: null,
      });
      writeProxyError(response, 400, "invalid_request_url", "Paperclip sandbox proxy requires an absolute request URL.");
      return;
    }
    const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
    // WHATWG URL already guarantees a numeric port and a charset-clean scheme here; both are routed
    // through the same helper anyway, so the event record has exactly one bounding path rather than a
    // trusted branch and an untrusted one — and the scheme's length was never guaranteed at all.
    const { hostname, port, scheme, targetSanitized } = describeEventTarget({
      hostname: target.hostname,
      port: targetPort,
      scheme: target.protocol.replace(/:$/, ""),
    });
    if (target.protocol !== "http:") {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "https_requires_connect",
        hostname,
        port,
        method,
        scheme,
        targetSanitized,
        methodSanitized,
        tunnelId: null,
      });
      writeProxyError(response, 400, "https_requires_connect", "HTTPS targets must use CONNECT through the Paperclip sandbox proxy.");
      return;
    }
    const matchedRule = matchNetworkTarget(target.hostname, targetPort, rules);
    if (!matchedRule) {
      sink.emit({
        event: "sandbox.network.decision",
        decision: "deny",
        reason: "network_target_denied",
        hostname,
        port,
        method,
        scheme,
        targetSanitized,
        methodSanitized,
        tunnelId: null,
      });
      writeProxyError(response, 403, "network_target_denied", "Network target denied by Paperclip sandbox policy.");
      return;
    }
    sink.emit({
      event: "sandbox.network.decision",
      decision: "allow",
      reason: matchedRule.source === "trusted_url" ? "trusted_url_match" : "allowlist_match",
      hostname,
      port,
      method,
      scheme,
      targetSanitized,
      methodSanitized,
      tunnelId: null,
    });
    const upstream = http.request(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  /**
   * Tunnels that have been opened and not yet accounted for. Teardown reads this to close the record
   * for a tunnel the client never closed; without it, exactly that tunnel left no event at all.
   */
  const liveTunnels = new Map<string, LiveTunnel>();
  /**
   * The only place `tunnel.closed` is emitted, and idempotent by construction: removal from the
   * registry is the claim on the event, so the teardown flush and the socket-close handler racing
   * each other still produce exactly one event rather than two or none.
   */
  const closeTunnel = (tunnelId: string, closedAtTeardown: boolean): void => {
    const tunnel = liveTunnels.get(tunnelId);
    if (!tunnel || !liveTunnels.delete(tunnelId)) return;
    // Counters come off the socket rather than a transform in the pipe path: Node maintains both
    // natively, so byte accounting costs nothing on the path carrying all confined egress. Read
    // before the destroy — and, at teardown, before the client sockets are destroyed — or the
    // accounting for the tunnel that mattered most is the accounting that is lost.
    const bytesOut = tunnel.upstream?.bytesWritten ?? 0;
    const bytesIn = tunnel.upstream?.bytesRead ?? 0;
    tunnel.upstream?.destroy();
    sink.emit({
      event: "sandbox.network.tunnel.closed",
      tunnelId: tunnel.tunnelId,
      hostname: tunnel.hostname,
      port: tunnel.port,
      targetSanitized: tunnel.targetSanitized,
      bytesOut,
      bytesIn,
      durationMs: Date.now() - tunnel.openedAt,
      closedAtTeardown,
    });
  };
  server.on("connect", (request, clientSocket, head) => {
    const separator = request.url?.lastIndexOf(":") ?? -1;
    const hostname = separator > 0 ? normalizeNetworkHostname(request.url!.slice(0, separator)) : "";
    const port = separator > 0 ? request.url!.slice(separator + 1) : "443";
    // The proxy tunnels CONNECT opaquely, so the method is always the literal verb and the scheme is
    // unknowable. Neither is ever inferred, so neither can have been sanitized — a null scheme yields
    // no "scheme" entry in targetSanitized, which is why that member cannot appear on this path.
    const connectEvent = {
      event: "sandbox.network.decision",
      method: "CONNECT",
      methodSanitized: false,
      ...describeEventTarget({ hostname, port: port || null, scheme: null }),
    } as const;
    // A hostname-only allowlist entry leaves the port unconstrained, so policy cannot reject an
    // out-of-range one — this test is the only thing between the request line and net.connect, which
    // validates the port synchronously and would throw out of this handler into the host process.
    // Both bounds matter: above 65535 throws, and 0 does not throw but retargets, which is a silently
    // wrong connection rather than a denial.
    const portNumber = /^\d+$/.test(port) ? Number(port) : Number.NaN;
    const malformedTarget = !hostname || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535;
    const matchedRule = malformedTarget ? null : matchNetworkTarget(hostname, port, rules);
    if (malformedTarget || !matchedRule) {
      sink.emit({
        ...connectEvent,
        decision: "deny",
        // A malformed CONNECT line and a real policy miss are different signals for alerting, even
        // though the wire response stays identical so egress behaviour does not change.
        reason: malformedTarget ? "invalid_connect_target" : "network_target_denied",
        tunnelId: null,
      });
      clientSocket.end(connectProxyError(
        "network_target_denied",
        "Network target denied by Paperclip sandbox policy.",
      ));
      return;
    }
    // Emitted at the decision point, not in the net.connect callback: this records the policy
    // outcome, which is independent of whether the upstream TCP connection later succeeds.
    const tunnelId = randomUUID();
    sink.emit({
      ...connectEvent,
      decision: "allow",
      reason: matchedRule.source === "trusted_url" ? "trusted_url_match" : "allowlist_match",
      tunnelId,
    });
    // Registered before the connect attempt, so the tunnel is accountable from the moment its
    // decision was recorded rather than from the moment a socket happened to exist.
    liveTunnels.set(tunnelId, {
      tunnelId,
      upstream: null,
      openedAt: Date.now(),
      hostname: connectEvent.hostname,
      port: connectEvent.port,
      targetSanitized: connectEvent.targetSanitized,
    });
    // The validated number, not a second Number(port): the value that passed the range check is the
    // value that reaches the socket.
    let upstream: net.Socket;
    try {
      upstream = net.connect(portNumber, hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    } catch {
      // Second layer, not the control — the range check above is that. net.connect validates its
      // arguments synchronously, so any future unvalidated one would otherwise leave this handler as an
      // uncaught exception and take the host process with it. A throw here is a transport failure, not
      // a policy one, so the allow above stands and no second decision event is emitted; the client
      // gets the same dead socket the asynchronous error path already gives it. The close event still
      // fires, so no allowed tunnelId is left without its correlated end.
      closeTunnel(tunnelId, false);
      clientSocket.destroy();
      return;
    }
    const tunnel = liveTunnels.get(tunnelId);
    if (tunnel) tunnel.upstream = upstream;
    upstream.on("error", () => clientSocket.destroy());
    // The client-socket close seam also covers the failure path, since an upstream error destroys the
    // client socket.
    clientSocket.on("close", () => closeTunnel(tunnelId, false));
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      // Both count sides are reported deliberately: invalid trusted URLs are filtered out silently
      // above, so trustedUrlCount above the trusted rules inside ruleCount is a misconfigured
      // profile this event makes visible.
      sink.emit({
        event: "sandbox.network.proxy.started",
        emitterVersion: readEmitterVersion(),
        allowlistEntryCount: allowlist.length,
        trustedUrlCount: trustedUrls.length,
        ruleCount: rules.length,
        rulesetDigest: computeRulesetDigest(rules),
      });
      resolve();
    });
  });
  let stopEventEmitted = false;
  return {
    close: async () => {
      // Flush surviving tunnels *before* destroying sockets. A tunnel still open at teardown is the
      // long-lived stream to an allowlisted host — the shape this event exists for — and its byte
      // totals only exist while its socket does.
      for (const tunnelId of Array.from(liveTunnels.keys())) closeTunnel(tunnelId, true);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (stopEventEmitted) return;
      stopEventEmitted = true;
      // Drain first, so the counters read below include every decision and tunnel write and so
      // `proxy.stopped` is genuinely last on the stream rather than merely emitted last.
      await sink.drain();
      // Best effort by design: this is the graceful path only, so a hard death of the host process
      // yields a started event with no stopped event — which reads as abnormal termination.
      sink.emit({ event: "sandbox.network.proxy.stopped", ...sink.counters() });
      await sink.drain();
    },
  };
}

async function createNetworkProxyBridge(): Promise<string> {
  const source = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const socketPath = process.argv[2];
const executable = process.argv[3];
const args = process.argv.slice(4);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${SANDBOX_PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(executable, args, { stdio: "inherit", env: process.env });
  const forward = (signal) => { if (!child.killed) child.kill(signal); };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("exit", (code, signal) => server.close(() => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 1 : code);
  }));
});
`;
  return source.trimStart();
}

export async function buildLocalProcessSandboxSpawnTarget(input: {
  executable: string;
  args: string[];
  cwd: string;
  options: LocalProcessSandboxOptions;
}): Promise<LocalProcessSandboxSpawnTarget> {
  if (process.platform !== "linux") {
    throw new Error("Local process filesystem and network scopes are currently supported only on Linux.");
  }
  const filesystemScope = input.options.filesystemScope ?? null;
  const networkScope = input.options.networkScope ?? null;
  if (!filesystemScope && !networkScope) throw new Error("Local process sandbox requires a filesystem or network scope.");

  const workspaceDir = normalizeAbsolutePath(input.options.workspaceDir, "Sandbox workspaceDir");
  const cwd = normalizeAbsolutePath(input.cwd, "Sandbox cwd");
  if (filesystemScope === "workspace") {
    const relativeCwd = path.relative(workspaceDir, cwd);
    if (relativeCwd.startsWith("..") || path.isAbsolute(relativeCwd)) {
      throw new Error(`Sandbox cwd "${cwd}" must be inside workspaceDir "${workspaceDir}".`);
    }
    const outboundRestorePaths = (input.options.outboundRestorePaths ?? []).map((candidate, index) =>
      normalizeAbsolutePath(candidate, `Sandbox outboundRestorePaths[${index}]`));
    for (const [index, extraPath] of (input.options.extraPaths ?? []).entries()) {
      if (extraPath.access !== "rw") continue;
      const normalizedExtraPath = normalizeAbsolutePath(extraPath.path, `Sandbox extraPaths[${index}].path`);
      const relativeToWorkspace = path.relative(workspaceDir, normalizedExtraPath);
      const synchronized = !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace);
      const restored = outboundRestorePaths.some((restorePath) => {
        const relative = path.relative(restorePath, normalizedExtraPath);
        return !relative.startsWith("..") && !path.isAbsolute(relative);
      });
      if (!synchronized && !restored) {
        throw new Error(
          `Writable sandbox path "${normalizedExtraPath}" is outside synchronized workspace "${workspaceDir}" and has no outbound restore mapping.`,
        );
      }
    }
  }

  const bwrapCommand = input.options.command?.trim() || "bwrap";
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts"];
  const env: Record<string, string | undefined> = {};
  let cleanup: (() => Promise<void>) | undefined;
  let executable = input.executable;
  let executableArgs = input.args;

  if (filesystemScope === "workspace") {
    args.push("--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
    args.push(
      "--symlink", "usr/bin", "/bin",
      "--symlink", "usr/sbin", "/sbin",
      "--symlink", "usr/lib", "/lib",
      "--symlink", "usr/lib64", "/lib64",
    );
    const created = new Set<string>(["/", "/proc", "/dev", "/tmp"]);
    const mounted = new Set<string>();
    const mount = async (source: string, access: LocalProcessSandboxAccess) => {
      const normalized = normalizeAbsolutePath(source, "Sandbox path");
      if (mounted.has(normalized) || !(await pathExists(normalized))) return;
      addParentDirectories(args, created, normalized);
      args.push(access === "rw" ? "--bind" : "--ro-bind", normalized, normalized);
      mounted.add(normalized);
      created.add(normalized);
    };
    for (const systemPath of SYSTEM_READ_PATHS) await mount(systemPath, "ro");
    for (const executablePath of await executableReadPaths(input.executable)) await mount(executablePath, "ro");
    if (networkScope === "allowlist") {
      for (const nodePath of await executableReadPaths(process.execPath)) await mount(nodePath, "ro");
    }
    for (const managedPath of input.options.managedPaths ?? []) await mount(managedPath.path, managedPath.access);
    for (const extraPath of input.options.extraPaths ?? []) await mount(extraPath.path, extraPath.access);
    await mount(workspaceDir, "rw");
    for (const [index, alias] of (input.options.pathAliases ?? []).entries()) {
      const aliasPath = normalizeAbsolutePath(alias.path, `Sandbox pathAliases[${index}].path`);
      const aliasTarget = normalizeAbsolutePath(alias.target, `Sandbox pathAliases[${index}].target`);
      const relativeTarget = path.relative(workspaceDir, aliasTarget);
      if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
        throw new Error(
          `Sandbox path alias "${aliasPath}" must target the synchronized workspace "${workspaceDir}".`,
        );
      }
      if (!(await pathExists(aliasTarget))) {
        throw new Error(`Sandbox path alias target "${aliasTarget}" does not exist.`);
      }
      addParentDirectories(args, created, aliasPath);
      args.push("--bind", aliasTarget, aliasPath);
      created.add(aliasPath);
    }

    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
        input.options.onNetworkDecision,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      await mount(tempDir, "rw");
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  } else {
    args.push("--bind", "/", "/");
    if (networkScope === "allowlist") {
      const tempDir = await createNetworkProxyTempDir();
      const socketPath = path.join(tempDir, "proxy.sock");
      const bridgePath = path.join(tempDir, "bridge.cjs");
      await fs.writeFile(bridgePath, await createNetworkProxyBridge(), { mode: 0o500 });
      const proxy = await startNetworkAllowlistProxy(
        input.options.networkAllowlist ?? [],
        input.options.networkTrustedUrls ?? [],
        socketPath,
        input.options.onNetworkDecision,
      ).catch(async (error) => {
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
      });
      executable = process.execPath;
      executableArgs = [bridgePath, socketPath, input.executable, ...input.args];
      cleanup = async () => {
        await proxy.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      };
    }
  }

  if (networkScope) {
    args.push("--unshare-net");
    for (const key of PROXY_ENV_KEYS) env[key] = undefined;
    env.NO_PROXY = "";
    env.no_proxy = "";
  }
  if (networkScope === "allowlist") {
    const proxyUrl = `http://127.0.0.1:${SANDBOX_PROXY_PORT}`;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }

  args.push("--chdir", cwd, "--", executable, ...executableArgs);
  return { command: bwrapCommand, args, cwd: "/", env, cleanup };
}

export function parseLocalProcessSandboxExtraPaths(value: unknown): LocalProcessSandboxPath[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: normalizeAbsolutePath(entry, `filesystemExtraPaths[${index}]`), access: "ro" };
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`filesystemExtraPaths[${index}] must be an absolute path or { path, access } object.`);
    }
    const raw = entry as Record<string, unknown>;
    const access = raw.access === "rw" ? "rw" : raw.access === "ro" || raw.access == null ? "ro" : null;
    if (!access || typeof raw.path !== "string") {
      throw new Error(`filesystemExtraPaths[${index}] must use access "ro" or "rw" and an absolute path.`);
    }
    return { path: normalizeAbsolutePath(raw.path, `filesystemExtraPaths[${index}].path`), access };
  });
}
