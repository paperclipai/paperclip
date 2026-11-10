// PRIVATE UNRUN fixture infrastructure. TLS stays verified. No public provider.
import https from "node:https";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";

const sameSecret = (actual, expected) => typeof actual === "string" && Buffer.byteLength(actual) === Buffer.byteLength(expected)
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export async function startOwnedWssGateway(options) {
  const sockets = new Set(), children = new Set(), unknown = [], records = [];
  let closing = false;
  const server = https.createServer({ key: options.key, cert: options.cert }, (_req, res) => { res.writeHead(404); res.end(); });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    // Keep this promise in the explicit owner set; never swallow a rejected
    // authority/kernel/transport observation as an accepted upgrade.
    const work = (async () => {
      if (closing || request.method !== "GET" || request.url !== options.path || request.headers.host !== `${options.servername}:${server.address()?.port}`
          || !sameSecret(request.headers["x-owned-linux-ingress"], options.secret)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
      }
      // Supplied by actual current lease/namespace owner, not a cached allow.
      const current = await options.readCurrentLease();
      if (current.status !== "active" || current.generation !== options.generation
          || current.providerLeaseId !== options.resource.id || current.companyId !== options.resource.companyId
          || current.runId !== options.resource.runId || current.containerId !== options.resource.containerId || current.environmentId !== options.resource.environmentId) throw new Error("current_ingress_lease_denied");
      await options.verifyOwnedContainer(); // exact ID + image + labels, no reuse
      const child = spawn(options.docker, ["--host", options.endpoint, "exec", "-i", options.resource.containerId,
        "/usr/bin/node", options.relayPath, options.descriptorPath], {
        env: { HOME: options.ownedHome, DOCKER_CONFIG: options.ownedDockerConfig, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"], detached: true,
      });
      const record = { pid: child.pid ?? null, group: child.pid ?? null, joined: false, status: "pending" }; records.push(record);
      children.add(child);
      const joined = new Promise(resolve => child.once("close", (code, signal) => { record.joined = true; record.code = code; record.signal = signal; children.delete(child); resolve(); }));
      child.once("error", () => { record.status = "spawn_failed"; });
      // Never log stderr: normal ingress/command payloads may include secrets.
      let errorBytes = 0; child.stderr.on("data", bytes => { errorBytes += bytes.length; });
      child.stdin.on("error", () => { record.stdinError = true; });
      child.stdin.write(JSON.stringify({ ...options.resource, providerLeaseId: options.resource.id, port: options.runnerPort }) + "\n");
      let prefix = Buffer.alloc(0);
      const proof = await new Promise((resolve, reject) => {
        const onData = bytes => {
          prefix = Buffer.concat([prefix, bytes]); const end = prefix.indexOf(10);
          if (end < 0 && prefix.length > 16384) { child.stdout.off("data", onData); reject(new Error("ingress_proof_overflow")); return; }
          if (end < 0) return;
          child.stdout.pause(); child.stdout.off("data", onData);
          try { const value = JSON.parse(prefix.subarray(0, end).toString("utf8")); prefix = prefix.subarray(end + 1); resolve(value); }
          catch { reject(new Error("ingress_proof_invalid")); }
        };
        child.stdout.on("data", onData); child.once("close", () => reject(new Error("ingress_closed_before_proof")));
      });
      // The actual normal launcher has already used its canonical parser
      // before initiating PRP. Linux ingress independently requires real marker,
      // boot/ticks/exe+listener custody; no replacement parser/ready authority.
      if (proof.ready !== true || proof.providerLeaseId !== options.resource.id
          || proof.containerId !== options.resource.containerId || proof.companyId !== options.resource.companyId || proof.environmentId !== options.resource.environmentId || closing) throw new Error("ingress_proof_foreign");
      record.status = "forwarding";
      const lines = [`GET ${options.path} HTTP/1.1`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        const name = request.rawHeaders[i], value = request.rawHeaders[i + 1];
        if (name.toLowerCase() !== "x-owned-linux-ingress") lines.push(name + ": " + value);
      }
      child.stdin.write(lines.join("\r\n") + "\r\n\r\n"); if (head.length) child.stdin.write(head);
      if (prefix.length) socket.write(prefix);
      socket.pipe(child.stdin); child.stdout.pipe(socket); child.stdout.resume();
      socket.once("end", () => child.stdin.end());
      await joined; record.stderrBytes = errorBytes;
      if (!socket.closed) socket.end();
    })();
    options.pending.add(work);
    void work.catch(() => { unknown.push("ingress_outcome_unknown"); if (!socket.closed) socket.end(); })
      .finally(() => options.pending.delete(work));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned_wss_listener_unknown");
  return {
    port: address.port, records, unknown,
    async close() {
      closing = true;
      // Snapshot ALL tracked close-event witnesses, never filter socket.closed.
      const socketJoins = [...sockets].map(socket => once(socket, "close"));
      const serverJoin = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all([serverJoin, ...socketJoins, ...options.pending]);
      if (sockets.size || children.size || unknown.length || records.some(record => !record.joined)) throw new Error("owned_ingress_closure_unknown_retained");
    },
  };
}
