import os from "node:os";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function isWildcardHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function isLinkLocalHost(host: string): boolean {
  const normalized = normalizeHost(host).toLowerCase();
  if (normalized.startsWith("169.254.")) return true;
  // IPv6 link-local block is fe80::/10 (fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  return false;
}

function formatOrigin(protocol: string, host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") && !host.endsWith("]")
    ? `[${host}]`
    : host;
  return `${protocol}//${normalizedHost}:${port}`;
}

function pushCandidate(
  candidates: string[],
  seen: Set<string>,
  rawUrl: string | null | undefined,
): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  try {
    const normalized = new URL(trimmed).origin;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  } catch {
    // Ignore malformed candidates.
  }
}

export function choosePrimaryRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
}): string {
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim();
  if (explicitPublicBaseUrl) {
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      // Fall through to derived candidates if config parsing drifted.
    }
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost) && isLoopbackHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  const allowedHostname = input.allowedHostnames
    .map((value) => value.trim())
    .find(Boolean);
  if (allowedHostname) {
    return formatOrigin("http:", allowedHostname, input.port);
  }

  if (bindHost && !isWildcardHost(bindHost)) {
    return formatOrigin("http:", bindHost, input.port);
  }

  return formatOrigin("http:", "localhost", input.port);
}

/**
 * Whether the operator opted into local API calls for agent runtimes.
 *
 * A self-hosted deployment often puts an authenticating edge in front of the
 * public origin (Cloudflare Access, an SSO reverse proxy, a WAF). That origin is
 * the right one for browsers, OAuth callbacks, and inbound webhooks, but an
 * agent process has no interactive session at that edge, so every request it
 * makes to `PAPERCLIP_API_URL` is answered with a login redirect instead of the
 * API. Opting in keeps the public origin for user-facing links and points agent
 * runtimes at the server's own listener instead.
 */
export function localRuntimeApiCallsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = normalizeHost(env.PAPERCLIP_ALLOW_LOCAL_API_CALLS).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Whether the operator accepted sending run credentials over cleartext HTTP to a
 * non-loopback address. Agents authenticate with a bearer key, so an `http://`
 * origin that leaves the host exposes that key to anyone on the path. Loopback
 * never leaves the host and needs no acknowledgement.
 */
function insecureLocalHttpAcknowledged(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeHost(env.PAPERCLIP_LOCAL_API_ALLOW_INSECURE_HTTP).toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Whether the host has an IPv4 loopback address at all. An IPv6-only host has
 * no `127.0.0.0/8` interface, so `127.0.0.1` is not an address anything there
 * can connect to.
 */
function hostHasIpv4Loopback(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): boolean {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && normalizeHost(entry.address).startsWith("127."))
        return true;
    }
  }
  return false;
}

/**
 * The loopback host the listener answers on, or `null` when the bind host is a
 * specific non-loopback address.
 *
 * The derived host has to be one the listener actually answers on, in a family
 * the host actually has:
 *
 * - A specific loopback bind (`::1`, `127.0.0.1`) answers on that address only,
 *   so it is kept verbatim.
 * - `0.0.0.0` is an IPv4 wildcard, so IPv4 loopback is the only choice.
 * - `localhost` is a *name*, not a wildcard: `server.listen(port, "localhost")`
 *   resolves it and binds the single address that lookup returned, which on a
 *   dual-stack host can be `::1` even though IPv4 loopback also exists. Picking
 *   an address here would be a guess at that resolution, so the name is kept
 *   and the agent resolves it exactly as the listener did.
 * - `::` and an unset bind host are wildcards and depend on the host's stack. A
 *   dual-stack `::` listener answers `127.0.0.1` through v4-mapped addresses,
 *   but an IPv6-only host has no IPv4 loopback at all, so `127.0.0.1` would
 *   hand agents an address they cannot connect to. Prefer IPv4 loopback when
 *   the host has it and fall back to `::1` when it does not.
 */
function deriveLoopbackHost(
  bindHost: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | null {
  const normalized = normalizeHost(bindHost).toLowerCase();
  if (normalized === "::1") return "::1";
  if (normalized === "127.0.0.1") return "127.0.0.1";
  if (normalized === "0.0.0.0") return "127.0.0.1";
  if (normalized === "localhost") return "localhost";
  if (!normalized || normalized === "::") {
    return hostHasIpv4Loopback(interfaces) ? "127.0.0.1" : "::1";
  }
  return null;
}

/**
 * The origin agent runtimes should call when local API calls are allowed, or
 * `null` when the operator has not opted in (the default, which leaves every
 * existing deployment on its public origin), or when no safe local origin can be
 * derived.
 *
 * The local listener serves plain HTTP, so a derived origin stays on loopback:
 * deriving a LAN address would hand agents an `http://` origin that carries their
 * bearer key across a network, silently downgrading an HTTPS deployment. A
 * deployment whose runtime cannot reach loopback — an agent in a bridged
 * container, or one on a tailnet — names the address explicitly with
 * `PAPERCLIP_LOCAL_API_URL`, which must be HTTPS unless it points at loopback or
 * the operator also sets `PAPERCLIP_LOCAL_API_ALLOW_INSECURE_HTTP`.
 */
export function resolveLocalRuntimeApiUrl(input: {
  bindHost: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string | null {
  const env = input.env ?? process.env;
  if (!localRuntimeApiCallsEnabled(env)) return null;

  const explicit = normalizeHost(env.PAPERCLIP_LOCAL_API_URL);
  if (explicit) {
    const override = parseLocalApiOverride(explicit, env);
    if (override) return override;
    // A rejected override falls through to the derived origin rather than
    // failing startup: losing the opt-in is recoverable, a dead server is not.
  }

  const host = deriveLoopbackHost(
    input.bindHost,
    input.networkInterfacesMap ?? os.networkInterfaces(),
  );
  // A specific non-loopback bind host is the only address the listener answers
  // on, and it is reachable over cleartext HTTP from off the host, so it is not
  // derived automatically. The operator opts into it by name instead.
  if (!host) return null;
  return formatOrigin("http:", host, input.port);
}

/**
 * Adapter types that spawn their agent process on the Paperclip host, and so
 * share the server's loopback.
 *
 * This is an allow-list on purpose. The inverse — naming the remote adapters —
 * fails open: a newly added remote adapter is absent from the list by default
 * and silently inherits a loopback origin, which is the failure this whole
 * function exists to prevent. An adapter missing from the allow-list instead
 * keeps today's public origin, so the cost of forgetting one is "the opt-in
 * does not apply there" rather than "that adapter is handed an address on
 * someone else's machine".
 *
 * Deliberately excluded: `cursor_cloud` (third-party cloud worker),
 * `hermes_gateway` and `openclaw_gateway` (agent reached over HTTP on another
 * host), `http` (invokes an operator-supplied remote `url`), and `acpx_local`
 * (retired tombstone that never executes).
 */
const LOCAL_RUNTIME_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "paperclip_runner",
  "pi_local",
  "process",
]);

/**
 * Whether the opt-in local API origin is reachable from a given runtime.
 *
 * `PAPERCLIP_ALLOW_LOCAL_API_CALLS` exists so a co-located agent can bypass an
 * authenticating edge that it cannot pass. The premise only holds when the agent
 * process runs in the server's own network: a remote worker handed
 * `http://127.0.0.1:3100` resolves that to itself, not to Paperclip, so its
 * status updates and comments fail. Such a runtime keeps `PAPERCLIP_API_URL`,
 * which it can reach and whose edge it is expected to satisfy.
 *
 * Unrecognized adapter types are treated as unreachable. The origin returned
 * here carries run-scoped credentials to the managed MCP gateways, the
 * runtime-tools routes, and the GitHub credential broker, so guessing "local"
 * for an adapter nobody has classified would aim those at an address on a host
 * the operator may not own.
 */
export function runtimeCanReachLocalApi(input: {
  adapterType?: string | null;
  executionTargetKind?: string | null;
}): boolean {
  const adapterType = normalizeHost(input.adapterType).toLowerCase();
  if (!LOCAL_RUNTIME_ADAPTER_TYPES.has(adapterType)) return false;
  // An absent target is local; "remote" covers SSH and sandbox transports, none
  // of which share the server's loopback.
  const targetKind = normalizeHost(input.executionTargetKind).toLowerCase();
  if (targetKind && targetKind !== "local") return false;
  return true;
}

/**
 * The normalized origin for a `PAPERCLIP_LOCAL_API_URL` value, or `null` when it
 * is unusable: unparseable, a non-HTTP scheme such as `file:` that cannot serve
 * API calls, or cleartext HTTP to a non-loopback address without the explicit
 * insecure acknowledgement.
 */
function parseLocalApiOverride(value: string, env: NodeJS.ProcessEnv): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  if (parsed.protocol === "http:") {
    const host = normalizeHost(parsed.hostname).replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(host) && !insecureLocalHttpAcknowledged(env)) return null;
  }

  return parsed.origin;
}

export function collectReachableInterfaceHosts(input: {
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
} = {}): string[] {
  const interfaces = input.networkInterfacesMap ?? os.networkInterfaces();
  const rankedHosts: Array<{ host: string; rank: number; index: number }> = [];
  const seen = new Set<string>();
  let index = 0;

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const host = normalizeHost(entry.address);
      if (!host || isLoopbackHost(host) || isWildcardHost(host) || isLinkLocalHost(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      rankedHosts.push({
        host,
        rank: entry.family === "IPv4" ? 0 : 1,
        index: index++,
      });
    }
  }

  return rankedHosts
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.host);
}

export function buildRuntimeApiCandidateUrls(input: {
  /**
   * Opt-in local origin from {@link resolveLocalRuntimeApiUrl}. It leads the list
   * because an authenticating edge in front of the public origin rejects agent
   * runtimes outright, so falling back to it first would waste every retry.
   */
  localApiUrl?: string | null;
  preferredApiUrl?: string | null;
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim() ?? "";
  const explicitOrigin = (() => {
    if (!explicitPublicBaseUrl) return null;
    try {
      return new URL(explicitPublicBaseUrl).origin;
    } catch {
      return null;
    }
  })();
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

  pushCandidate(candidates, seen, input.localApiUrl);
  pushCandidate(candidates, seen, input.preferredApiUrl);
  pushCandidate(candidates, seen, explicitOrigin);

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(protocol, bindHost, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(protocol, "host.docker.internal", input.port));
    }
  }

  for (const host of collectReachableInterfaceHosts({ networkInterfacesMap: input.networkInterfacesMap })) {
    pushCandidate(candidates, seen, formatOrigin(protocol, host, input.port));
  }

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.authPublicBaseUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}
