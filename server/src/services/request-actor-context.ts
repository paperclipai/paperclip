import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { isUuidLike } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";

const actors = new AsyncLocalStorage<AuthorizationActor>();

export const currentRequestActor = () => actors.getStore();

export function currentRequestApiKeyId(): string | null {
  const keyId = actors.getStore()?.keyId?.trim();
  return keyId && isUuidLike(keyId) ? keyId : null;
}

export function withRequestActor<T>(actor: AuthorizationActor, operation: () => T): T {
  return actors.run(actor, operation);
}

export const requestActorContext: RequestHandler = (req, _res, next) => withRequestActor(req.actor, next);
