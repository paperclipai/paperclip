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
// Cloud-only support configuration. Identity is derived from the authenticated user.
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
