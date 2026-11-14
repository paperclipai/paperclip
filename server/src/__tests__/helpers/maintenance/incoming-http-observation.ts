import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { IncomingHttpSnapshot } from "../../../../../scripts/sleep-qualification/evidence.mjs";

/** Passive test-child observation of the actual app listener, including direct clients. */
export function observeMaintenanceIncomingHttp(server: Server) {
  // A sole upgrade listener suppresses Node's default unsupported-upgrade close.
  // The real app installs its WebSocket handlers before startServer returns.
  if (server.listenerCount("request") === 0 || server.listenerCount("upgrade") === 0) {
    throw new Error("Maintenance HTTP observation requires existing app request and upgrade handlers");
  }
  const captureId = randomUUID();
  let requests = 0, installed = true, valid = true;
  const count = () => {
    if (requests === Number.MAX_SAFE_INTEGER) valid = false;
    else requests++;
  };
  const detached = (event: string | symbol, listener: unknown) => {
    if ((event === "request" || event === "upgrade") && listener === count) valid = false;
  };
  // Count before application handlers without inspecting or retaining request data.
  server.prependListener("request", count);
  server.prependListener("upgrade", count);
  server.on("removeListener", detached);
  return {
    snapshot(): IncomingHttpSnapshot {
      return { source: "node-http-server-events", captureId, installed,
        valid: valid && installed && server.listening
          && server.listeners("request").includes(count) && server.listeners("upgrade").includes(count),
        requests, observedAt: new Date().toISOString() };
    },
    dispose() {
      if (!installed) return;
      installed = false; valid = false;
      server.off("removeListener", detached);
      server.off("request", count);
      server.off("upgrade", count);
    },
  };
}
