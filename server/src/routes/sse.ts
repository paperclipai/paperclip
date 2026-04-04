import { Router } from "express";
import type { Response } from "express";
import type { Db } from "@ironworksai/db";
import { assertCompanyAccess } from "./authz.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { LiveEvent } from "@ironworksai/shared";

// Map of companyId -> set of active SSE response objects
const clients = new Map<string, Set<Response>>();

function addClient(companyId: string, res: Response): void {
  let set = clients.get(companyId);
  if (!set) {
    set = new Set();
    clients.set(companyId, set);
  }
  set.add(res);
}

function removeClient(companyId: string, res: Response): void {
  const set = clients.get(companyId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    clients.delete(companyId);
  }
}

// SSE route builder. db parameter reserved for future per-company auth checks.
export function sseRoutes(_db: Db) {
  const router = Router();

  router.get("/companies/:companyId/events", (req, res) => {
    const companyId = req.params.companyId as string;

    // Assert company access using the same auth logic as all other routes
    assertCompanyAccess(req, companyId);

    // Disable the compression middleware's res.json override for this SSE response
    // by setting headers before any middleware can buffer output.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx proxy buffering if present
    });
    // Flush headers immediately so the client sees the 200
    res.flushHeaders?.();

    // Heartbeat every 30 s keeps proxies and load balancers from killing the connection
    const heartbeatTimer = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 30_000);

    // Subscribe to in-process live events for this company
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event: LiveEvent) => {
      // Map the LiveEvent type to an SSE event name and emit data
      const sseEventName = sseEventName_(event.type);
      const payload = `event: ${sseEventName}\ndata: ${JSON.stringify(event)}\n\n`;
      res.write(payload);
    });

    addClient(companyId, res);

    req.on("close", () => {
      clearInterval(heartbeatTimer);
      unsubscribe();
      removeClient(companyId, res);
    });
  });

  return router;
}

/**
 * Map a LiveEventType to an SSE event name.
 * The UI listens for "activity" and "agent_run" events by name.
 */
function sseEventName_(type: string): string {
  if (type === "activity.logged") return "activity";
  if (
    type === "heartbeat.run.queued" ||
    type === "heartbeat.run.status"
  ) {
    return "agent_run";
  }
  // Pass other event types through as-is (dots replaced with underscores for spec compliance)
  return type.replace(/\./g, "_");
}
