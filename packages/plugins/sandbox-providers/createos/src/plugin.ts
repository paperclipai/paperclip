import { randomUUID, createHash } from "node:crypto";
import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginContext, PluginEnvironmentAcquireLeaseParams, PluginEnvironmentDriverBaseParams,
  PluginEnvironmentExecuteParams, PluginEnvironmentLease, PluginEnvironmentReleaseLeaseParams,
} from "@paperclipai/plugin-sdk";
import { CreateosApiError, CreateosClient, object } from "./client.js";
import { parseConfig, resolveApiKey } from "./config.js";
import { CreateosCleanupError, execute, shellQuote } from "./execute.js";
import { syncFiles } from "./file-sync.js";

const CWD = "/paperclip-workspace";
// The host excludes .paperclip-runtime from workspace export, so the lease
// marker never becomes a user repository file.
const MARKER = `${CWD}/.paperclip-runtime/.paperclip-createos-lease`;

function metadataMatches(params: PluginEnvironmentDriverBaseParams, metadata?: Record<string, unknown>): boolean {
  return metadata?.provider === "createos" && metadata.companyId === params.companyId &&
    metadata.environmentId === params.environmentId && metadata.apiUrl === parseConfig(params.config).apiUrl;
}

async function acquire(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
  // An idle timeout or a host-local timer cannot supply a provider expiry.
  if (params.requestedExpiresAt) throw new Error("CreateOS does not yet support leases with a guaranteed expiration deadline.");
  const config = parseConfig(params.config);
  const client = new CreateosClient(config);
  const signal = AbortSignal.timeout(config.timeoutMs);
  const sandbox = await client.createSandbox(signal);
  try {
    await client.transition(sandbox.id, "running", signal);
    const data = await client.json(`/sandboxes/${sandbox.id}/exec`, "POST", {
      cmd: "/bin/bash", args: ["-lc", `mkdir -p -- ${shellQuote(CWD)}`],
    }, signal);
    if (object(data.result).exit_code !== 0) throw new Error("CreateOS workspace preparation failed; the image must provide Bash.");
    const marker = randomUUID();
    await client.upload(sandbox.id, MARKER, marker, signal);
    return {
      providerLeaseId: sandbox.id,
      metadata: {
        provider: "createos", apiUrl: config.apiUrl,
        companyId: params.companyId, environmentId: params.environmentId,
        remoteCwd: CWD, shellCommand: "bash", marker,
        shape: config.shape, rootfs: config.rootfs, region: config.region,
        reuseLease: config.reuseLease,
      },
    };
  } catch (error) {
    try { await client.destroySandbox(sandbox.id); }
    catch { throw new Error(`CreateOS setup failed and cleanup is unconfirmed for sandbox ${sandbox.id}.`); }
    throw error;
  }
}

// Each worker owns its own transient lifecycle state. The host owns durable leases.
export function createPlugin() {
  let ctx: PluginContext | null = null;
  let shuttingDown = false;
  type Active = { controller: AbortController; done: Promise<void> };
  const active = new Map<string, Set<Active>>();
  const closing = new Set<string>();
  const unconfirmedCleanup = new Set<string>();

  function key(params: PluginEnvironmentDriverBaseParams, id: string): string {
    const config = parseConfig(params.config);
    const account = createHash("sha256").update(resolveApiKey(config)).digest("hex");
    return JSON.stringify([params.companyId, params.environmentId, config.apiUrl, account, id]);
  }

  async function stopActive(scope: string) {
    const calls = [...(active.get(scope) ?? [])];
    for (const call of calls) call.controller.abort();
    await Promise.all(calls.map((call) => call.done));
  }

  async function track<T>(
    params: PluginEnvironmentDriverBaseParams & { lease: PluginEnvironmentLease },
    work: (client: CreateosClient, signal: AbortSignal) => Promise<T>,
    timeoutOverride?: number,
  ): Promise<T> {
    if (!params.lease.providerLeaseId || !metadataMatches(params, params.lease.metadata)) throw new Error("CreateOS execution requires a lease from this environment.");
    const scope = key(params, params.lease.providerLeaseId);
    if (shuttingDown || closing.has(scope) || unconfirmedCleanup.has(scope)) throw new Error("CreateOS lease is closing or requires cleanup.");
    const config = parseConfig(params.config);
    const timeoutMs = timeoutOverride ?? config.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("Invalid CreateOS command timeout.");
    const controller = new AbortController();
    let finish!: () => void;
    const entry: Active = { controller, done: new Promise<void>((resolve) => { finish = resolve; }) };
    const calls = active.get(scope) ?? new Set<Active>();
    calls.add(entry);
    active.set(scope, calls);
    try {
      return await work(new CreateosClient(config), AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]));
    } catch (error) {
      if (error instanceof CreateosCleanupError) unconfirmedCleanup.add(scope);
      throw error;
    } finally {
      calls.delete(entry);
      if (calls.size === 0) active.delete(scope);
      finish();
    }
  }

  async function release(params: PluginEnvironmentReleaseLeaseParams, destroy: boolean) {
    const id = params.providerLeaseId;
    if (!id) return;
    if (!metadataMatches(params, params.leaseMetadata)) throw new Error("CreateOS lease does not belong to this environment.");
    const scope = key(params, id);
    if (closing.has(scope)) throw new Error("CreateOS lease cleanup is already in progress.");
    closing.add(scope);
    try {
      await stopActive(scope);
      const config = parseConfig(params.config);
      const client = new CreateosClient(config);
      if (destroy || !config.reuseLease) {
        await client.destroySandbox(id);
        unconfirmedCleanup.delete(scope);
      } else {
        if (unconfirmedCleanup.has(scope)) throw new Error("CreateOS process cleanup is unconfirmed; destroy this lease before reusing it.");
        try { await client.transition(id, "paused", AbortSignal.timeout(config.timeoutMs)); }
        catch (error) { if (!(error instanceof CreateosApiError && error.status === 404)) throw error; }
      }
    } finally {
      closing.delete(scope);
    }
  }

  return definePlugin({
    async setup(context) { ctx = context; ctx.logger.info("CreateOS sandbox provider ready"); },
    async onHealth() { return { status: "ok", message: "CreateOS provider loaded; probe an environment to check connectivity." }; },
    async onEnvironmentValidateConfig(params) {
      try { return { ok: true, normalizedConfig: { ...parseConfig(params.config) } }; }
      catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "Invalid CreateOS configuration."] }; }
    },
    async onEnvironmentProbe(params) {
      let lease: PluginEnvironmentLease | null = null;
      try {
        lease = await acquire({ ...params, runId: "probe" });
        const result = await execute(new CreateosClient(parseConfig(params.config)), {
          ...params, lease, command: "/bin/echo", args: ["paperclip-createos-ready"], cwd: CWD,
        }, AbortSignal.timeout(parseConfig(params.config).timeoutMs));
        if (result.timedOut || result.exitCode !== 0 || !result.stdout.includes("paperclip-createos-ready")) throw new Error("CreateOS command probe failed.");
        return { ok: true, summary: "CreateOS sandbox creation and command execution succeeded." };
      } catch (error) {
        return { ok: false, summary: error instanceof Error ? error.message : "CreateOS probe failed." };
      } finally {
        // Never leave a reusable probe sandbox behind or hide deletion failure.
        if (lease?.providerLeaseId) await new CreateosClient(parseConfig(params.config)).destroySandbox(lease.providerLeaseId);
      }
    },
    onEnvironmentAcquireLease: acquire,
    async onEnvironmentResumeLease(params) {
      if (!metadataMatches(params, params.leaseMetadata)) throw new Error("CreateOS lease does not belong to this environment.");
      const scope = key(params, params.providerLeaseId);
      if (closing.has(scope) || unconfirmedCleanup.has(scope)) throw new Error("CreateOS lease cleanup must finish before resume.");
      const marker = params.leaseMetadata?.marker;
      if (typeof marker !== "string" || !/^[0-9a-f-]{36}$/.test(marker)) return { providerLeaseId: null, metadata: { expired: true } };
      const config = parseConfig(params.config);
      if (params.leaseMetadata?.shape !== config.shape || params.leaseMetadata.rootfs !== config.rootfs || params.leaseMetadata.region !== config.region) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      const client = new CreateosClient(config);
      const signal = AbortSignal.timeout(config.timeoutMs);
      try {
        const sandbox = await client.getSandbox(params.providerLeaseId, signal);
        if (["destroyed", "failed"].includes(sandbox.status!)) return { providerLeaseId: null, metadata: { expired: true } };
        await client.transition(params.providerLeaseId, "running", signal);
        const data = await client.json(`/sandboxes/${params.providerLeaseId}/exec`, "POST", {
          cmd: "/bin/cat", args: [MARKER],
        }, signal);
        const result = object(data.result);
        if (result.exit_code !== 0 || result.stdout !== marker) return { providerLeaseId: null, metadata: { expired: true } };
        return { providerLeaseId: params.providerLeaseId, metadata: { ...params.leaseMetadata, resumedLease: true } };
      } catch (error) {
        if (error instanceof CreateosApiError && error.status === 404) return { providerLeaseId: null, metadata: { expired: true } };
        // A transient error does not prove the original sandbox is lost.
        throw error;
      }
    },
    onEnvironmentReleaseLease: (params) => release(params, false),
    onEnvironmentDestroyLease: (params) => release(params, true),
    async onEnvironmentRealizeWorkspace(params) {
      if (!params.lease.providerLeaseId || !metadataMatches(params, params.lease.metadata)) throw new Error("CreateOS workspace requires a lease from this environment.");
      // The runtime's source mappings stage into this provider workspace.
      return { cwd: CWD, metadata: { provider: "createos", remoteCwd: CWD } };
    },
    async onEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
      return track(params, (client, signal) => execute(client, params, signal,
        (stream, text) => ctx?.execution.log(stream, text)), params.timeoutMs);
    },
    onEnvironmentSyncIn: (params) => track(params, (client, signal) => syncFiles(client, params, "in", signal)),
    onEnvironmentSyncOut: (params) => track(params, (client, signal) => syncFiles(client, params, "out", signal)),
    async onShutdown() {
      shuttingDown = true;
      await Promise.all([...active.keys()].map(stopActive));
      ctx = null;
    },
  });
}

export default createPlugin();
