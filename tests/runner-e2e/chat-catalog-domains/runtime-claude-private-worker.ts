import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { test, type Cookie } from "@playwright/test";
import { matchesClaudeFixtureTarget, type ClaudePrivateRequest, type ClaudePrivateReceipt } from "./runtime-claude-private.js";
import type { Environment } from "../../../packages/shared/src/types/environment.js";
import type { AiRuntimeConnectionBinding } from "../../../packages/shared/src/ai-connection-router.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import { agentHarnessType } from "../../../packages/shared/src/agent-runner.js";
async function main(): Promise<ClaudePrivateReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone child only */ }
  if (attached) throw new Error("Claude credential operation cannot run inside Playwright Test");
  const input = JSON.parse(await readFile(process.argv[2]!, "utf8")) as ClaudePrivateRequest & { companyId: string; environmentId: string; baseURL: string; cookies: Cookie[] };
  const base = new URL(input.baseURL);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || ![input.companyId, input.environmentId].every(id => /^[a-f0-9-]{36}$/i.test(id)) || !["check-harness", "prepare-account", "validate-saved"].includes(input.operation)) throw new Error("Invalid private Claude operation binding");
  const headers = { Cookie: input.cookies.map(row => `${row.name}=${row.value}`).join("; "), Origin: base.origin, "Content-Type": "application/json" };
  async function json<T>(pathname: string, body?: unknown): Promise<T> {
    const target = new URL(pathname, base); if (target.origin !== base.origin || !pathname.startsWith("/api/")) throw new Error("Private Claude request escaped its actual instance");
    const response = await fetch(target, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers, redirect: "error", signal: AbortSignal.timeout(150000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Actual selected Claude public operation rejected"); } return response.json() as Promise<T>;
  }
  const [environment, inventory, company] = await Promise.all([json<Environment>(`/api/environments/${input.environmentId}`), json<Environment[]>(`/api/companies/${input.companyId}/environments`), json<{ id: string }>(`/api/companies/${input.companyId}`)]);
  if (!matchesClaudeFixtureTarget({ company, expectedCompanyId: input.companyId, fixtureEnvironmentId: input.environmentId, detail: environment, listed: inventory })) throw new Error("Selected Claude fixture requires the exact owned local target with actual public inventory/company authority");
  if (input.operation === "check-harness") {
    if (!path.isAbsolute(input.harnessExecutable)) throw new Error("Claude command qualification requires its actual explicit executable path");
    const version = await promisify(execFile)(input.harnessExecutable, ["--version"], { timeout: 15000, maxBuffer: 16384 });
    if (!/\bClaude Code\b/i.test(version.stdout) || !/\b\d+\.\d+\.\d+\b/.test(version.stdout)) throw new Error("The selected executable did not identify the real installed Claude Code CLI");
    return { processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, operation: input.operation, companyId: input.companyId, environmentId: input.environmentId, probeStatus: "pass", probeCheckCodes: ["actual_claude_code_version_observed"] };
  }
  let connectionId: string, grantId: string, config: Record<string, unknown>, agentId: string | undefined, savedType: string | undefined, savedBinding: AiRuntimeConnectionBinding | undefined;
  if (input.operation === "prepare-account") {
    if (!input.credential || !input.harnessExecutable || !input.model) throw new Error("Missing selected Claude credential/command/model");
    const connection = await json<{ connectionId: string; grantId: string }>(`/api/companies/${input.companyId}/ai-connections`, { provider: "anthropic", method: "api_key", name: "Claude eval account", ownership: "personal", apiKey: input.credential, allAgents: true, agentIds: [] });
    connectionId = connection.connectionId; grantId = connection.grantId; config = { command: input.harnessExecutable, model: input.model };
  } else {
    agentId = input.agentId; const agent = await json<Agent>(`/api/agents/${agentId}`);
    const settings = await json<{ defaultEnvironmentId?: string | null; experimental?: { enableManagedSandboxOnly?: boolean }; general?: { executionMode?: string } }>("/api/instance/settings");
    const managedLocal = inventory.filter(row => row.driver === "local");
    const effectiveEnvironmentId = agent.defaultEnvironmentId ?? settings.defaultEnvironmentId ?? (managedLocal.length === 1 ? managedLocal[0]!.id : undefined);
    if (settings.experimental?.enableManagedSandboxOnly || settings.general?.executionMode === "kubernetes") throw new Error("Saved target requires its actual managed/sandbox execution qualification, not an implicit host fallback");
    if (agent.companyId !== input.companyId || effectiveEnvironmentId !== input.environmentId || agentHarnessType(agent.adapterType, agent.adapterConfig) !== "claude_local") throw new Error("Saved hire is not the selected same-company Claude target");
    connectionId = input.connectionId; grantId = input.grantId; config = agent.adapterConfig; savedType = agent.adapterType;
    savedBinding = agent.runtimeConfig.aiConnection;
    if (!savedBinding || savedBinding.mode === "router" || savedBinding.provider !== "anthropic" || savedBinding.mode !== "responsible_user" && (savedBinding.connectionId !== connectionId || savedBinding.grantId !== grantId)) throw new Error("Saved Claude configuration lacks the actual selected managed Anthropic binding; ambient login fallback is forbidden");
  }
  const binding = { provider: "anthropic", method: "api_key", mode: "delegated", connectionId, grantId };
  const probe = await json<{ status: "pass" | "warn" | "fail"; checks: Array<{ code: string }> }>(`/api/companies/${input.companyId}/adapters/${savedType ?? "claude_local"}/test-environment`, { ...(agentId ? { agentId, aiConnection: savedBinding } : { runner: "legacy", aiConnection: binding }), adapterConfig: config, environmentId: input.environmentId });
  return { processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, operation: input.operation, companyId: input.companyId, environmentId: input.environmentId, connectionId, grantId, ...(agentId ? { agentId } : {}), probeStatus: probe.status, probeCheckCodes: probe.checks.map(row => row.code) };
}
main().then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.stderr.write("Selected Claude operation failed; private diagnostics withheld"); process.exitCode = 1; });
