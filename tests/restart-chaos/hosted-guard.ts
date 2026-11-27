export const REFUSED_HOSTS: ReadonlySet<string> = new Set(["paperclip.staging.paperclip.app"]);
export const TEST_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:staging|test)\.paperclip\.app$/;
const RESERVED_LABELS = new Set(["admin", "admin-staging", "my", "my-staging", "api", "cloud", "www", "app"]);

export interface HostedTarget {
  baseUrl: string;
  host: string;
}

export class HostedTargetError extends Error {
  constructor(message: string) { super(message); this.name = "HostedTargetError"; }
}

export function hostedTarget(baseUrl: string | undefined, allow: string | undefined): HostedTarget {
  if (!baseUrl) throw new HostedTargetError("Hosted mode needs --hosted-base-url <https://host>");
  if (!allow) throw new HostedTargetError("Hosted mode needs --hosted-allow <host>, the same host as --hosted-base-url");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new HostedTargetError(`--hosted-base-url is not a URL: ${baseUrl}`); }
  if (url.protocol !== "https:") throw new HostedTargetError("--hosted-base-url must use https");
  if (url.username || url.password || url.port || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new HostedTargetError("--hosted-base-url must be a bare origin (https://host), with no path, port, query or credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed = allow.trim().toLowerCase();
  if (host !== allowed) throw new HostedTargetError(`--hosted-allow ${allowed} does not match the --hosted-base-url host ${host}`);
  if (REFUSED_HOSTS.has(host)) throw new HostedTargetError(`${host} is refused: the harness never writes to the shared staging instance`);
  if (!TEST_HOST_PATTERN.test(host) || RESERVED_LABELS.has(host.split(".")[0]!)) {
    throw new HostedTargetError(`${host} is refused: hosted mode only targets a single-stack <name>.staging.paperclip.app or <name>.test.paperclip.app host`);
  }
  return { baseUrl: `https://${host}`, host };
}

export function assertSameOrigin(target: HostedTarget, url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== target.host || parsed.port) {
    throw new HostedTargetError(`Refusing a request to ${parsed.origin}: hosted mode only talks to ${target.baseUrl}`);
  }
}
