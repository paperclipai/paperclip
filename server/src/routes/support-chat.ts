import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { supportChatSessionSchema } from "@paperclipai/shared";
import { notFound, unauthorized } from "../errors.js";
import {
  computePlainEmailHash,
  resolveSupportChatConfig,
} from "../services/support-chat.js";
import type { CloudInstanceEnv } from "../services/cloud-instance.js";

/**
 * The support chat session route: the browser asks whether this instance
 * serves the Plain chat surface and, if so, receives the widget configuration
 * plus a narrow attested customer identity.
 *
 * Fail-closed properties:
 * - 404 (`support_chat_disabled`) unless the server-owned config enables the
 *   surface — self-hosted instances answer 404 and load no vendor code.
 * - Board authentication required; agent/run actors get 401.
 * - Identity derives from the authenticated user row only. The route reads no
 *   query/body input, so a caller cannot request a hash for another email.
 * - `emailHash` is only issued for a verified email, and the response is
 *   marked `Cache-Control: no-store` because the hash is a bearer credential
 *   for the customer's chat identity.
 */
export function supportChatRoutes(
  db: Db,
  opts: {
    runtimeEnv?: CloudInstanceEnv;
    nodeEnv?: string | undefined;
  } = {},
) {
  const router = Router();

  router.get("/session", async (req, res) => {
    const config = resolveSupportChatConfig(
      opts.runtimeEnv ?? process.env,
      "nodeEnv" in opts ? opts.nodeEnv : process.env.NODE_ENV,
    );
    if (!config) {
      throw notFound("Support chat is not enabled on this instance", {
        code: "support_chat_disabled",
      });
    }

    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }

    const user = await db
      .select({
        id: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        emailVerified: authUsers.emailVerified,
      })
      .from(authUsers)
      .where(eq(authUsers.id, req.actor.userId))
      .then((rows) => rows[0] ?? null);

    if (!user) {
      throw unauthorized("Signed-in user not found");
    }

    // Attest identity only when every link in the chain holds: a signing
    // secret is configured, the user row carries an email, and that email is
    // verified. Otherwise the widget runs without `customerDetails` and
    // Plain's own email verification covers identity.
    const email = user.email?.trim() || null;
    const customer =
      config.emailHmacSecret && email && user.emailVerified
        ? {
            email,
            emailHash: computePlainEmailHash(config.emailHmacSecret, email),
            fullName: user.name?.trim() || null,
            externalId: user.id,
          }
        : null;

    res.setHeader("Cache-Control", "no-store");
    res.json(
      supportChatSessionSchema.parse({
        provider: "plain",
        appId: config.appId,
        devPreview: config.devPreview,
        customer,
      }),
    );
  });

  return router;
}
