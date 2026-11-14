import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import type { AuthorizationActor } from "./authorization.js";

const actors = new AsyncLocalStorage<AuthorizationActor>();

export const currentRequestActor = () => actors.getStore();

export function withRequestActor<T>(actor: AuthorizationActor, operation: () => T): T {
  return actors.run(actor, operation);
}

export const requestActorContext: RequestHandler = (req, _res, next) => withRequestActor(req.actor, next);
