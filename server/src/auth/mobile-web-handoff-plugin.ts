import { setSessionCookie } from "better-auth/cookies";
import { createAuthEndpoint } from "better-auth/api";
import * as z from "zod";
import type { Db } from "@paperclipai/db";
import { mobileWebHandoffService } from "../services/mobile-web-handoffs.js";

const consumeMobileWebHandoffQuerySchema = z.object({
  token: z.string().min(1),
});

export function mobileWebHandoffAuthPlugin(db: Db) {
  const handoffs = mobileWebHandoffService(db);

  return {
    id: "mobile-web-handoff",
    endpoints: {
      consumeMobileWebHandoff: createAuthEndpoint("/mobile-web-handoff/consume", {
        method: "GET",
        query: consumeMobileWebHandoffQuerySchema,
        requireHeaders: true,
      }, async (ctx) => {
        const failureUrl = new URL("/onboarding", ctx.context.baseURL);
        const redirectToFailure = (reason: string): never => {
          const url = new URL(failureUrl);
          url.searchParams.set("handoff", reason);
          throw ctx.redirect(url.toString());
        };

        const result = await handoffs.consume(ctx.query.token);
        const handoff = (() => {
          switch (result.status) {
          case "ok":
            return result.handoff;
          case "invalid":
            return redirectToFailure("invalid");
          case "expired":
            return redirectToFailure("expired");
          case "used":
            return redirectToFailure("used");
          }
        })();

        const user = (await ctx.context.internalAdapter.findUserById(handoff.userId))
          ?? redirectToFailure("missing_user");

        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) {
          redirectToFailure("session_failed");
        }

        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(new URL(handoff.targetPath, ctx.context.baseURL).toString());
      }),
    },
  };
}
