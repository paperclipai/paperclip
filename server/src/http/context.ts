import { Elysia } from "elysia";
import { unauthorized } from "../errors.js";
import type { HttpActor } from "./actor-context.js";

export type ActorResolver = (
  request: Request,
) => HttpActor | null | Promise<HttpActor | null>;

/**
 * Adds the authenticated actor to the Elysia request context.
 *
 * Credential verification remains owned by the caller. This plugin only defines
 * the transport boundary and fails closed when the caller cannot resolve an
 * actor; it never invents a local or privileged identity.
 */
export function withActorContext(resolveActor: ActorResolver) {
  return new Elysia({ name: "paperclip-http-context" })
    .resolve(
      { as: "scoped" },
    async ({ request }) => {
      const actor = await resolveActor(request);
      if (!actor) throw unauthorized();
      return { actor };
    },
  );
}
