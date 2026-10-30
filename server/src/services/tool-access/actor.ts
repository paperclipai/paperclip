import type { ActorInfo } from "./types.js";

export function actorBinding(actor: ActorInfo | undefined) {
  return {
    actorType: actor?.actorType ?? null,
    actorId: actor?.actorId ?? null,
    sessionId:
      typeof actor?.sessionId === "string" && actor.sessionId.trim().length > 0
        ? actor.sessionId
        : null,
  };
}

export function connectionActorUserId(actor?: ActorInfo): string | null {
  return actor?.actorType === "user" ? actor.actorId ?? null : actor?.managementContext?.responsibleUserId ?? null;
}
