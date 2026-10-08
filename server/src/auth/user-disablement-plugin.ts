/**
 * Better Auth plugin that refuses to create a session for a user an instance
 * admin has disabled.
 *
 * It hooks session creation rather than individual sign-in endpoints, so
 * every path that ends in a session is covered: email/password sign-in,
 * sign-up's automatic sign-in, social sign-in, and plugin endpoints such as
 * the workspace login handoff. Requests that already carry a session are
 * handled by the actor middleware, which re-checks the block per request.
 */

import { APIError } from "better-auth/api";
import type { Db } from "@paperclipai/db";
import { isUserDisabled } from "../services/instance-users.js";

export const USER_DISABLED_ERROR_CODE = "USER_DISABLED";
export const USER_DISABLED_MESSAGE =
  "This account has been disabled by an instance administrator.";

export function userDisablementPlugin(deps: { db: Db }) {
  return {
    id: "paperclip-user-disablement",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(session: { userId: string }) {
                  if (await isUserDisabled(deps.db, session.userId)) {
                    throw new APIError("FORBIDDEN", {
                      message: USER_DISABLED_MESSAGE,
                      code: USER_DISABLED_ERROR_CODE,
                    });
                  }
                },
              },
            },
          },
        },
      };
    },
  };
}
