import { logger } from "../middleware/logger.js";

interface LifecycleOpts {
  url: string;
  instanceId: string;
  secret: string;
}

async function notify(opts: LifecycleOpts, event: string) {
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paperclip-instance-id": opts.instanceId, "x-paperclip-management-secret": opts.secret },
      body: JSON.stringify({ instanceId: opts.instanceId, event, timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) logger.warn({ event, status: res.status }, "Lifecycle hook returned non-OK status");
  } catch (err) {
    logger.warn({ err, event }, "Lifecycle hook notification failed");
  }
}

export const notifyReady = (opts: LifecycleOpts) => notify(opts, "ready");
export const notifyShutdown = (opts: LifecycleOpts) => notify(opts, "shutdown");
