import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Jade gate enforcement.
 *
 * Every request that hits this instance MUST either:
 *   1. Come through the jade.computer workspace-gate Worker, which forwards
 *      an `X-Jade-Gate-Secret` header carrying the per-workspace secret
 *      injected as `JADE_GATE_SECRET` in the machine env, OR
 *   2. Originate from loopback on the same machine (a workspace agent
 *      calling http://localhost:3100/api/...). On Fly, the edge proxy
 *      reaches us over the 6PN network (fdaa::/something), never loopback —
 *      so a loopback peer plus no forwarding headers is a clean
 *      "same-machine" signal that the agent can use without learning the
 *      gate secret, OR
 *   3. Carry an `Authorization: Bearer <token>` header against an
 *      authenticatable `/api/*` path. Downstream auth validates the
 *      token; the gate just trusts that anyone holding a valid token
 *      already has reason to be talking to this instance. `/api/auth/*`
 *      stays gate-secret-only so the "anyone can hit signup directly on
 *      .fly.dev" hole stays closed.
 *
 * If `JADE_GATE_SECRET` is unset (local dev, self-hosted, BYOC), the
 * middleware is a no-op so existing flows keep working.
 *
 * `/api/health` is exempted so Fly + monitoring can probe without the
 * header.
 */

const HEADER = "x-jade-gate-secret";
const EXEMPT_PREFIXES = ["/api/health"];
const BEARER_BYPASS_PREFIXES = ["/api/"];
const BEARER_BYPASS_DENY_PREFIXES = ["/api/auth/"];
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
  "fly-client-ip",
];

function constantTimeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hasBearerToken(req: Parameters<RequestHandler>[0]): boolean {
  const raw = req.header("authorization")?.trim();
  if (!raw) return false;
  if (!/^bearer\s+\S+/i.test(raw)) return false;
  const path = req.path;
  if (BEARER_BYPASS_DENY_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p))) {
    return false;
  }
  return BEARER_BYPASS_PREFIXES.some((p) => path.startsWith(p));
}

function isLoopbackPeer(req: Parameters<RequestHandler>[0]): boolean {
  // req.socket.remoteAddress is the raw TCP peer; it cannot be spoofed via
  // HTTP headers. req.ip would honor X-Forwarded-For under trust-proxy, so
  // we deliberately do not use it here.
  const peer = req.socket?.remoteAddress;
  if (!peer || !LOOPBACK_PEERS.has(peer)) return false;
  // Belt-and-suspenders: if any forwarding header is present, the request
  // actually came from somewhere else and is being relayed by a local proxy.
  // Refuse to treat it as same-machine.
  for (const name of FORWARDING_HEADERS) {
    if (req.headers[name] !== undefined) return false;
  }
  return true;
}

export function jadeGateGuard(): RequestHandler {
  const expected = process.env.JADE_GATE_SECRET?.trim();
  return (req, res, next) => {
    if (!expected) return next();
    for (const prefix of EXEMPT_PREFIXES) {
      if (req.path === prefix || req.path.startsWith(`${prefix}/`)) {
        return next();
      }
    }
    if (isLoopbackPeer(req)) return next();
    if (hasBearerToken(req)) return next();
    const supplied = req.header(HEADER)?.trim();
    if (!supplied || !constantTimeEqualString(supplied, expected)) {
      res.status(403).type("text/plain").send("gate_required");
      return;
    }
    return next();
  };
}
