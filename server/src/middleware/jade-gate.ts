import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Jade gate enforcement.
 *
 * Every request that hits this paperclip instance MUST come through the
 * jade.computer workspace-gate Worker, which forwards an
 * `X-Jade-Gate-Secret` header carrying the per-workspace secret
 * injected as `JADE_GATE_SECRET` in the machine env.
 *
 * If `JADE_GATE_SECRET` is unset (local dev, self-hosted, BYOC), the
 * middleware is a no-op so existing flows keep working.
 *
 * `/api/health` is exempted so Fly + monitoring can probe without the
 * header. No other path is — including `/api/auth/*`, which closes the
 * "anyone can hit signup directly on `.fly.dev`" hole that motivated
 * this whole feature.
 */

const HEADER = "x-jade-gate-secret";
const EXEMPT_PREFIXES = ["/api/health"];

function constantTimeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
    const supplied = req.header(HEADER)?.trim();
    if (!supplied || !constantTimeEqualString(supplied, expected)) {
      res.status(403).type("text/plain").send("gate_required");
      return;
    }
    return next();
  };
}
