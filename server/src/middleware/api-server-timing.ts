import type { RequestHandler, Response } from "express";

// Adds `paperclip_api;dur=<ms>` to every API response: the server time from
// request arrival until headers are written, including admission waits. Browser
// resource timing exposes it, so page-load investigations can tell server time
// from network and queueing time without traces. Route-specific phases (for
// example `paperclip_issue`) are preserved; this entry is appended after them.
// The header carries only a duration, never request or tenant data.
export const API_SERVER_TIMING_METRIC = "paperclip_api";

export function apiServerTiming(): RequestHandler {
  return (_req, res, next) => {
    const start = performance.now();
    const writeHead = res.writeHead as (...args: unknown[]) => Response;
    res.writeHead = function writeHeadWithServerTiming(this: Response, ...args: unknown[]) {
      if (!this.headersSent) appendServerTiming(this, `${API_SERVER_TIMING_METRIC};dur=${(performance.now() - start).toFixed(1)}`);
      return writeHead.apply(this, args);
    } as Response["writeHead"];
    next();
  };
}

function appendServerTiming(res: Response, entry: string) {
  const existing = res.getHeader("Server-Timing");
  const values = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader("Server-Timing", [...values, entry].join(", "));
}
