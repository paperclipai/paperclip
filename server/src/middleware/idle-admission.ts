import { markIdleIngressTracked } from "../services/idle-local-work.js";
import type { Application, Request, RequestHandler } from "express";
import { beginIdleTrackedWork, isIdleTaskDrainActive } from "../services/task-admission.js";

type RequestWork = { pending: number; ended: boolean; closed: boolean; asyncRoute: boolean; routeSequence: number; active: boolean; finish: () => void };
const requests = new WeakMap<Request, RequestWork>();
function settle(work: RequestWork) {
  if (work.active && (work.ended || (work.closed && work.asyncRoute)) && work.pending === 0) {
    work.active = false;
    work.finish();
  }
}

// Only the exact control endpoint and health probes bypass admission. The
// control route still authenticates each operation. GET is otherwise tracked:
// OAuth callbacks and tool streams can create work too.
// Reachability does not exempt health/bootstrap or control mutations from
// tracking. Only the task-drain read skips request tracking to avoid counting
// its own scan; actorMiddleware counts its preceding authentication separately.
function isControlRequest(req: Request) {
  const path = req.path.replace(/\/$/, "");
  return (path === "/api/instance/task-drain" && ["GET", "POST", "DELETE"].includes(req.method)) ||
    (path === "/api/health" && ["GET", "HEAD"].includes(req.method));
}

/** Install before body parsers, auth, webhooks and tool ingress. */
export const idleAdmissionMiddleware: RequestHandler = (req, res, next) => {
  const controlRequest = isControlRequest(req);
  if (!controlRequest && isIdleTaskDrainActive()) {
    res.set("Retry-After", "1").status(503).json({ error: "instance_preparing_to_sleep" });
    return;
  }
  if (controlRequest && req.method === "GET" && req.path.replace(/\/$/, "") === "/api/instance/task-drain") {
    next();
    return;
  }
  const work: RequestWork = { pending: 0, ended: false, closed: false, asyncRoute: false, routeSequence: 0, active: true, finish: beginIdleTrackedWork() };
  requests.set(req, work);
  res.once("close", () => { work.closed = true; settle(work); });
  // close/aborted are NOT completion: an async handler can still be committing
  // a mutation after its client leaves. Wait for the application's end and all
  // returned handler promises. Callback-only handlers abandoned without end
  // stay blockers; an async route proves completion when its promise settles.
  const end = res.end;
  res.end = function (this: typeof res, ...args: Parameters<typeof end>) {
    try { return end.apply(this, args); }
    finally { work.ended = true; settle(work); }
  } as typeof end;
  next();
};

// Express 5 exposes its router stack. Walk it once after route registration,
// preserving router objects and error-handler arity. Waiting only for finish
// loses async work after res.json(), including the disconnected-client case.
// Keep this adapter isolated and exercise it against real Express in tests.
type Layer = { handle: Function & { stack?: Layer[] }; route?: { stack: Layer[] } };
export function trackIdleRequestHandlers(app: Application): void {
  const seen = new Set<Layer>();
  const visit = (stack: Layer[], route = false) => {
    for (const layer of stack) {
      if (seen.has(layer)) continue;
      seen.add(layer);
      if (layer.route && Array.isArray(layer.route.stack)) { visit(layer.route.stack, true); continue; }
      if (Array.isArray(layer.handle.stack)) { visit(layer.handle.stack); continue; }
      const original = layer.handle;
      if (original === idleAdmissionMiddleware) continue;
      const invoke = (req: Request, args: unknown[]) => {
        const work = requests.get(req);
        if (!work) return original(...args);
        if (!work.active) { work.active = true; work.finish = beginIdleTrackedWork(); }
        work.pending++;
        const routeSequence = route ? ++work.routeSequence : undefined;
        if (route) work.asyncRoute = false;
        let calledNext = false;
        const originalNext = args[args.length - 1] as (...args: unknown[]) => unknown;
        args[args.length - 1] = (...nextArgs: unknown[]) => { calledNext = true; return originalNext(...nextArgs); };
        const finish = () => { work.pending--; settle(work); };
        try {
          const result = original(...args);
          if (result && typeof result.then === "function") {
            return Promise.resolve(result).finally(() => {
              // An async validation middleware which calls next() does not
              // prove completion of a later callback-only route handler.
              if (route && !calledNext && work.routeSequence === routeSequence) work.asyncRoute = true;
              finish();
            });
          }
          finish();
          return result;
        } catch (error) { finish(); throw error; }
      };
      layer.handle = original.length === 4
        ? function (error: unknown, req: Request, res: unknown, next: unknown) { return invoke(req, [error, req, res, next]); }
        : function (req: Request, res: unknown, next: unknown) { return invoke(req, [req, res, next]); };
    }
  };
  visit(app.router.stack as Layer[]);
  markIdleIngressTracked();
}
