// PRIVATE UNRUN. Normal SDK hooks backed by actual owned Linux operations.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { OwnedDockerResources } from "./owned-docker-resource.mjs";
import { startOwnedWssGateway } from "./owned-wss-gateway.mjs";
import { transferOwnedMappings } from "./owned-bulk-sync.js";

export function createOwnedLinuxProvider(config) {
  const resources = new OwnedDockerResources(config), gateways = new Map(), ingressPending = new Set(), active = new Set(), retiring = new Set(), stopPromises = new Map();
  let closing = false;
  const track = (params, work, allowRetiring = false) => {
    if (!allowRetiring && retiring.has(params.lease?.providerLeaseId ?? params.providerLeaseId)) return Promise.reject(new Error("owned_resource_retiring"));
    if (closing) return Promise.reject(new Error("owned_provider_closing"));
    const pending = Promise.resolve().then(work); active.add(pending);
    return pending.finally(() => active.delete(pending));
  };
  const find = async (params, id = params.lease?.providerLeaseId ?? params.providerLeaseId, allowRetiring = false) => {
    const resource = await resources.resolve(params, id);
    if (params.driverKey !== "dot-linux-qualification" || params.config.qualificationId !== "dot-owned-linux") throw new Error("owned_provider_scope_denied");
    return resource;
  };
  const execute = async params => {
    const resource = await find(params);
    if (resource.status !== "active") throw new Error("owned_execution_resource_inactive");
    const response = await resources.cli(["exec", "-i", resource.containerId, "/usr/bin/node", "/qualification/linux-command-relay.mjs", "/descriptor/resource.json"],
      JSON.stringify({ ...resource, providerLeaseId: resource.id, requestId: randomUUID(), command: params.command, args: params.args ?? [],
        cwd: params.cwd ?? resource.root, env: params.env ?? {}, stdin: params.stdin, timeoutMs: params.timeoutMs ?? 90000 }),
      Math.min(params.timeoutMs ?? 90000, 90000) + 1000);
    let value;
    try { value = JSON.parse(response.stdout); }
    catch { resources.unknown.push({ resourceId: resource.id, kind: "command_reply_invalid" }); throw new Error("owned_command_reply_invalid"); }
    if (response.code !== 0 || value.error || value.unknownOutcome || !value.joined || value.overflow || value.spawnError) {
      resources.unknown.push({ resourceId: resource.id, kind: "command_outcome_unknown" }); throw new Error("owned_command_outcome_unknown");
    }
    // Fault injection is owned by the fixture AFTER a real durable checkpoint;
    // never terminate from the early marker-read/handshake frontier.
    return { exitCode: value.exitCode, signal: value.signal, timedOut: value.timedOut, stdout: value.stdout, stderr: value.stderr,
      metadata: { ownedLinuxCommandPid: value.pid, ownedLinuxCommandGroup: value.group, processIdentity: value.kernel,
        nativeIdentity: value.proof?.kernel ?? null, providerLeaseId: resource.id } };
  };
  const sync = async (params, direction) => {
    const resource = await find(params);
    return transferOwnedMappings({ remoteRoot: resource.root, hostLeaseRoot: path.join(resource.hostRoot, "workspace"),
      readableHostRoots: config.readableHostRoots, readableHostFiles: new Set(config.readableHostFiles), writableHostRoot: config.writableHostRoot,
      assertCurrentLease: async () => { const value = await find(params); if (value.status !== "active") throw new Error("owned_sync_resource_inactive"); },
      execute: command => execute({ ...params, command: "sh", args: ["-c", command.command], cwd: command.cwd, timeoutMs: command.timeoutMs }),
    }, params.operations, direction);
  };
  const stop = async params => {
    if (stopPromises.has(params.providerLeaseId)) return stopPromises.get(params.providerLeaseId);
    retiring.add(params.providerLeaseId);
    const stopping = (async () => {
    await Promise.allSettled([...active]);
    const resource = await find(params, params.providerLeaseId, true);
    const gateway = gateways.get(resource.id);
    // Stop the exact verified namespace first. Its real exit closes the relay
    // and WSS sockets; joining them before termination would deadlock.
    const termination = await resources.stop(resource);
    if (gateway) { await gateway.close(); gateways.delete(resource.id); }
    // namespace stop is explicitly labeled; it does not replace the paired
    // fixture's independent individual PID/group/start/used-socket join proof.
    return termination;
    })();
    const observed = stopping.catch(error => { stopPromises.delete(params.providerLeaseId); throw error; });
    stopPromises.set(params.providerLeaseId, observed); return observed;
  };
  const provider = {
    initialize: () => resources.initialize(),
    async acquire(params) {
      const resource = await resources.acquire(params);
      return { providerLeaseId: resource.id, metadata: { remoteCwd: resource.root, shellCommand: "sh", reuseLease: false,
        qualificationNamespace: config.namespace, companyId: resource.companyId, environmentId: resource.environmentId,
        runId: resource.runId, creationOperationId: resource.creationOperationId } };
    },
    async resume(params) {
      if (closing) throw new Error("owned_provider_closing");
      // No acquire, replacement or run-authority transfer. Same-run Native
      // recovery gets the exact retained files/container through normal SDK.
      const oldStop = stopPromises.get(params.providerLeaseId); if (oldStop) await oldStop;
      const existing = gateways.get(params.providerLeaseId);
      if (existing) { await existing.close(); gateways.delete(params.providerLeaseId); }
      const resource = await resources.resume(params);
      retiring.delete(resource.id); stopPromises.delete(resource.id);
      return { providerLeaseId: resource.id, metadata: { remoteCwd: resource.root,
        qualificationNamespace: config.namespace, runId: resource.runId } };
    },
    async inspect(params) {
      const resource = await find(params, params.providerLeaseId), actual = await resources.inspect(resource);
      return { providerLeaseId: resource.id, state: actual.State.Running ? "active" : actual.State.Pid === 0 ? "stopped" : "unknown" };
    },
    async realize(params) {
      const resource = await find(params);
      if (resource.status !== "active") throw new Error("owned_workspace_resource_inactive");
      // Actual bind-mounted owned workspace exists; no synthesized repository,
      // outcome, credentials or task authority is installed here.
      return { cwd: resource.root, metadata: { providerLeaseId: resource.id, ownedLinuxWorkspace: true } };
    },
    execute,
    syncIn: params => sync(params, "in"),
    syncOut: params => sync(params, "out"),
    async ingress(params) {
      const resource = await find(params);
      if (params.port !== 43127 || !/^\/api\/runner\/v1\/connect\/[^/?#]+$/.test(params.path)) throw new Error("owned_ingress_target_denied");
      if (gateways.has(resource.id)) {
        const existing = gateways.get(resource.id);
        if (existing.requestedPath !== params.path) throw new Error("owned_ingress_generation_mismatch");
        return existing.endpoint;
      }
      const generation = randomUUID(), secret = randomBytes(32).toString("hex");
      const gateway = await startOwnedWssGateway({ docker: config.docker, endpoint: config.endpoint, resource,
        ownedHome: config.home, ownedDockerConfig: config.dockerConfig, runnerPort: params.port, path: params.path,
        key: await readFile(config.tlsKey), cert: await readFile(config.tlsCert), servername: "127.0.0.1", secret, generation,
        relayPath: "/qualification/linux-runner-ingress.mjs", descriptorPath: "/descriptor/resource.json", pending: ingressPending,
        verifyOwnedContainer: () => resources.inspect(resource),
        readCurrentLease: async () => {
          const actual = await resources.inspect(resource);
          return { status: actual.State.Running && !retiring.has(resource.id) ? resource.status : "stopped", generation, providerLeaseId: resource.id,
            companyId: resource.companyId, environmentId: resource.environmentId, runId: resource.runId, containerId: resource.containerId };
        },
      });
      const endpoint = { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${gateway.port}${params.path}`,
        secretHeaders: [{ name: "x-owned-linux-ingress", value: secret }], generation };
      Object.assign(gateway, { endpoint, requestedPath: params.path }); gateways.set(resource.id, gateway); return endpoint;
    },
    stop,
    idle() { return active.size === 0 && resources.pending.size === 0 && ingressPending.size === 0 && gateways.size === 0 && resources.unknown.length === 0; },
    async close() {
      closing = true;
      const errors = [];
      try { await Promise.all([...active]); } catch (error) { errors.push(error); }
      for (const resource of resources.resources.values()) {
        try { await stop({ driverKey: "dot-linux-qualification", config: { qualificationId: "dot-owned-linux" },
          companyId: resource.companyId, environmentId: resource.environmentId, providerLeaseId: resource.id }); }
        catch (error) { errors.push(error); }
      }
      if (resources.pending.size || ingressPending.size || resources.commands.some(record => !record.joined) || resources.unknown.length) errors.push(new Error("owned_linux_shutdown_unknown"));
      if (errors.length) throw new AggregateError(errors, "owned_linux_shutdown_failed_retained");
    },
  };
  return { ...provider,
    acquire: params => track(params, () => provider.acquire(params)),
    inspect: params => track(params, () => provider.inspect(params), true),
    realize: params => track(params, () => provider.realize(params)),
    execute: params => track(params, () => provider.execute(params)),
    ingress: params => track(params, () => provider.ingress(params)),
    syncIn: params => track(params, () => provider.syncIn(params)),
    syncOut: params => track(params, () => provider.syncOut(params)),
  };
}
