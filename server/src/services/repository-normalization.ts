import { unprocessable } from "../errors.js";

const SUPPORTED_REPOSITORY_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);
const SENSITIVE_METADATA_KEY = /(?:^|[_-])(auth(?:orization)?|cookie|credential|key|password|private[_-]?key|secret|token)(?:$|[_-])/i;

export interface NormalizedRepositoryLocator {
  host: string;
  owner: string;
  name: string;
  cloneUrl: string;
  webUrl: string;
  identityPath: string;
}

function normalizeRepositoryPath(rawPath: string) {
  const path = rawPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) {
    throw unprocessable("Repository URL must include an owner and repository name");
  }
  const name = segments.at(-1)!;
  const owner = segments.slice(0, -1).join("/");
  return { owner, name, path: `${owner}/${name}` };
}

export function normalizeRepositoryLocator(rawLocator: string): NormalizedRepositoryLocator {
  const raw = rawLocator.trim();
  const scpMatch = /^([^/@:]+)@([^/:]+):(.+)$/.exec(raw);
  if (scpMatch) {
    const host = scpMatch[2]!.toLowerCase();
    const normalizedPath = normalizeRepositoryPath(scpMatch[3]!);
    const hasGitSuffix = /\.git$/i.test(scpMatch[3]!);
    return {
      host,
      owner: normalizedPath.owner,
      name: normalizedPath.name,
      cloneUrl: `${scpMatch[1]}@${host}:${normalizedPath.path}${hasGitSuffix ? ".git" : ""}`,
      webUrl: `https://${host}/${normalizedPath.path}`,
      identityPath: normalizedPath.path.toLowerCase(),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unprocessable("Repository URL must be an HTTP(S), SSH, Git, or scp-style URL");
  }
  if (!SUPPORTED_REPOSITORY_PROTOCOLS.has(parsed.protocol)) {
    throw unprocessable("Repository URL protocol is not supported");
  }
  const sshUsername = parsed.protocol === "ssh:" ? parsed.username : "";
  if (parsed.password || (parsed.protocol !== "ssh:" && parsed.username)) {
    throw unprocessable("Repository URL must not contain embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw unprocessable("Repository URL must not contain query parameters or fragments");
  }

  const host = parsed.host.toLowerCase();
  if (!host) throw unprocessable("Repository URL must include a host");
  const normalizedPath = normalizeRepositoryPath(parsed.pathname);
  const hasGitSuffix = /\.git\/?$/i.test(parsed.pathname);
  const cloneUrl = `${parsed.protocol}//${sshUsername ? `${sshUsername}@` : ""}${host}/${normalizedPath.path}${hasGitSuffix ? ".git" : ""}`;
  return {
    host,
    owner: normalizedPath.owner,
    name: normalizedPath.name,
    cloneUrl,
    webUrl: `https://${host}/${normalizedPath.path}`,
    identityPath: normalizedPath.path.toLowerCase(),
  };
}

export function manualRepositoryIdentityKey(locator: Pick<NormalizedRepositoryLocator, "host" | "identityPath">) {
  return `manual:${locator.host}/${locator.identityPath}`;
}

export function normalizeRepositoryWebUrl(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw unprocessable("Repository web URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw unprocessable("Repository web URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw unprocessable("Repository web URL must not contain credentials, query parameters, or fragments");
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeRepositoryHost(rawHost: string) {
  const trimmed = rawHost.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw unprocessable("Repository host is invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw unprocessable("Repository host must not contain credentials, paths, query parameters, or fragments");
  }
  return parsed.host.toLowerCase();
}

export function providerRepositoryIdentityKey(input: {
  provider: string;
  host: string;
  providerRepositoryId: string;
}) {
  return `${input.provider.toLowerCase()}:${input.host.toLowerCase()}:${input.providerRepositoryId}`;
}

export function sanitizeRepositoryProviderMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const sanitize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sanitize);
    if (!input || typeof input !== "object") return input;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      if (SENSITIVE_METADATA_KEY.test(normalizedKey)) continue;
      output[key] = sanitize(entry);
    }
    return output;
  };

  return sanitize(value) as Record<string, unknown>;
}

export function sanitizeRepositoryProviderError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? "Repository provider operation failed");
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:access[_-]?token|auth(?:orization)?|credential|key|password|secret|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b((?:access[_-]?token|auth(?:orization)?|credential|key|password|secret|token)\s*[:=]\s*)(?:Bearer\s+)?\S+/gi, "$1[redacted]")
    .slice(0, 1_000);
}
