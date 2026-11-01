import { channel } from "node:diagnostics_channel";
import { mock } from "node:test";
import type { Db } from "@paperclipai/db";
import type { Socket } from "node:net";

const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval, clearRealInterval = globalThis.clearInterval, realNow = Date.now;
const fakeClock = process.env.PAPERCLIP_MAINTENANCE_FAKE_CLOCK === "true";
let bootClock: ReturnType<typeof setInterval> | undefined;
function runClock() {
  if (bootClock) clearRealInterval(bootClock);
  let previous = realNow();
  bootClock = realInterval(() => { const now = realNow(); mock.timers.tick(Math.max(0, now - previous)); previous = now; }, 10);
}
if (fakeClock) {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: realNow() });
  runClock();
}

if (process.env.PAPERCLIP_MAINTENANCE_GITHUB_ORIGIN) {
  const fetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return fetch(url.origin === "https://api.github.com"
      ? new URL(url.pathname + url.search, process.env.PAPERCLIP_MAINTENANCE_GITHUB_ORIGIN) : input, init);
  };
}

let outgoingHttpRequests = 0;
const sockets: Array<{ socket: Socket; database: boolean }> = [];
channel("net.client.socket").subscribe(message => {
  const socket = (message as { socket: Socket }).socket;
  socket.once("connect", () => sockets.push({ socket, database: socket.remotePort === Number(new URL(process.env.DATABASE_URL!).port) }));
});
function network() {
  return { nonDatabaseConnections: sockets.filter(entry => !entry.database).length,
    databaseConnections: sockets.filter(entry => entry.database).length,
    nonDatabaseBytesWritten: sockets.filter(entry => !entry.database).reduce((sum, entry) => sum + entry.socket.bytesWritten, 0) };
}
const observeRequest = () => { outgoingHttpRequests++; };
channel("undici:request:create").subscribe(observeRequest);
channel("http.client.request.start").subscribe(observeRequest);

try {
  const { startServer } = await import("../../../index.js");
  const { idleWorkSnapshot, startTaskDrain, stopTaskDrain } = await import("../../../services/task-admission.js");
  const { getStartupRecoveryState } = await import("../../../startup-recovery-state.js");
  const server = await startServer();
  const app = server.server.listeners("request")[0] as unknown as { locals: { paperclipDb: Db } };
  process.send?.({ kind: "ready", port: server.listenPort });
  process.on("message", async (message: { id: number; command: string; ms?: number; issueUpdate?: { id: string; status: "done" }; orphanLease?: { companyId: string }; publication?: { companyId: string; scopeDigest: string; backupRoot: string; pendingRoot: string } }) => {
    try {
      if (message.command === "snapshot" || message.command === "advance" || message.command === "drain" || message.command === "resume" || message.command === "freeze" || message.command === "realtime") {
        if (message.command === "freeze" && bootClock) { clearRealInterval(bootClock); bootClock = realInterval(() => mock.timers.tick(0), 10); }
        if (message.command === "realtime" && fakeClock) runClock();
        if (message.command === "advance") {
          if (!fakeClock || typeof message.ms !== "number" || !Number.isFinite(message.ms) || message.ms < 0 || message.ms > 30_000) throw new Error("Invalid maintenance clock advance");
          mock.timers.tick(message.ms);
        }
        if (message.command === "drain") startTaskDrain({ purpose: "idle" });
        if (message.command === "resume") stopTaskDrain();
        if (fakeClock) mock.timers.tick(0);
        process.send?.({ id: message.id, kind: "snapshot", idle: idleWorkSnapshot(), startup: getStartupRecoveryState(), outgoingHttpRequests, network: network(), now: Date.now() });
      } else if (message.command === "createOrphanLease") {
        if (!message.orphanLease) throw new Error("Missing orphan lease fixture");
        const { environmentLeases } = await import("@paperclipai/db");
        const { writeEnvironmentCleanup } = await import("../../../services/environment-cleanup-notifications.js");
        const old = new Date(Date.now() - 6 * 60_000);
        const companyId = message.orphanLease.companyId;
        const [lease] = await writeEnvironmentCleanup(app.locals.paperclipDb, tx => tx.insert(environmentLeases).values({
          companyId, provider: "local", providerLeaseId: null, status: "active", leasePolicy: "ephemeral", metadata: { driver: "local" },
          acquiredAt: old, lastUsedAt: old, createdAt: old, updatedAt: old,
        }).returning(), { companyId });
        process.send?.({ id: message.id, kind: "leaseCreated", leaseId: lease!.id });
      } else if (message.command === "updateIssue") {
        if (!message.issueUpdate) throw new Error("Missing issue update");
        const { issueService } = await import("../../../services/issues.js");
        await issueService(app.locals.paperclipDb).update(message.issueUpdate.id, { status: message.issueUpdate.status });
        process.send?.({ id: message.id, kind: "updated" });
      } else if (message.command === "publishBackup") {
        if (!message.publication) throw new Error("Missing backup publication");
        const { publishNativeHarnessBackup } = await import("../../../services/native-runtime/native-harness-backup-publication.js");
        await publishNativeHarnessBackup({ db: app.locals.paperclipDb, ...message.publication });
        process.send?.({ id: message.id, kind: "published" });
      } else if (message.command === "shutdown") {
        if (fakeClock) runClock();
        await server.shutdown();
        if (bootClock) { clearRealInterval(bootClock); bootClock = undefined; }
        process.send?.({ id: message.id, kind: "stopped", outgoingHttpRequests });
        if (fakeClock) mock.timers.reset();
        await new Promise(resolve => realTimeout(resolve, 20));
        process.exit(0);
      } else throw new Error(`Unknown maintenance harness command: ${message.command}`);
    } catch (error) { process.send?.({ id: message.id, kind: "error", error: error instanceof Error ? error.stack : String(error) }); }
  });
} catch (error) {
  if (bootClock) clearRealInterval(bootClock);
  process.send?.({ kind: "error", error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
}
