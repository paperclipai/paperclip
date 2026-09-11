/**
 * Paperclip adapter for NVIDIA OpenShell -- runs agents in sandboxed containers.
 *
 * This adapter calls the OpenShell gateway's gRPC API directly (no ShoreGuard).
 * Each agent run:
 *   1. Creates (or reuses) an OpenShell sandbox pod
 *   2. Executes the agent command inside the sandbox
 *   3. Streams stdout/stderr back to Paperclip's run log
 *   4. Optionally cleans up the sandbox
 */

import {
  createSandbox,
  waitForSandboxReady,
  execInSandbox,
  deleteSandbox,
  healthCheck,
  listSandboxes,
  getSandbox,
} from "./openshell-client.js";

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

interface AdapterExecutionContext {
  runId: string;
  agent: { id: string; name: string; companyId: string };
  runtime: any;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}

interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  summary?: string;
  errorMessage?: string;
  errorCode?: string;
}

interface AdapterEnvironmentTestContext {
  config: Record<string, unknown>;
}

interface AdapterEnvironmentTestResult {
  checks: Array<{ code: string; level: string; passed: boolean; message: string }>;
}

interface ServerAdapterModule {
  type: string;
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
  testEnvironment: (ctx: AdapterEnvironmentTestContext) => Promise<AdapterEnvironmentTestResult>;
  models: Array<{ id: string; label: string }>;
  agentConfigurationDoc: string;
}

/**
 * Shell-escape a string for safe inclusion in a single-quoted shell argument.
 * Replaces each ' with '\'' (end quote, escaped quote, reopen quote).
 */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog } = ctx;

  const endpoint = asString(config.gatewayEndpoint, "openshell.openshell.svc:8080");
  const image = asString(config.sandboxImage, "ghcr.io/nvidia/openshell-community/sandboxes/base:latest");
  const gpu = Boolean(config.gpu);
  const reuseStrategy = asString(config.reuseStrategy, "per-run");
  const timeoutSecs = asNumber(config.timeoutSecs, 600);
  const agentCommand = asString(config.agentCommand, "claude");

  const sandboxName = reuseStrategy === "per-agent"
    ? `pc-${agent.id.slice(0, 8)}`
    : `pc-${runId.slice(0, 8)}`;

  const wakePrompt = asString(
    (context as any).paperclipTaskMarkdown || (context as any).wakePrompt,
    `Task: ${asString((context as any).issueTitle, "No task assigned")}`
  );

  await onLog("stdout", `[openshell] Endpoint: ${endpoint}\n`);
  await onLog("stdout", `[openshell] Sandbox: ${sandboxName} (strategy: ${reuseStrategy})\n`);
  await onLog("stdout", `[openshell] Image: ${image}\n`);
  await onLog("stdout", `[openshell] Agent command: ${agentCommand}\n\n`);

  try {
    let needsCreate = true;
    if (reuseStrategy === "per-agent") {
      try {
        const existing = await listSandboxes(endpoint);
        if (existing.some((s) => s.name === sandboxName && s.phase === "SANDBOX_PHASE_READY")) {
          await onLog("stdout", `[openshell] Reusing existing sandbox: ${sandboxName}\n`);
          needsCreate = false;
        }
      } catch {
        // List failed, will create
      }
    }

    if (needsCreate) {
      await onLog("stdout", `[openshell] Creating sandbox...\n`);
      const sb = await createSandbox(endpoint, {
        name: sandboxName,
        image,
        gpu,
        environment: {
          PAPERCLIP_RUN_ID: runId,
          PAPERCLIP_AGENT_ID: agent.id,
          PAPERCLIP_AGENT_NAME: agent.name,
        },
        labels: {
          "paperclip.ai/agent-id": agent.id,
          "paperclip.ai/run-id": runId,
        },
      });
      await onLog("stdout", `[openshell] Sandbox created: ${sb.name} (phase: ${sb.phase})\n`);

      await onLog("stdout", `[openshell] Waiting for sandbox to be ready...\n`);
      await waitForSandboxReady(endpoint, sandboxName, 120000);
      await onLog("stdout", `[openshell] Sandbox is ready.\n\n`);
    }

    await onLog("stdout", `[openshell] Executing: ${agentCommand}\n`);
    await onLog("stdout", `[openshell] Timeout: ${timeoutSecs}s\n\n`);

    if (ctx.onSpawn) {
      await ctx.onSpawn({ pid: 0, processGroupId: null, startedAt: new Date().toISOString() });
    }

    const sbInfo = await getSandbox(endpoint, sandboxName);
    const sandboxId = sbInfo.id;
    if (!sandboxId) {
      throw new Error(`Sandbox ${sandboxName} has no ID -- cannot exec`);
    }
    await onLog("stdout", `[openshell] Sandbox ID: ${sandboxId}\n`);

    const cmd = [agentCommand, "--print", "-", "--prompt", wakePrompt];

    const result = await execInSandbox(endpoint, sandboxId, cmd, {
      timeoutSecs,
    });

    if (result.stdout) {
      await onLog("stdout", result.stdout);
    }
    if (result.stderr) {
      await onLog("stderr", result.stderr);
    }

    if (reuseStrategy === "per-run") {
      await onLog("stdout", `\n[openshell] Cleaning up sandbox...\n`);
      try {
        await deleteSandbox(endpoint, sandboxName);
        await onLog("stdout", `[openshell] Sandbox deleted.\n`);
      } catch (err) {
        await onLog("stderr", `[openshell] Cleanup warning: ${err}\n`);
      }
    }

    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: false,
      summary: `OpenShell sandbox ${sandboxName}: exit ${result.exitCode}`,
    };
  } catch (err: any) {
    await onLog("stderr", `[openshell] Error: ${err.message}\n`);

    if (reuseStrategy === "per-run") {
      try { await deleteSandbox(endpoint, sandboxName); } catch {}
    }

    return {
      exitCode: 1,
      signal: null,
      timedOut: err.message?.includes("timeout"),
      errorMessage: err.message,
      errorCode: "openshell_error",
    };
  }
}

async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  const config = parseObject(ctx.config);
  const endpoint = asString(config.gatewayEndpoint, "openshell.openshell.svc:8080");

  try {
    const healthy = await healthCheck(endpoint);
    checks.push({
      code: "openshell_gateway_reachable",
      level: "required",
      passed: healthy,
      message: healthy
        ? `OpenShell gateway at ${endpoint} is reachable`
        : `Cannot reach OpenShell gateway at ${endpoint}`,
    });
  } catch (err: any) {
    checks.push({
      code: "openshell_gateway_reachable",
      level: "required",
      passed: false,
      message: `OpenShell gateway check failed: ${err.message}`,
    });
  }

  return { checks };
}

export const openshellDirectAdapter: ServerAdapterModule = {
  type: "openshell_direct",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# OpenShell Direct Adapter

Runs agents inside NVIDIA OpenShell sandboxed containers via direct gRPC.

Required fields:
- gatewayEndpoint (string): OpenShell gateway gRPC endpoint (default: openshell.openshell.svc:8080)

Optional fields:
- sandboxImage (string): Container image for sandboxes (default: base image)
- agentCommand (string): Agent CLI to run inside sandbox (default: claude)
- gpu (boolean): Request GPU (default: false)
- reuseStrategy (string): "per-run" (ephemeral) or "per-agent" (reuse) (default: per-run)
- timeoutSecs (number): Command execution timeout (default: 600)
`,
};

export function createServerAdapter() {
  return openshellDirectAdapter;
}

export default openshellDirectAdapter;
