import { type RequestHandler, Router } from "express";
import type { Db } from "@paperclipai/db";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import {
  deriveJadeSsoPassword,
  ensureJadeCompany,
  ensureJadeInstanceAdmin,
  findAuthUserIdByEmail,
  parseJadeGrant,
} from "../jade-sso.js";
import { logger } from "../middleware/logger.js";

type AuthApi = {
  signUpEmail?: (input: unknown) => Promise<Response>;
  signInEmail?: (input: unknown) => Promise<Response>;
};

/**
 * GET /sso/jade — consume the jade-injected SSO grant and land the
 * tenant owner signed in as instance admin. Idempotent: returning
 * visits just re-establish the session for the same email.
 */
export function jadeSsoRoutes(
  db: Db,
  opts: {
    auth?: { api?: AuthApi } | undefined;
    resolveSession?: (
      req: Parameters<RequestHandler>[0],
    ) => Promise<BetterAuthSessionResult | null>;
  },
): Router {
  const router = Router();

  router.get("/sso/jade", async (req, res) => {
    // Post-sign-in destination. Default "/" (dashboard). A caller (e.g.
    // jade's embedded terminal iframe) can pass ?next=/terminal so the
    // auto-SSO lands them where they actually want. Open-redirect-safe:
    // must be a single-slash-rooted local path, no scheme/host.
    const rawNext = Array.isArray(req.query.next)
      ? req.query.next[0]
      : req.query.next;
    const nextPath =
      typeof rawNext === "string" &&
      /^\/(?![/\\])[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(rawNext)
        ? rawNext
        : "/";

    const grant = parseJadeGrant();
    if (!grant) {
      res.redirect(302, "/auth");
      return;
    }

    // Already signed in on this browser — nothing to do.
    try {
      const existing = await opts.resolveSession?.(req);
      if (existing?.user) {
        res.redirect(302, nextPath);
        return;
      }
    } catch {
      /* fall through and (re)establish the session */
    }

    const api = opts.auth?.api;
    if (!api?.signUpEmail || !api?.signInEmail) {
      logger.error("jade-sso: better-auth api unavailable");
      res.status(503).send("Auth not ready");
      return;
    }

    const password = deriveJadeSsoPassword(grant.email);
    const existingUserId = await findAuthUserIdByEmail(db, grant.email);

    let authResponse: Response;
    try {
      authResponse = existingUserId
        ? await api.signInEmail({
            body: { email: grant.email, password },
            asResponse: true,
          })
        : await api.signUpEmail({
            body: { email: grant.email, name: grant.name, password },
            asResponse: true,
          });
    } catch (err) {
      logger.error({ err }, "jade-sso: better-auth call threw");
      res.status(500).send("Sign-in failed");
      return;
    }

    if (!authResponse.ok) {
      logger.error(
        { status: authResponse.status },
        "jade-sso: better-auth rejected sign-in",
      );
      res.status(502).send("Sign-in failed");
      return;
    }

    const userId =
      existingUserId ?? (await findAuthUserIdByEmail(db, grant.email));
    if (userId) {
      try {
        await ensureJadeInstanceAdmin(db, userId);
      } catch (err) {
        logger.error({ err }, "jade-sso: instance-admin grant failed");
        // Session is still valid; surface as a soft failure rather than
        // blocking sign-in entirely.
      }
      try {
        await ensureJadeCompany(db, userId, grant.company);
      } catch (err) {
        logger.error({ err }, "jade-sso: company bootstrap failed");
        // Non-fatal: they'll just see the normal "Name your company" step.
      }
    }

    for (const cookie of authResponse.headers.getSetCookie()) {
      res.append("set-cookie", cookie);
    }
    res.redirect(302, nextPath);
  });

  return router;
}
