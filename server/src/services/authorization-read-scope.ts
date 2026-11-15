import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

const reads = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export const authorizationReadScope: RequestHandler = (req, _res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  reads.run(new Map(), next);
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
