import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler, Response } from "express";

export const AUTHORIZATION_READ_MAX_AGE_MS = 2_000;

type ReadScope = { open: boolean; entries: Map<string, { value: Promise<unknown>; readAt: number }> };

const reads = new AsyncLocalStorage<ReadScope>();

function closeWhenResponseStarts(res: Response, close: () => void) {
  const { write, flushHeaders, writeHead } = res;
  res.write = function (this: Response, ...args: Parameters<Response["write"]>) {
    close();
    return write.apply(this, args);
  } as Response["write"];
  res.flushHeaders = function (this: Response) {
    close();
    return flushHeaders.call(this);
  };
  res.writeHead = function (this: Response, ...args: Parameters<Response["writeHead"]>) {
    close();
    return writeHead.apply(this, args);
  } as Response["writeHead"];
  res.once("finish", close);
  res.once("close", close);
}

export const authorizationReadScope: RequestHandler = (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    next();
    return;
  }
  const scope: ReadScope = { open: true, entries: new Map() };
  const actor = req.actor;
  if (actor?.type === "board" && actor.source === "session" && actor.userId && typeof actor.isInstanceAdmin === "boolean") {
    scope.entries.set(`admin:${actor.userId}`, { value: Promise.resolve(actor.isInstanceAdmin), readAt: Date.now() });
  }
  closeWhenResponseStarts(res, () => {
    scope.open = false;
    scope.entries.clear();
  });
  reads.run(scope, next);
};

export function readOncePerRequest<T>(key: string, read: () => Promise<T>): Promise<T> {
  const scope = reads.getStore();
  if (!scope?.open) return read();
  const now = Date.now();
  const cached = scope.entries.get(key);
  if (cached && now - cached.readAt <= AUTHORIZATION_READ_MAX_AGE_MS) return cached.value as Promise<T>;
  const entry = { value: read() as Promise<unknown>, readAt: now };
  scope.entries.set(key, entry);
  entry.value.catch(() => {
    if (scope.entries.get(key) === entry) scope.entries.delete(key);
  });
  return entry.value as Promise<T>;
}
