import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

const reads = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export const authorizationReadScope: RequestHandler = (req, _res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const memo = new Map<string, Promise<unknown>>();
  const actor = req.actor;
  if (actor?.type === "board" && actor.source === "session" && actor.userId && typeof actor.isInstanceAdmin === "boolean") {
    memo.set(`admin:${actor.userId}`, Promise.resolve(actor.isInstanceAdmin));
  }
  reads.run(memo, next);
};

export function readOncePerRequest<T>(key: string, read: () => Promise<T>): Promise<T> {
  const memo = reads.getStore();
  if (!memo) return read();
  let result = memo.get(key);
  if (!result) {
    result = read();
    memo.set(key, result);
  }
  return result as Promise<T>;
}
