/**
 * NUC-116: Copilot token endpoint
 *
 * Issues short-lived HS256 JWTs for the Chainlit Copilot widget.
 * The widget passes the token as `accessToken` to `mountChainlitWidget()`,
 * which forwards it to the Chainlit server for validation.
 *
 * Required env: CHAINLIT_JWT_SECRET
 */

import { createHmac } from "node:crypto";
import { Router } from "express";

const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

function signCopilotJwt(userId: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, iat: now, exp: now + TOKEN_EXPIRY_SECONDS }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");

  return `${signingInput}.${signature}`;
}

export function copilotRoutes(): Router {
  const router = Router();

  /**
   * GET /api/copilot-token
   *
   * Returns a short-lived JWT for the Chainlit Copilot widget.
   * Requires an authenticated board session.
   */
  router.get("/copilot-token", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const secret = process.env.CHAINLIT_JWT_SECRET;
    if (!secret) {
      // No secret configured — return an empty token so widget mounts unauthenticated
      res.json({ token: null });
      return;
    }

    const token = signCopilotJwt(req.actor.userId, secret);
    res.json({ token });
  });

  return router;
}
