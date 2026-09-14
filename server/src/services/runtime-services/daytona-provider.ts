import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginEnvironmentServiceParams, PluginEnvironmentServiceResult, PluginEnvironmentProcessHandoffResult } from "@paperclipai/plugin-sdk";
import type { RuntimeServiceProcessHandoffOperation } from "./remote-process-handoff.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import type { RuntimeServiceProvider, RuntimeServiceProviderContext } from "./provider.js";
import { RuntimeServiceFault } from "./fault.js";

export type RuntimeServiceEnvironmentOperation = Pick<PluginEnvironmentServiceParams, "serviceId" | "generation" | "action" | "launch" | "processRef" | "endpointName" | "limitBytes"> & {
  companyId: string; environmentLeaseId: string;
};

export function createDaytonaRuntimeServiceProvider(options: {
  operate: (input: RuntimeServiceEnvironmentOperation) => Promise<PluginEnvironmentServiceResult>;
  handoff?: (input: RuntimeServiceProcessHandoffOperation) => Promise<PluginEnvironmentProcessHandoffResult>;
  logRoot?: string;
}): RuntimeServiceProvider {
  const root = options.logRoot ?? path.join(resolvePaperclipInstanceRoot(), "runtime-services-v2", "daytona-logs");
  function logPath(ctx: RuntimeServiceProviderContext) {
    if (![ctx.companyId, ctx.serviceId].every((id) => /^[a-f0-9-]{36}$/i.test(id))) throw new Error("Invalid service identity");
    return path.join(root, ctx.companyId, `${ctx.serviceId}.json`);
  }
  async function call(ctx: RuntimeServiceProviderContext, action: PluginEnvironmentServiceParams["action"], extra: { endpointName?: string; limitBytes?: number } = {}) {
    if (!ctx.environmentLeaseId) throw new Error("Service has no retained Daytona allocation");
    try {
      const result = await options.operate({
        companyId: ctx.companyId, environmentLeaseId: ctx.environmentLeaseId,
        serviceId: ctx.serviceId, generation: ctx.process.generation, action,
        processRef: ctx.process, ...extra,
        launch: {
          command: action === "start" ? ctx.spec.command : "", cwd: ctx.spec.cwd, endpoints: ctx.spec.endpoints,
          env: action === "start" ? ctx.env : {},
          secretKeys: action === "start" ? Object.keys(ctx.env).filter((key) => ctx.secrets.includes(ctx.env[key]!)) : [],
        },
      });
      if (result.errorCode) throw Object.assign(new Error("Service operation failed"), { code: result.errorCode });
      return result;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "IDENTITY_LOST") throw new RuntimeServiceFault("supervisor_lost");
      if (code === "RESOURCE_CONFIGURATION_MISMATCH") throw new RuntimeServiceFault("resource_configuration_mismatch");
      if (code === "EADDRINUSE") throw new RuntimeServiceFault("port_in_use");
      if (code === "ENOENT") throw new RuntimeServiceFault("launch_unavailable");
      throw error;
    }
  }
  async function saveLogs(ctx: RuntimeServiceProviderContext, text: string) {
    const file = logPath(ctx);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ savedAt: new Date().toISOString(), text: text.slice(-128 * 1024) }), { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  return {
    key: "daytona", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
    async captureExistingProcess(input) {
      if (!options.handoff || !input.authority || !input.environmentLeaseId) throw new RuntimeServiceFault("registration_unavailable");
      const result = await options.handoff({ action: "capture", ...input.authority, environmentLeaseId: input.environmentLeaseId,
        sourcePid: input.pid, cwd: input.cwd, workspaceRoot: input.workspaceRoot });
      if (result.state !== "captured" || !result.key || !result.receipt) throw new RuntimeServiceFault("process_ownership_unverified");
      return { key: result.key, receipt: result.receipt };
    },
    async stopExistingProcess(receipt, authority) {
      if (!options.handoff || !authority) throw new RuntimeServiceFault("registration_unavailable");
      const result = await options.handoff({ action: "stop", ...authority, receipt });
      if (result.state !== "stopped") throw new RuntimeServiceFault("process_handoff_unverified");
    },
    async storageUsage(ctx) {
      const result = await call(ctx, "storage_usage");
      if (!result.storageUsage) return { unavailable: "measurement_failed" };
      return result.storageUsage;
    },
    async start(ctx) {
      const result = await call(ctx, "start");
      return { ...ctx.process, ...result.processRef, generation: ctx.process.generation };
    },
    async inspect(ctx) {
      const result = await call(ctx, "inspect");
      if (result.processRef && result.processRef.generation !== ctx.process.generation) throw new RuntimeServiceFault("supervisor_lost");
      return {
        state: result.state === "running" || result.state === "missing" ? result.state : "exited",
        processRef: result.processRef ? { ...ctx.process, ...result.processRef, generation: ctx.process.generation } : undefined,
        endpoints: result.endpoints ?? [], exitCode: result.exitCode,
      };
    },
    async stop(ctx) {
      try { const result = await call(ctx, "logs", { limitBytes: 128 * 1024 }); await saveLogs(ctx, result.logs ?? ""); } catch { /* Logs cannot prevent termination. */ }
      const result = await call(ctx, "stop");
      if (result.state !== "exited" && result.state !== "stopped" && result.state !== "missing") throw new Error("Service stop was not verified");
    },
    async logs(ctx, limitBytes) {
      try {
        const result = await call(ctx, "logs", { limitBytes: Math.min(limitBytes, 128 * 1024) });
        await saveLogs(ctx, result.logs ?? "");
        return result.logs ?? "";
      } catch (error) {
        const cached = await fs.readFile(logPath(ctx), "utf8").then((value) => JSON.parse(value) as { savedAt: string; text: string }).catch(() => null);
        if (!cached) throw error;
        return `[Saved logs from ${cached.savedAt}; live logs are unavailable]\n${cached.text.slice(-Math.max(1, limitBytes))}`;
      }
    },
    async upstream(ctx, endpointName) {
      const result = await call(ctx, "endpoint", { endpointName });
      if (!result.upstream) throw new Error("Provider did not expose a service endpoint");
      return result.upstream;
    },
    async retainAllocation(ctx) { await call(ctx, "retain"); },
    async releaseCompute(ctx) {
      const result = await call(ctx, "release_compute");
      if (result.state !== "stopped" && result.state !== "retained") throw new Error("Sandbox compute release was not verified");
      return result.state;
    },
  };
}
