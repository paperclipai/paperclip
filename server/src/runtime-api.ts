import os from "node:os";

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isLoopbackHost(host: string): boolean {
  // WHATWG `URL.hostname` keeps IPv6 in brackets ("[::1]"), so strip them before
  // comparing or an explicitly configured IPv6 loopback reads as non-loopback.
  const normalized = stripIpv6Brackets(normalizeHost(host).toLowerCase());
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

// The in-process listener is plaintext `node:http`; TLS terminates upstream.
// Candidates synthesized as `<host>:<listenPort>` must not inherit the public
// `https:` scheme, or they fail the TLS handshake instantly and leave the
// fallback list with no usable entry. (REL-223)
const LISTENER_PROTOCOL = "http:";

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
  pushCandidate(candidates, seen, input.preferredApiUrl);
  pushCandidate(candidates, seen, explicitOrigin);

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host) continue;
    pushCandidate(candidates, seen, formatOrigin(LISTENER_PROTOCOL, host, input.port));
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost)) {
    pushCandidate(candidates, seen, formatOrigin(LISTENER_PROTOCOL, bindHost, input.port));
  }

  if (explicitOrigin) {
    const hostname = new URL(explicitOrigin).hostname;
    if (isLoopbackHost(hostname)) {
      pushCandidate(candidates, seen, formatOrigin(LISTENER_PROTOCOL, "host.docker.internal", input.port));
    }
  }

  for (const host of collectReachableInterfaceHosts({ networkInterfacesMap: input.networkInterfacesMap })) {
    pushCandidate(candidates, seen, formatOrigin(LISTENER_PROTOCOL, host, input.port));
  }

  // Loopback goes last so it never reorders an existing preference; it is the
  // always-reachable fallback for runs executing on the listener's own machine. (REL-223)
  pushCandidate(candidates, seen, formatOrigin(LISTENER_PROTOCOL, "127.0.0.1", input.port));

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

/** Origin for endpoints the *agent run itself* dials (MCP servers, in-run broker). (REL-223) */
export function chooseRuntimeDialOrigin(input: {
  configuredApiUrl: string | null | undefined;
  listenPort: string | number | null | undefined;
  localExecution: boolean;
  /** The address the listener is bound to (`PAPERCLIP_LISTEN_HOST`). */
  bindHost?: string | null;
}): string | null {
  const configured = normalizeHost(input.configuredApiUrl ?? "");
  if (!configured) return null; // never conjure an origin
  if (!input.localExecution) return configured; // remote: 127.0.0.1 is the wrong machine
  try {
    if (isLoopbackHost(new URL(configured).hostname)) return configured; // worktree on its own port
  } catch {
    // Unparseable: fall through to substitution.
  }
  // A listener bound to one specific non-loopback address (tailnet/custom bind)
  // is NOT serving 127.0.0.1, so substituting loopback would hand the run a dead
  // URL. Only wildcard and loopback binds actually answer on loopback.
  const bindHost = normalizeHost(input.bindHost ?? "");
  if (bindHost && !isWildcardHost(bindHost) && !isLoopbackHost(bindHost)) {
    return configured;
  }
  const port = normalizeHost(String(input.listenPort ?? ""));
  if (!/^\d+$/.test(port)) return configured;
  return formatOrigin(LISTENER_PROTOCOL, "127.0.0.1", Number(port));
}
