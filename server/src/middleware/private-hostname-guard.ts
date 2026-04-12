import type { Request, RequestHandler } from "express";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function extractHostname(req: Request): string | null {
  // Only trust X-Forwarded-Host when Express trust proxy is enabled,
  // which sets req.hostname from the forwarded header. When trust proxy
  // is off, use the Host header directly to prevent spoofing.
  const raw = req.app.get("trust proxy")
    ? (req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host")?.trim())
    : req.header("host")?.trim();
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

function blockedHostnameMessage(hostname: string): string {
  return (
    `Hostname '${hostname}' is not allowed for this Paperclip instance. ` +
    `If you want to allow this hostname, please run pnpm paperclipai allowed-hostname ${hostname}`
  );
}

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
      const error = "Missing Host header. If you want to allow a hostname, run pnpm paperclipai allowed-hostname <host>.";
      if (wantsJson) {
        res.status(403).json({ error });
      } else {
        res.status(403).type("text/plain").send(error);
      }
      return;
    }

    if (isLoopbackHostname(hostname) || allowSet.has(hostname)) {
      next();
      return;
    }

    const error = blockedHostnameMessage(hostname);
    if (wantsJson) {
      res.status(403).json({ error });
    } else {
      res.status(403).type("text/plain").send(error);
    }
  };
}
