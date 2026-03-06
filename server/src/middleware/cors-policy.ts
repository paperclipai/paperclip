import type { Request, RequestHandler } from "express";
import type { DeploymentMode } from "@paperclipai/shared";
import { resolveClientIp } from "./rate-limit.js";

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostname(host);
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function parseOrigin(originHeader: string | undefined): URL | null {
  if (!originHeader) return null;
  try {
    const url = new URL(originHeader);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`.toLowerCase();
}

function parseOriginAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const entry of values) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      out.add(normalizeOrigin(parsed));
    } catch {
      continue;
    }
  }
  return out;
}

function requestHost(req: Request): string | null {
  const raw = req.header("host");
  if (!raw) return null;
  const [host] = raw.trim().toLowerCase().split(":");
  return host || null;
}

export interface CorsPolicyOptions {
  deploymentMode: DeploymentMode;
  bindHost: string;
  allowedHostnames: string[];
}

export function createCorsPolicyMiddleware(opts: CorsPolicyOptions): RequestHandler {
  const explicitOrigins = parseOriginAllowlist(process.env.PAPERCLIP_CORS_ALLOWED_ORIGINS);
  const normalizedAllowedHostnames = new Set(opts.allowedHostnames.map((entry) => normalizeHostname(entry)));
  const bindHost = normalizeHostname(opts.bindHost);

  return (req, res, next) => {
    const originUrl = parseOrigin(req.header("origin"));
    const isPreflight =
      req.method === "OPTIONS" &&
      Boolean(req.header("origin")) &&
      Boolean(req.header("access-control-request-method"));

    if (!originUrl) {
      if (isPreflight) {
        res.status(400).json({ error: "Malformed preflight request" });
        return;
      }
      next();
      return;
    }

    const originHost = normalizeHostname(originUrl.hostname);
    const normalizedOrigin = normalizeOrigin(originUrl);
    const hostHeader = requestHost(req);
    const sameHost = Boolean(hostHeader) && hostHeader === originUrl.host.toLowerCase();
    const allowedByExplicit = explicitOrigins.has(normalizedOrigin);
    const allowedByLoopback = opts.deploymentMode === "local_trusted" && isLoopbackHost(originHost);
    const allowedByPrivateHostPolicy =
      opts.deploymentMode === "authenticated" &&
      (normalizedAllowedHostnames.has(originHost) || normalizeHostname(bindHost) === originHost);

    const allowed = sameHost || allowedByExplicit || allowedByLoopback || allowedByPrivateHostPolicy;

    if (!allowed) {
      const details = {
        origin: normalizedOrigin,
        host: hostHeader,
        clientIp: resolveClientIp(req),
      };
      if (isPreflight) {
        res.status(403).json({ error: "CORS origin denied", details });
        return;
      }
      res.status(403).json({ error: "CORS origin denied", details });
      return;
    }

    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.header("access-control-request-headers") ??
        "Authorization,Content-Type,X-Paperclip-Run-Id,X-Internal-Secret,X-Tenant-Id",
    );

    if (isPreflight) {
      res.status(204).end();
      return;
    }

    next();
  };
}
