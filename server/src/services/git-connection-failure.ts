import type { GitConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";

const classifiedErrors = new WeakMap<Error, GitConnectionFailure>();

/** Only the outbound Git call may create this reporting classification. */
export class GitConnectionFailureError extends Error {
  constructor(message: string, failure: GitConnectionFailure) {
    super(message);
    this.name = "GitConnectionFailureError";
    classifiedErrors.set(this, { ...failure });
  }
}

export function readGitConnectionFailure(error: unknown): GitConnectionFailure | null {
  const failure = error instanceof Error ? classifiedErrors.get(error) : undefined;
  return failure ? { ...failure } : null;
}

function isNetworkRemote(remote: string): boolean {
  // Local paths/file remotes and arbitrary remote helpers are not connections.
  // Keep malformed HTTP/SSH URLs eligible only for Git's explicit URL error.
  if (/^(?:https?|ssh|git):\/\//i.test(remote)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || remote.includes("::")) return false;
  return /^(?:[^\s/@:]+@)?[a-z0-9][a-z0-9.-]+:[^:\s][^\s]*$/i.test(remote) && !/^[a-z]:[\\/]/i.test(remote);
}

/**
 * Read the actual failed clone subprocess, not a wrapped error message. These
 * diagnostics belong to the remote transport; filesystem/repository damage
 * and mixed failures remain application errors even if auth text is present.
 */
export function classifyGitCloneFailure(remote: string, error: unknown): GitConnectionFailure | null {
  if (!isNetworkRemote(remote) || !(error instanceof Error)) return null;
  const failure = error as Error & { code?: unknown; stderr?: unknown; signal?: unknown; killed?: unknown };
  if (failure.code !== 128 || failure.signal != null || failure.killed === true || typeof failure.stderr !== "string") return null;
  const lines = failure.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let reason: GitConnectionFailure["reason"] | undefined;
  for (const line of lines) {
    const classified = classifyTransportLine(line);
    if (classified) {
      reason ??= classified;
      continue;
    }
    // Git and SSH append these fixed progress/help lines to recognized
    // transport errors. Unknown diagnostics, including a second local failure,
    // keep the whole operation reportable. The boilerplate alone proves nothing.
    if (/^Cloning into ['"].+['"]\.\.\.$/.test(line) ||
        /^(?:remote: )?(?:Enumerating|Counting|Compressing|Receiving|Resolving|Updating) (?:objects|deltas|files):/.test(line) ||
        /^remote: Total \d+ /.test(line) ||
        /^fatal: Could not read from remote repository\.$/.test(line) ||
        /^Please make sure you have the correct access rights$/.test(line) ||
        /^and the repository exists\.$/.test(line) ||
        /^remote: Please see https:\/\/[^\s]+ for information/.test(line)) continue;
    return null;
  }
  return reason ? { schemaVersion: 1, provider: "git", operation: "clone", reason } : null;
}

function classifyTransportLine(line: string): GitConnectionFailure["reason"] | undefined {
  // Parse the transport's own diagnostic prefix before examining its detail.
  // A local error may quote exactly the same words in a path or object name.
  const http = /^fatal: unable to access ['"][^'"\r\n]+['"]: (.+)$/i.exec(line)?.[1];
  if (http) {
    const status = /^The requested URL returned error: (\d{3})$/i.exec(http)?.[1];
    if (status === "401" || status === "403") return "authentication_failed";
    if (status === "404") return "repository_unavailable";
    if (status === "429") return "rate_limited";
    if (status && /^5\d\d$/.test(status)) return "remote_unavailable";
    if (/^(?:URL (?:using bad\/illegal format|rejected)|Port number was not a decimal number)/i.test(http)) return "invalid_remote";
    if (/^Could not resolve host: [^\s]+$/i.test(http)) return "dns_failure";
    if (/^Failed to connect to .+: Connection refused$/i.test(http)) return "connection_refused";
    if (/^Failed to connect to .+: (?:Network is unreachable|No route to host)$/i.test(http)) return "network_unreachable";
    if (/^Recv failure: Connection was reset$/i.test(http)) return "connection_reset";
    if (/^Failed to connect to .+: Connection timed out$|^Operation timed out(?: after \d+ milliseconds with \d+ bytes received)?$/i.test(http)) return "connection_timeout";
    if (/^(?:SSL certificate problem|server certificate verification failed|SSL peer certificate|gnutls_handshake\(\) failed)/i.test(http)) return "tls_failure";
    return undefined;
  }
  if (/^fatal: Authentication failed for ['"][^'"\r\n]+['"]$/i.test(line) ||
      /^fatal: could not read (?:Username|Password) for ['"][^'"\r\n]+['"]: terminal prompts disabled$/i.test(line) ||
      /^remote: (?:Invalid username or (?:password|token)|Permission [^\r\n]+ denied|Support for password authentication was removed|Password authentication is not supported)/i.test(line) ||
      /^(?:[^\s:@]+@)?[a-z0-9][a-z0-9.-]*: Permission denied \((?:publickey|password|keyboard-interactive)(?:,[a-z-]+)*\)\.?$/i.test(line)) return "authentication_failed";
  if (/^remote: Repository not found\.?$|^fatal: repository ['"][^'"\r\n]+['"] not found$/i.test(line)) return "repository_unavailable";
  if (/^ssh: Could not resolve hostname [^\s]+: (?:Name or service not known|nodename nor servname provided, or not known|Temporary failure in name resolution|No such host is known\.?)$/i.test(line)) return "dns_failure";
  const ssh = /^ssh: connect to host [^\s]+ port \d+: (.+)$/i.exec(line)?.[1];
  if (ssh === "Connection refused") return "connection_refused";
  if (ssh === "Network is unreachable" || ssh === "No route to host") return "network_unreachable";
  if (ssh === "Connection timed out") return "connection_timeout";
  if (/^Connection reset by (?:peer|[^\s]+ port \d+)$/i.test(line)) return "connection_reset";
  return undefined;
}
