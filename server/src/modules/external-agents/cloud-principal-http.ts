import express, { Router, type RequestHandler } from "express";
import { CLOUD_CONTROL_HEADER } from "../../services/cloud-runtime-identity.js";
import {
  McpOAuthError,
  type PublicMcpOAuth,
} from "../../services/public-mcp/oauth.js";
import { readDotOriginalTokenPrincipal } from "./original-token-principal.js";
import {
  dotPrincipalControlBodySchema,
  dotPrincipalControlPath,
  readDotPrincipalControlAuthority,
  sameDotPrincipalControlAuthority,
  verifyDotPrincipalControl,
} from "./cloud-principal-authority.js";

const normalized = (path: string) =>
  (path.endsWith("/") ? path.slice(0, -1) : path).toLowerCase();
export function isDotPrincipalControlPost(req: {
  method: string;
  path: string;
}) {
  return (
    req.method === "POST" && normalized(req.path) === dotPrincipalControlPath
  );
}
export function dotPrincipalControlBodyParser(): RequestHandler {
  const raw = express.raw({
    type: "application/json",
    limit: "16kb",
    inflate: false,
  });
  return (req, res, next) => {
    if (!isDotPrincipalControlPost(req)) return next();
    if (!req.is("application/json")) {
      res.status(415).json({ error: "invalid_request" });
      return;
    }
    raw(req, res, (error) => {
      if (error) {
        res
          .status(error && typeof error === "object" && "status" in error && error.status === 413 ? 413 : 400)
          .json({ error: "invalid_request" });
        return;
      }
      next();
    });
  };
}
type DotPrincipalOAuth = Pick<
  PublicMcpOAuth,
  "mode" | "config" | "authenticate"
>;
export function dotPrincipalControlRoutes(
  oauth: DotPrincipalOAuth | null | (() => DotPrincipalOAuth | null),
  options: {
    readAuthority?: typeof readDotPrincipalControlAuthority;
    now?: () => Date;
  } = {},
) {
  const router = Router(),
    readAuthority = options.readAuthority ?? readDotPrincipalControlAuthority,
    now = options.now ?? (() => new Date());
  router.use(async (req, res, next) => {
    if (normalized(req.path) !== dotPrincipalControlPath) return next();
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (req.method !== "POST") {
      res
        .set("Allow", "POST")
        .status(405)
        .json({ error: "method_not_allowed" });
      return;
    }
    const compact = req.get(CLOUD_CONTROL_HEADER)?.trim();
    if (!compact) {
      res.status(401).json({ error: "invalid_cloud_control_assertion" });
      return;
    }
    let body: ReturnType<typeof dotPrincipalControlBodySchema.parse>;
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length > 16_384)
        throw new Error();
      body = dotPrincipalControlBodySchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body)),
      );
    } catch {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let claims: ReturnType<typeof verifyDotPrincipalControl>;
    try {
      claims = verifyDotPrincipalControl(compact, body, now());
    } catch {
      res.status(401).json({ error: "invalid_cloud_control_assertion" });
      return;
    }
    const owner = typeof oauth === "function" ? oauth() : oauth;
    if (!owner) {
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    try {
      const before = readAuthority();
      if (
        !before ||
        before.stackId !== claims.sub ||
        before.instanceId !== body.expectedInstanceId ||
        body.canonicalVerifiedResource !==
          before.canonicalOrigin + "/mcp/runner"
      )
        throw new Error();
      const principal = await readDotOriginalTokenPrincipal(owner, body);
      if (
        !sameDotPrincipalControlAuthority(before, readAuthority()) ||
        claims.exp * 1000 <= now().getTime()
      )
        throw new Error();
      res.json({
        version: 1,
        requestId: claims.requestId,
        stackId: before.stackId,
        instanceId: before.instanceId,
        canonicalOrigin: before.canonicalOrigin,
        principal,
      });
    } catch (error) {
      if (error instanceof McpOAuthError) {
        res.status(error.status).json({ error: error.code });
        return;
      }
      res.status(503).json({ error: "temporarily_unavailable" });
    }
  });
  return router;
}
