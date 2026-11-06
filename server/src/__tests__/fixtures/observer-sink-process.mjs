import { chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const [socketPath, apiUrl] = process.argv.slice(2);
if (process.env.PAPERCLIP_AGENT_JWT_SECRET || process.env.BETTER_AUTH_SECRET) throw new Error("Sink inherited a signing secret");
let token = null, runId = null, worker = null, checking = false, stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  if (worker?.pid) { try { process.kill(-worker.pid, "SIGTERM"); } catch {} }
};
const server = createServer(socket => {
  let data = "";
  socket.on("data", chunk => {
    data += chunk;
    if (!data.includes("\n")) return;
    const message = JSON.parse(data);
    if (runId && runId !== message.runId) { socket.end("no\n"); return; }
    runId = message.runId; token = message.token;
    if (!worker) {
      worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      worker.once("exit", () => process.stdout.write("WORKER_STOPPED\n"));
      process.stdout.write("WORKER_STARTED\n");
    }
    socket.end("ok\n");
  });
});
server.listen(socketPath, async () => { await chmod(socketPath, 0o600); process.stdout.write("READY\n"); });
const timer = setInterval(async () => {
  if (!token || stopped || checking) return;
  checking = true;
  try {
    const res = await fetch(`${apiUrl}/api/heartbeat-runs/${runId}/observer-status`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(750),
    });
    if (!res.ok) stop();
  } catch { stop(); }
  finally { checking = false; }
}, 150);
process.on("SIGTERM", () => { clearInterval(timer); stop(); server.close(); });
