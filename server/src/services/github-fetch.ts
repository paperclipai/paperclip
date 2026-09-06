import { HttpError, unprocessable } from "../errors.js";

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

// Generous next to the 1 MiB per-file ceiling skill imports already enforce
// (MAX_CATALOG_FILE_BYTES), and above a large recursive repo-tree listing,
// while still bounding what one response can allocate.
const DEFAULT_GITHUB_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function maxResponseBytes() {
  const parsed = Number.parseInt(process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GITHUB_MAX_RESPONSE_BYTES;
}

function tooLarge(url: string, limit: number) {
  return unprocessable(`Response from ${new URL(url).hostname} exceeds the ${limit} byte limit for GitHub requests`);
}

/**
 * Read a GitHub response body with a size ceiling.
 *
 * The host is user-supplied, so an unbounded read lets one response allocate
 * without limit. `response.arrayBuffer()` cannot help — it has already buffered
 * everything by the time its result could be measured — so this streams and
 * stops as soon as the running total crosses the limit.
 */
export async function readGitHubResponseBytes(response: Response, url: string): Promise<Buffer> {
  const limit = maxResponseBytes();

  // Trust `content-length` only to reject early; a hostile host can understate
  // or omit it, so the streaming total below remains the real enforcement.
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw tooLarge(url, limit);
  }

  // ghFetch returns as soon as the headers arrive, but its request timeout stays
  // armed for the body. A host that sends headers and then stalls mid-stream
  // aborts the read here, outside ghFetch's own try, so translate that into the
  // same error the wrapper raises instead of leaking a raw AbortError.
  try {
    if (!response.body) return Buffer.from(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw tooLarge(url, limit);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw unprocessable(`Could not read the response from ${new URL(url).hostname} — the connection ended before the body was complete`);
  }
}

export async function readGitHubResponseText(response: Response, url: string): Promise<string> {
  return (await readGitHubResponseBytes(response, url)).toString("utf8");
}

export async function readGitHubResponseJson<T>(response: Response, url: string): Promise<T> {
  return JSON.parse(await readGitHubResponseText(response, url)) as T;
}
