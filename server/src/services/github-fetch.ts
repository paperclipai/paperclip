import { unprocessable } from "../errors.js";

export function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

function requestTimeoutMs() {
  const parsed = Number.parseInt(process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  // `fetch` has no default timeout. The host here comes from a user-supplied
  // repository URL, so a GitHub Enterprise instance that accepts the connection
  // and then never responds would block this call — and the request handler
  // waiting on it — indefinitely. Bound every request, and keep honouring a
  // caller-supplied signal so existing cancellation still works.
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
