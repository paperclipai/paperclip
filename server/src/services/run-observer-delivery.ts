import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

export type ObserverDeliveryConfig = { socketPath: string; companyId: string; agentId: string };
export type ObserverDeadlineScheduler = {
  scheduleActiveDeadline(key: string, at: number, callback: () => void): void;
  cancelActiveDeadline(key: string): void;
};
type ObserverRegistration = { scheduler: ObserverDeadlineScheduler; closeAll: Set<() => void>; stopped: boolean };
const schedulers = new WeakMap<object, ObserverRegistration>();
export function registerRunObserverScheduler(owner: object, scheduler: ObserverDeadlineScheduler) {
  const registration: ObserverRegistration = { scheduler, closeAll: new Set(), stopped: false };
  if (schedulers.has(owner)) throw new Error("Run observer scheduler is already registered");
  schedulers.set(owner, registration);
  return () => {
    registration.stopped = true;
    for (const close of registration.closeAll) close();
    if (schedulers.get(owner) === registration) schedulers.delete(owner);
  };
}


/** Configuration belongs to the trusted Paperclip server, never adapter input. */
export function observerDeliveryConfig(env: NodeJS.ProcessEnv): ObserverDeliveryConfig | null {
  const socketPath = env.PAPERCLIP_OBSERVER_SINK_SOCKET?.trim();
  const companyId = env.PAPERCLIP_OBSERVER_SINK_COMPANY_ID?.trim();
  const agentId = env.PAPERCLIP_OBSERVER_SINK_AGENT_ID?.trim();
  if (!socketPath && !companyId && !agentId) return null;
  if (!socketPath || !companyId || !agentId || !path.isAbsolute(socketPath))
    throw new Error("Observer sink configuration is incomplete");
  return { socketPath, companyId, agentId };
}

async function sendToOwnedSocket(socketPath: string, payload: string, signal: AbortSignal): Promise<void> {
  if (typeof process.getuid !== "function") throw new Error("Observer sink requires Unix ownership checks");
  if (signal.aborted) throw new Error("Observer delivery stopped");
  const directory = path.dirname(socketPath);
  const [dir, socket, canonicalDir] = await Promise.all([lstat(directory), lstat(socketPath), realpath(directory)]);
  if (!dir.isDirectory() || dir.isSymbolicLink() || canonicalDir !== directory || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0 ||
      !socket.isSocket() || socket.uid !== process.getuid() || (socket.mode & 0o077) !== 0)
    throw new Error("Observer sink must be a private socket in an owned private directory");
  if (signal.aborted) throw new Error("Observer delivery stopped");
  await new Promise<void>((resolve, reject) => {
    const client = createConnection(socketPath);
    let received = "", finished = false;
    const abort = () => done(new Error("Observer delivery stopped"));
    const done = (error?: Error) => { if (finished) return; finished = true; signal.removeEventListener("abort", abort); client.destroy(); error ? reject(error) : resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) return abort();
    client.setTimeout(3000, () => done(new Error("Observer sink acknowledgement timed out")));
    client.once("error", () => done(new Error("Observer sink unavailable")));
    client.once("connect", () => client.write(`${payload}\n`));
    client.on("data", data => {
      received += data.toString("utf8");
      if (received.length > 16) return done(new Error("Invalid observer sink acknowledgement"));
      if (received.includes("\n")) done(received === "ok\n" ? undefined : new Error("Observer sink rejected delivery"));
    });
    client.once("end", () => { if (!finished) done(new Error("Observer sink closed before acknowledgement")); });
  });
}

/** Delivers and renews one run token without exporting the signing key. */
export async function startRunObserverDelivery(db: Db, run: { id: string; companyId: string; agentId: string },
  config: ObserverDeliveryConfig | null, options: { refreshMs?: number; scheduler?: ObserverDeadlineScheduler } = {}) {
  if (!config || config.companyId !== run.companyId || config.agentId !== run.agentId) return null;
  const registration = schedulers.get(db);
  const scheduler = options.scheduler ?? registration?.scheduler;
  if (!scheduler) throw new Error("Run observer scheduler is unavailable");
  const deadlineKey = `run-observer:${run.id}:${randomUUID()}`;
  let closed = false;
  const controller = new AbortController();
  class RunInactive extends Error {}
  let inFlight: Promise<void> | null = null;
  const close = () => {
    closed = true;
    scheduler.cancelActiveDeadline(deadlineKey);
    controller.abort();
    registration?.closeAll.delete(close);
  };
  if (registration?.stopped) throw new Error("Run observer scheduler is stopped");
  registration?.closeAll.add(close);
  const deliver = async () => {
    const [current] = await db.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId)));
    if (closed || !current || current.status !== "running" || agentRunWritesRevoked(current)) throw new RunInactive("Run observer is not active");
    const token = createLocalAgentJwt(run.agentId, run.companyId, "run_observer", run.id, null, { kind: "run_status_observer" });
    if (!token) throw new Error("Run observer signing is unavailable");
    await sendToOwnedSocket(config.socketPath, JSON.stringify({ runId: run.id, token }), controller.signal);
  };
  try { await deliver(); } catch (error) { close(); throw error; }
  const configuredTtl = Number(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS);
  const refreshMs = options.refreshMs ?? (Number.isFinite(configuredTtl) && configuredTtl > 0
    ? Math.min(40_000, Math.max(250, Math.floor(configuredTtl * 1000 / 3))) : 40_000);
  const schedule = () => scheduler.scheduleActiveDeadline(deadlineKey, Date.now() + refreshMs, () => {
    if (closed || inFlight) return;
    inFlight = deliver().catch(error => {
      if (error instanceof RunInactive) close();
      // On transient errors the broker must stop when its token expires.
    }).finally(() => {
      inFlight = null;
      if (!closed) {
        try { schedule(); } catch { close(); }
      }
    });
  });
  try { if (closed) throw new Error("Run observer delivery stopped"); schedule(); } catch (error) { close(); throw error; }
  return { close };
}
