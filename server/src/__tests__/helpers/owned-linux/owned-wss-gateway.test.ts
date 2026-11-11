import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { startOwnedWssGateway } from "./owned-wss-gateway.mjs";

it("refuses an authenticated reconnect to a retired lease before relay creation and joins its gateway", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owned-ingress-denial-"));
  let gateway: Awaited<ReturnType<typeof startOwnedWssGateway>> | undefined;
  let closeAttempted = false;
  try {
    const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem"), config = path.join(root, "tls.cnf");
    await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Owned ingress regression\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n", { mode: 0o600 });
    await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { timeout: 5000 });
    const pending = new Set<Promise<void>>();
    let leaseReads = 0, containerVerifications = 0;
    const resource = { id: "owned-regression", companyId: "company", environmentId: "environment", runId: "run", containerId: "container" };
    gateway = await startOwnedWssGateway({ key: await readFile(key), cert: await readFile(cert), path: "/owned", secret: "owned-regression-secret", servername: "127.0.0.1", generation: "generation", resource, pending,
      // This control deliberately stops BEFORE any Docker/relay invocation.
      docker: "owned-test-must-not-spawn", endpoint: "unix:///owned-test-must-not-connect",
      ownedHome: root, ownedDockerConfig: root, runnerPort: 43127, relayPath: "/not-invoked", descriptorPath: "/not-invoked",
      readCurrentLease: async () => { leaseReads++; return { status: "stopped", generation: "generation", providerLeaseId: resource.id, companyId: resource.companyId, environmentId: resource.environmentId, runId: resource.runId, containerId: resource.containerId }; },
      verifyOwnedContainer: async () => { containerVerifications++; throw new Error("A denied lease must never reach container verification"); },
    });
    const ca = await readFile(cert);
    const observed = await new Promise<{ status?: number; error?: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: gateway!.port, path: "/owned", ca, rejectUnauthorized: true,
        headers: { Host: `127.0.0.1:${gateway!.port}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", "x-owned-linux-ingress": "owned-regression-secret" } });
      req.once("response", response => { response.resume(); response.once("end", () => resolve({ status: response.statusCode })); });
      req.once("upgrade", (_response, socket) => { socket.end(); reject(new Error("Denied lease unexpectedly upgraded")); });
      req.once("error", error => resolve({ error: error.name })); req.end();
    });
    let closeError: unknown;
    closeAttempted = true;
    try { await gateway.close(); } catch (error) { closeError = error; }
    // These guards establish the actual current-lease branch before the RED oracle.
    expect(leaseReads).toBe(1); expect(containerVerifications).toBe(0); expect(gateway.records).toHaveLength(0);
    expect(observed.status).toBe(403);
    expect(observed.error).toBeUndefined(); expect(gateway.unknown).toEqual([]); expect(pending.size).toBe(0); expect(closeError).toBeUndefined();
  } finally {
    try { if (gateway && !closeAttempted) await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
