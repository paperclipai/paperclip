// PRIVATE UNRUN Linux-side ingress. One descriptor-authenticated JSON line,
// then raw upgrade bytes over stdin. No ports published by this module.
import net from "node:net";
import { readFile } from "node:fs/promises";
import { readActualRunnerProof, proveListener } from "./linux-process-custody.mjs";

const fail = code => Object.assign(new Error(code), { code });
let input = Buffer.alloc(0), remote = null;
try {
  if (process.platform !== "linux" || process.versions.node !== "24.22.2") throw fail("linux_node_identity_required");
  const request = await new Promise((resolve, reject) => {
    const onData = chunk => {
      input = Buffer.concat([input, chunk]); const end = input.indexOf(10);
      if (input.length > 16384 && end < 0) { process.stdin.off("data", onData); reject(fail("ingress_request_overflow")); return; }
      if (end < 0) return;
      process.stdin.pause(); process.stdin.off("data", onData);
      try { const line = input.subarray(0, end); input = input.subarray(end + 1); resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))); }
      catch { reject(fail("ingress_request_invalid")); }
    };
    process.stdin.on("data", onData); process.stdin.once("error", reject);
  });
  const resource = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (request.nonce !== resource.nonce || request.runId !== resource.runId
      || request.providerLeaseId !== resource.id || request.containerId !== resource.containerId
      || request.companyId !== resource.companyId || request.environmentId !== resource.environmentId
      || !Number.isSafeInteger(request.port) || request.port < 1 || request.port > 65535) throw fail("ingress_lease_mismatch");
  // The launch descriptor is recorded by the original actual command BEFORE
  // execution. Marker + boot/ticks + exe SHA + real listener inode must agree.
  const launch = JSON.parse(await readFile(resource.launchDescriptor, "utf8"));
  const proof = await readActualRunnerProof(resource, launch); await proveListener(proof, request.port);
  remote = net.connect({ host: "127.0.0.1", port: request.port });
  await new Promise((resolve, reject) => { remote.once("connect", resolve); remote.once("error", reject); });
  process.stdout.write(JSON.stringify({ ready: true, rawMarker: proof.rawMarker, nonce: proof.nonce, runnerId: proof.runnerId, kernel: proof.kernel, companyId: resource.companyId, environmentId: resource.environmentId,
    providerLeaseId: resource.id, containerId: resource.containerId }) + "\n");
  if (input.length) remote.write(input);
  process.stdin.pipe(remote); remote.pipe(process.stdout); process.stdin.resume();
  const closed = new Promise(resolve => remote.once("close", resolve));
  process.stdin.once("end", () => remote.end());
  remote.once("error", () => { process.exitCode = 1; });
  await closed;
} catch (error) {
  process.stderr.write(typeof error?.code === "string" && /^[a-z_]+$/.test(error.code) ? error.code : "linux_ingress_failed");
  process.exitCode = 1;
} finally { if (remote && !remote.closed) remote.end(); }
