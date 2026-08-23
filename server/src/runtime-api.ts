import os from "node:os";
import { isIP } from "node:net";

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

function parseIpv4Address(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const parsed = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN;
    return Number(part);
  });
  if (parsed.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parsed as [number, number, number, number];
}

function normalizeOrigin(rawUrl: string | null | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function normalizeHostname(host: string | null | undefined): string | null {
  const trimmed = normalizeHost(host).toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/^\[|\]$/g, "");
}

function sameHostname(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeHostname(left);
  const normalizedRight = normalizeHostname(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function isInternalRuntimeHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  if (!normalized) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const octets = parseIpv4Address(normalized);
    if (!octets) return false;
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (ipVersion === 6) {
    return normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
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
  const interfaces = (() => {
    if (input.networkInterfacesMap) return input.networkInterfacesMap;
    try {
      return os.networkInterfaces();
    } catch {
      return {};
    }
  })();
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

export function collectInternalRuntimeInterfaceHosts(input: {
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
} = {}): string[] {
  return collectReachableInterfaceHosts(input).filter((host) => isInternalRuntimeHost(host));
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

export function buildLocalRuntimeApiCandidateUrls(input: {
  preferredRuntimeApiUrl?: string | null;
  publicApiUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const publicOrigin = normalizeOrigin(input.publicApiUrl);
  const publicHostname = publicOrigin ? new URL(publicOrigin).hostname : null;
  const bindHost = normalizeHost(input.bindHost);
  const internalInterfaceHosts = collectInternalRuntimeInterfaceHosts({
    networkInterfacesMap: input.networkInterfacesMap,
  });
  const otherInterfaceHosts = collectReachableInterfaceHosts({
    networkInterfacesMap: input.networkInterfacesMap,
  }).filter((host) => !internalInterfaceHosts.includes(host));
  const loopbackOrigin = (() => {
    if (bindHost === "0.0.0.0") return formatOrigin("http:", "127.0.0.1", input.port);
    if (bindHost === "::") return formatOrigin("http:", "::1", input.port);
    if (bindHost && isLoopbackHost(bindHost)) return formatOrigin("http:", bindHost, input.port);
    return null;
  })();

  pushCandidate(candidates, seen, input.preferredRuntimeApiUrl);

  if (bindHost && !isWildcardHost(bindHost) && !isLoopbackHost(bindHost) && !sameHostname(bindHost, publicHostname)) {
    pushCandidate(candidates, seen, formatOrigin("http:", bindHost, input.port));
  }

  for (const host of internalInterfaceHosts) {
    if (sameHostname(host, publicHostname)) continue;
    pushCandidate(candidates, seen, formatOrigin("http:", host, input.port));
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHost(rawHost);
    if (!host || sameHostname(host, publicHostname)) continue;
    pushCandidate(candidates, seen, formatOrigin("http:", host, input.port));
  }

  if (loopbackOrigin) {
    pushCandidate(candidates, seen, loopbackOrigin);
    pushCandidate(candidates, seen, formatOrigin("http:", "host.docker.internal", input.port));
  }

  for (const host of otherInterfaceHosts) {
    if (sameHostname(host, publicHostname)) continue;
    pushCandidate(candidates, seen, formatOrigin("http:", host, input.port));
  }

  pushCandidate(candidates, seen, publicOrigin);

  if (candidates.length === 0) {
    pushCandidate(
      candidates,
      seen,
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: input.publicApiUrl,
        allowedHostnames: input.allowedHostnames,
        bindHost: input.bindHost,
        port: input.port,
      }),
    );
  }

  return candidates;
}

export function choosePrimaryLocalRuntimeApiUrl(input: {
  preferredRuntimeApiUrl?: string | null;
  publicApiUrl?: string | null;
  allowedHostnames: string[];
  bindHost: string;
  port: number;
  networkInterfacesMap?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}): string {
  return (
    buildLocalRuntimeApiCandidateUrls(input)[0]
    ?? choosePrimaryRuntimeApiUrl({
      authPublicBaseUrl: input.publicApiUrl,
      allowedHostnames: input.allowedHostnames,
      bindHost: input.bindHost,
      port: input.port,
    })
  );
}
