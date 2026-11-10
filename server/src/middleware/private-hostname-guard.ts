import type { Request, RequestHandler } from "express";
import { isIP } from "node:net";

function numericAddress(value: string | undefined): string | null {
  const address = value?.trim().toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
  if (!address || isIP(address) === 0) return null;
  if (isIP(address) === 4) return address;
  try {
    const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
    const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
    if (!mapped) return canonical;
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  } catch { return null; }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  const address = numericAddress(normalized);
  return normalized === "localhost" || address === "127.0.0.1" || address === "::1";
}

function isDirectLocalApiRequest(req: Request, hostname: string): boolean {
  if (req.path !== "/api" && !req.path.startsWith("/api/")) return false;
  if (Object.keys(req.headers ?? {}).some(key => key.toLowerCase() === "forwarded" || key.toLowerCase().startsWith("x-forwarded-"))) return false;
  // Only a numeric Host is eligible; URL userinfo or a DNS name cannot borrow
  // the listener's address. Socket metadata supplies the actual local authority.
  if (!/^(?:\[[\da-f:.]+\]|[\d.]+)(?::\d+)?$/i.test(req.header("host")?.trim() ?? "")) return false;
  const host = numericAddress(hostname), local = numericAddress(req.socket?.localAddress), remote = numericAddress(req.socket?.remoteAddress);
  if (!host || !local || !remote || host !== local) return false;
  return remote === local || remote === "::1" || remote.startsWith("127.");
}

function extractHostname(req: Request): string | null {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = req.header("host")?.trim();
  const raw = forwardedHost || hostHeader;
  if (!raw) return null;

  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function normalizeAllowedHostnames(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) continue;
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function resolvePrivateHostnameAllowSet(opts: { allowedHostnames: string[]; bindHost: string }): Set<string> {
  const configuredAllow = normalizeAllowedHostnames(opts.allowedHostnames);
  const bindHost = opts.bindHost.trim().toLowerCase();
  const allowSet = new Set<string>(configuredAllow);

  if (bindHost && bindHost !== "0.0.0.0") {
    allowSet.add(bindHost);
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

// The hostname comes from the request Host header, so an unauthenticated
// requester controls it. Never put that value into the guidance command. An
// operator or an agent can paste the guidance into a shell, and that outer
// shell evaluates a backtick, `$( )`, or `$NAME` span in the host before any
// CLI receives argv. A direct-exec form such as `npx` does not stop the
// outer shell. Emit a static `<host>` placeholder and do not echo the raw request
// value. The operator supplies the real hostname.
const BLOCKED_HOSTNAME_MESSAGE =
  "This hostname is not allowed for this Paperclip instance. " +
  "If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";

export function privateHostnameGuard(opts: {
  enabled: boolean;
  allowedHostnames: string[];
  bindHost: string;
}): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const allowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });

  return (req, res, next) => {
    const hostname = extractHostname(req);
    const wantsJson = req.path.startsWith("/api") || req.accepts(["json", "html", "text"]) === "json";

    if (!hostname) {
      const error = "Missing Host header. If you want to allow a hostname, run npx paperclipai allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    if (isLoopbackHostname(hostname) || allowSet.has(hostname) || isDirectLocalApiRequest(req, hostname)) {
      next();
      return;
    }

    const error = BLOCKED_HOSTNAME_MESSAGE;
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
