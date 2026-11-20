import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { isUuidLike } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";

interface RequestActorScope {
  actor: AuthorizationActor;
  keyId: string | null;
}

const scopes = new AsyncLocalStorage<RequestActorScope>();

export const currentRequestActor = () => scopes.getStore()?.actor;

export function currentRequestApiKeyId(): string | null {
  const keyId = scopes.getStore()?.keyId?.trim();
  return keyId && isUuidLike(keyId) ? keyId : null;
}

export function withRequestActor<T>(actor: AuthorizationActor, operation: () => T): T {
  return scopes.run({ actor, keyId: actor?.keyId ?? null }, operation);
}

export const requestActorContext: RequestHandler = (req, res, next) => {
  const scope: RequestActorScope = { actor: req.actor, keyId: req.actor?.keyId ?? null };
  const end = res.end;
  res.end = function releaseKeyOnEnd(this: typeof res, ...args: Parameters<typeof res.end>) {
    scope.keyId = null;
    return end.apply(this, args);
  } as typeof res.end;
  scopes.run(scope, next);
};
