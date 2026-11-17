import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// A real owned local process closes the existing command port. It neither
// emulates Docker nor supplies a kernel proof, provider result, or authority.
it.each(["eof", "malformed", "foreign", "partial"] as const)("keeps the pre-proof relay boundary closed for %s", async mode => {
  const root = await mkdtemp(path.join(tmpdir(), "owned-ingress-proof-"));
  let gateway: Awaited<ReturnType<typeof startOwnedWssGateway>> | undefined;
  let closeAttempted = false;
  try {
    const key = path.join(root, "key.pem"), cert = path.join(root, "cert.pem"), config = path.join(root, "tls.cnf"), child = path.join(root, "owned-child");
    await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Owned proof boundary\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n", { mode: 0o600 });
    await promisify(execFile)("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { timeout: 5000 });
    const output = mode === "eof" ? "" : mode === "malformed" ? "not-json\n" : mode === "partial" ? "not-json" : JSON.stringify({ ready: false }) + "\n";
    await writeFile(child, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)}, () => process.exit(17));\n`, { mode: 0o700 });
    await chmod(child, 0o700);
    const pending = new Set<Promise<void>>();
    let leaseReads = 0, containerVerifications = 0;
    const resource = { id: "owned-boundary", companyId: "company", environmentId: "environment", runId: "run", containerId: "container" };
    gateway = await startOwnedWssGateway({ key: await readFile(key), cert: await readFile(cert), path: "/owned", secret: "owned-boundary-secret", servername: "127.0.0.1", generation: "generation", resource, pending,
      docker: child, endpoint: "unix:///owned-test-not-docker", ownedHome: root, ownedDockerConfig: root,
      runnerPort: 43127, relayPath: "/not-executed", descriptorPath: "/not-executed",
      readCurrentLease: async () => { leaseReads++; return { status: "active", generation: "generation", providerLeaseId: resource.id, companyId: resource.companyId, environmentId: resource.environmentId, runId: resource.runId, containerId: resource.containerId }; },
      verifyOwnedContainer: async () => { containerVerifications++; },
    });
    const ca = await readFile(cert);
    const observed = await new Promise<{ status?: number; error?: string }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: gateway!.port, path: "/owned", ca, rejectUnauthorized: true,
        headers: { Host: `127.0.0.1:${gateway!.port}`, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", "x-owned-linux-ingress": "owned-boundary-secret" } });
      req.once("response", response => { response.resume(); response.once("end", () => resolve({ status: response.statusCode })); });
      req.once("upgrade", (_response, socket) => { socket.end(); reject(new Error("A pre-proof child must never forward an upgrade")); });
      req.once("error", error => resolve({ error: error.name })); req.end();
    });
    let closeError: unknown;
    closeAttempted = true;
    try { await gateway.close(); } catch (error) { closeError = error; }
    // Prove the real child and normal current-lease branch before the oracle.
    expect(leaseReads).toBe(1); expect(containerVerifications).toBe(1); expect(gateway.records).toHaveLength(1);
    const record = gateway.records[0];
    // Keep the immediate gateway refusal above; independently observe the real
    // child close event before inspecting its exit receipt on negative paths.
    if (mode !== "eof") await expect.poll(() => record.joined, { timeout: 1000 }).toBe(true);
    expect(record.joined).toBe(true); expect(record.pid).toBeGreaterThan(0); expect(record.group).toBe(record.pid);
    expect(record.code).toBe(17); expect(record.signal).toBeNull(); expect(pending.size).toBe(0);
    if (mode === "eof") {
      expect(observed.status).toBe(503);
      expect(observed.error).toBeUndefined(); expect(record.status).toBe("closed_before_proof");
      expect(gateway.unknown).toEqual([]); expect(closeError).toBeUndefined();
    } else {
      expect(observed.status).toBeUndefined(); expect(observed.error).toBeDefined(); expect(record.status).not.toBe("forwarding");
      expect(gateway.unknown).toEqual(["ingress_outcome_unknown"]);
      expect(closeError).toBeInstanceOf(Error); if (!(closeError instanceof Error)) throw new Error("Missing actual retained refusal");
      expect(closeError.message).toBe("owned_ingress_closure_unknown_retained");
    }
  } finally {
    try { if (gateway && !closeAttempted) await gateway.close(); } finally { await rm(root, { recursive: true, force: true }); }
  }
});
