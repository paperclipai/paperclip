import dns from "node:dns/promises";
import os from "node:os";

/** Per-hostname DNS timeout. Ranking every candidate must stay bounded too. */
const DEFAULT_LOOKUP_TIMEOUT_MS = 500;
/** Per-candidate probe timeout. One dead candidate must not stall startup. */
const DEFAULT_PROBE_TIMEOUT_MS = 600;
/** Total time startup is willing to spend probing every candidate combined. */
const DEFAULT_PROBE_BUDGET_MS = 1_200;

/** The candidate hostname resolves to (or is) the address the server bound. */
const RANK_MATCHES_BIND = 0;
/** The candidate hostname does not resolve at all; unknown, not disqualified. */
const RANK_UNRESOLVED = 1;
/** The candidate hostname resolves somewhere the server is not listening. */
const RANK_RESOLVES_ELSEWHERE = 2;

function normalizeHost(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function canonicalHost(value: string | null | undefined): string {
  return stripBrackets(normalizeHost(value)).toLowerCase();
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
  const protocol = explicitOrigin ? new URL(explicitOrigin).protocol : "http:";

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

export type RuntimeApiLookupHost = (hostname: string) => Promise<string[]>;
export type RuntimeApiProbe = (origin: string) => Promise<boolean>;

export type RuntimeApiResolutionReason =
  /** Config named the public origin outright; nothing to discover. */
  | "explicit-public-base-url"
  /** A loopback bind only ever answers on loopback, whatever else is allow-listed. */
  | "loopback-bind"
  /** DNS ranking only; the caller asked us not to probe (e.g. before listen). */
  | "resolve-rank"
  /** A candidate answered an HTTP probe. */
  | "probe"
  /** Nothing answered; we fall back to the best DNS-ranked candidate. */
  | "unreachable-fallback";

export interface RuntimeApiCandidateRanking {
  url: string;
  hostname: string;
  rank: number;
  addresses: string[];
}

export interface RuntimeApiResolution {
  url: string;
  reason: RuntimeApiResolutionReason;
  /** Ranked candidates, with the chosen URL first. */
  candidates: string[];
  probed: Array<{ url: string; reachable: boolean }>;
  /** Candidates never probed, because one already answered or the budget ran out. */
  skipped: string[];
}

async function defaultLookupHost(hostname: string): Promise<string[]> {
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
}

/**
 * `dns.lookup` has no timeout of its own, and the probe budget below only covers
 * probing. Without this, one wedged resolver stalls startup before a single
 * candidate is probed.
 */
function withLookupTimeout(lookupHost: RuntimeApiLookupHost, timeoutMs: number): RuntimeApiLookupHost {
  return async (hostname) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        lookupHost(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`DNS lookup for ${hostname} timed out`)), timeoutMs);
        }),
      ]);
    } catch {
      // A name that does not resolve, or resolves too slowly to be worth
      // waiting for, is unknown rather than disqualified: split-horizon DNS and
      // hosts-file entries differ between the server and its agents.
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function createDefaultProbe(timeoutMs: number): RuntimeApiProbe {
  return async (origin) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Any HTTP response proves a listener is there. The status does not
      // matter, so an auth change on /api/health cannot silently break this.
      await fetch(new URL("/api/health", origin), { redirect: "manual", signal: controller.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Order candidate origins by whether their hostname resolves to the address the
 * server actually bound. `allowedHostnames` is a Host-header accept list, so its
 * order says nothing about reachability: on a tailnet-bound host the short
 * machine name can also exist in the cloud provider's internal DNS and point at
 * an address with no listener.
 */
export async function rankRuntimeApiCandidatesByBindAddress(input: {
  candidates: string[];
  bindHost: string;
  lookupHost?: RuntimeApiLookupHost;
  lookupTimeoutMs?: number;
}): Promise<RuntimeApiCandidateRanking[]> {
  const lookupHost = withLookupTimeout(
    input.lookupHost ?? defaultLookupHost,
    input.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
  );
  const bindHost = canonicalHost(input.bindHost);
  // A wildcard bind answers on every address, so DNS carries no signal about
  // which candidate is reachable. Leave the caller's order alone.
  const rankable = Boolean(bindHost) && !isWildcardHost(bindHost);

  const ranked = await Promise.all(
    input.candidates.map(async (url, index) => {
      const hostname = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return "";
        }
      })();

      if (!rankable || !hostname) {
        return { url, hostname, rank: RANK_MATCHES_BIND, addresses: [] as string[], index };
      }
      if (canonicalHost(hostname) === bindHost) {
        return { url, hostname, rank: RANK_MATCHES_BIND, addresses: [bindHost], index };
      }

      const addresses = await lookupHost(hostname).catch(() => [] as string[]);
      const rank = addresses.some((address) => canonicalHost(address) === bindHost)
        ? RANK_MATCHES_BIND
        : addresses.length === 0
          ? RANK_UNRESOLVED
          : RANK_RESOLVES_ELSEWHERE;
      return { url, hostname, rank, addresses, index };
    }),
  );

  return ranked
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ url, hostname, rank, addresses }) => ({ url, hostname, rank, addresses }));
}

/**
 * Pick the origin agents should dial for the control plane.
 *
 * Replaces the old "first allow-listed hostname wins" derivation, which was pure
 * array order and handed agents an unreachable name whenever a better one sat
 * later in the list. Candidates are ranked by DNS against the bind address and
 * then probed in that order; the first origin that answers wins.
 *
 * Pass `probe: false` before the server is listening — every probe would fail
 * against its own not-yet-open port — and call again afterwards to promote.
 */
export async function resolveRuntimeApiUrl(input: {
  authPublicBaseUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  probe?: boolean;
  probeBudgetMs?: number;
  probeTimeoutMs?: number;
  lookupHost?: RuntimeApiLookupHost;
  lookupTimeoutMs?: number;
  probeOrigin?: RuntimeApiProbe;
  now?: () => number;
}): Promise<RuntimeApiResolution> {
  const explicitPublicBaseUrl = input.authPublicBaseUrl?.trim();
  if (explicitPublicBaseUrl) {
    try {
      const origin = new URL(explicitPublicBaseUrl).origin;
      return { url: origin, reason: "explicit-public-base-url", candidates: [origin], probed: [], skipped: [] };
    } catch {
      // Fall through to derived candidates if config parsing drifted.
    }
  }

  const bindHost = normalizeHost(input.bindHost);
  if (bindHost && !isWildcardHost(bindHost) && isLoopbackHost(bindHost)) {
    const origin = formatOrigin("http:", bindHost, input.port);
    return { url: origin, reason: "loopback-bind", candidates: [origin], probed: [], skipped: [] };
  }

  const ranked = await rankRuntimeApiCandidatesByBindAddress({
    candidates: buildRuntimeApiCandidateUrls({
      authPublicBaseUrl: input.authPublicBaseUrl,
      allowedHostnames: input.allowedHostnames,
      bindHost: input.bindHost,
      port: input.port,
      networkInterfacesMap: input.networkInterfacesMap,
    }),
    bindHost: input.bindHost,
    lookupHost: input.lookupHost,
    lookupTimeoutMs: input.lookupTimeoutMs,
  });
  const rankedUrls = ranked.map((entry) => entry.url);
  const bestRankedUrl = rankedUrls[0] ?? formatOrigin("http:", "localhost", input.port);

  if (input.probe === false) {
    return {
      url: bestRankedUrl,
      reason: "resolve-rank",
      candidates: rankedUrls.length > 0 ? rankedUrls : [bestRankedUrl],
      probed: [],
      skipped: rankedUrls.slice(1),
    };
  }

  const now = input.now ?? Date.now;
  const probeBudgetMs = input.probeBudgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const probeOrigin = input.probeOrigin ?? createDefaultProbe(input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);

  const probed: Array<{ url: string; reachable: boolean }> = [];
  const skipped: string[] = [];
  const startedAt = now();
  let reachableUrl: string | null = null;

  for (const url of rankedUrls) {
    if (reachableUrl) {
      skipped.push(url);
      continue;
    }
    // The top-ranked candidate is always probed. After that a spent budget means
    // we hand back the ranked pick rather than stalling startup on N timeouts.
    if (probed.length > 0 && now() - startedAt >= probeBudgetMs) {
      skipped.push(url);
      continue;
    }
    const reachable = await probeOrigin(url).catch(() => false);
    probed.push({ url, reachable });
    if (reachable) reachableUrl = url;
  }

  const url = reachableUrl ?? bestRankedUrl;
  return {
    url,
    reason: reachableUrl ? "probe" : "unreachable-fallback",
    candidates: [url, ...rankedUrls.filter((candidate) => candidate !== url)],
    probed,
    skipped,
  };
}
