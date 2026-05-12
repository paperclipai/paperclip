import { Router } from "express";
import type { Router as ExpressRouter } from "express";
import { serverVersion } from "../version.js";

export type MetaRouteEntry = { method: string; path: string };

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function enumerateRouter(
  router: unknown,
  prefix: string,
  out: MetaRouteEntry[],
): void {
  const stack = (router as { stack?: unknown }).stack;
  if (!Array.isArray(stack)) return;
  for (const rawLayer of stack) {
    const layer = rawLayer as {
      route?: { path?: string | string[]; methods?: Record<string, boolean> };
      handle?: unknown;
    };
    if (layer.route) {
      const methods = Object.keys(layer.route.methods ?? {})
        .map((m) => m.toUpperCase())
        .filter((m) => HTTP_METHODS.has(m));
      const paths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path ?? ""];
      for (const routePath of paths) {
        for (const method of methods) {
          out.push({ method, path: prefix + routePath });
        }
      }
      continue;
    }
    if (
      layer.handle &&
      typeof layer.handle === "function" &&
      Array.isArray((layer.handle as { stack?: unknown }).stack)
    ) {
      enumerateRouter(layer.handle, prefix, out);
    }
  }
}

type MetaCatalogOptions = {
  gitSha?: string | null;
};

export type MetaCatalog = {
  install: (router: ExpressRouter, prefix?: string) => void;
  router: () => ExpressRouter;
  snapshot: () => MetaRouteEntry[];
};

export function createMetaCatalog(opts: MetaCatalogOptions = {}): MetaCatalog {
  const entries: MetaRouteEntry[] = [];

  function install(router: ExpressRouter, prefix = ""): void {
    const origUse = router.use.bind(router);
    (router as unknown as { use: (...args: unknown[]) => ExpressRouter }).use = (
      ...args: unknown[]
    ): ExpressRouter => {
      let nestPrefix = "";
      let handlers: unknown[] = args;
      const first = args[0];
      if (typeof first === "string") {
        nestPrefix = first;
        handlers = args.slice(1);
      } else if (
        Array.isArray(first) &&
        first.every((x) => typeof x === "string") &&
        first.length > 0
      ) {
        nestPrefix = first[0] as string;
        handlers = args.slice(1);
      }
      for (const handler of handlers) {
        if (
          handler &&
          typeof handler === "function" &&
          Array.isArray((handler as { stack?: unknown }).stack)
        ) {
          enumerateRouter(handler, prefix + nestPrefix, entries);
        }
      }
      return origUse(...(args as Parameters<typeof origUse>));
    };
  }

  function snapshot(): MetaRouteEntry[] {
    const seen = new Set<string>();
    const out: MetaRouteEntry[] = [];
    for (const entry of entries) {
      const key = `${entry.method} ${entry.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    out.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
    return out;
  }

  function router(): ExpressRouter {
    const r = Router();
    r.get("/_meta", (_req, res) => {
      const gitSha =
        opts.gitSha ?? process.env.PAPERCLIP_GIT_SHA?.trim() ?? null;
      res.json({
        serverVersion,
        gitSha: gitSha && gitSha.length > 0 ? gitSha : null,
        routes: snapshot(),
      });
    });
    return r;
  }

  return { install, router, snapshot };
}
