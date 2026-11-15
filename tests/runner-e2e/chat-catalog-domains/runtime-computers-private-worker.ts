import { agentHarnessType } from "../../../packages/shared/src/agent-runner.js";
import type { Agent } from "../../../packages/shared/src/types/agent.js";
import { readFile } from "node:fs/promises";
import { chromium, test } from "@playwright/test";
import type { Environment, EnvironmentProbeResult } from "../../../packages/shared/src/types/environment.js";
import type { SshComputerRequest, SshComputerReceipt } from "./runtime-computers-private.js";
async function main(): Promise<SshComputerReceipt> {
  let attached = false; try { test.info(); attached = true; } catch { /* standalone child */ }
  if (attached) throw new Error("SSH credential entry must be outside Test");
  const r = JSON.parse(await readFile(process.argv[2]!, "utf8")) as SshComputerRequest & { executablePath: string };
  const base = new URL(r.baseURL);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !/^[a-f0-9-]{36}$/i.test(r.companyId) || !["claude_local", "saved-agent"].includes(r.harness) || !["create", "probe"].includes(r.operation)) throw new Error("Invalid selected SSH binding");
  const headers = { Cookie: r.cookies.map(x => `${x.name}=${x.value}`).join("; "), Origin: base.origin, "Content-Type": "application/json" };
  async function api<T>(url: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(new URL(url, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(180000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Owned SSH public operation rejected"); } return response.json() as Promise<T>;
  }
  let id = r.environmentId, created = false;
  try {
    if (r.operation === "create") {
      const browser = await chromium.launch({ headless: true, executablePath: r.executablePath });
      try {
        const context = await browser.newContext({ baseURL: base.origin }); await context.addCookies(r.cookies);
        const page = await context.newPage(); await page.goto(`/${r.companyPrefix}/company/settings/instance/environments/new`);
        const field = (label: string) => page.locator("label").filter({ hasText: new RegExp(`^${label}$`) }).locator("../..");
        await field("Driver").locator("select").selectOption("ssh");
        for (const [label, value] of [["Name", r.name], ["Host", r.host], ["Port", String(r.port)], ["Username", r.username], ["Remote workspace path", r.remoteWorkspacePath]]) await field(label).locator("input").fill(value!);
        await field("Private key").locator("textarea").fill(r.privateKey); await field("Known hosts").locator("textarea").fill(r.knownHosts);
        const response = page.waitForResponse(x => x.request().method() === "POST" && new URL(x.url()).pathname === `/api/companies/${r.companyId}/environments`);
        await page.getByRole("button", { name: "Create environment", exact: true }).click();
        const saved = await response; if (!saved.ok()) throw new Error("Actual SSH UI create rejected");
        id = (await saved.json() as Environment).id; created = true;
      } finally { await browser.close(); }
    }
    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("No actual saved target");
    const detail = await api<Environment>(`/api/environments/${id}`), inventory = await api<Environment[]>(`/api/companies/${r.companyId}/environments`), c = detail.config;
    if (!inventory.some(x => x.id === id) || detail.driver !== "ssh" || detail.status !== "active" || detail.name !== r.name || c.host !== r.host || c.port !== r.port || c.username !== r.username || c.remoteWorkspacePath !== r.remoteWorkspacePath || c.knownHosts !== r.knownHosts || c.strictHostKeyChecking !== true) throw new Error("Saved SSH identity differs from selected target");
    let selectedHarness: string | null = null;
    let login: boolean | null = null, runtimeStatus: SshComputerReceipt["runtimeStatus"] = null, runtimeCodes: string[] = [];
    if (r.operation === "probe") {
      const savedAgent = r.harness === "saved-agent" && r.agentId ? await api<Agent>(`/api/agents/${r.agentId}`) : undefined;
      if (r.harness === "saved-agent" && (!savedAgent || savedAgent.companyId !== r.companyId || savedAgent.id !== r.agentId)) throw new Error("Actual Morgan runtime binding is missing");
      selectedHarness = savedAgent ? agentHarnessType(savedAgent.adapterType, savedAgent.adapterConfig) : "claude_local";
      const probe = await api<EnvironmentProbeResult>(`/api/environments/${id}/probe?companyId=${r.companyId}`, {}); login = probe.ok;
      if (login) { const runtime = await api<{ status: "pass" | "warn" | "fail"; checks: Array<{ code: string }> }>(`/api/companies/${r.companyId}/adapters/${savedAgent?.adapterType ?? "claude_local"}/test-environment`, savedAgent ? { agentId: savedAgent.id, adapterConfig: savedAgent.adapterConfig, ...(savedAgent.runtimeConfig.aiConnection ? { aiConnection: savedAgent.runtimeConfig.aiConnection } : {}), environmentId: id } : { environmentId: id, runner: "legacy", adapterConfig: {} });
      runtimeStatus = runtime.status; runtimeCodes = runtime.checks.map(x => x.code); }
    }
    return { processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, operation: r.operation, companyId: r.companyId, environmentId: id, savedIdentityMatched: true, login, runtimeStatus, runtimeCodes, selectedHarness, ...(r.agentId ? { agentId: r.agentId } : {}) };
  } catch {
    if (created && id) await api(`/api/environments/${id}`, undefined, "DELETE");
    throw new Error("SSH actual UI/probe failed; private diagnostics withheld");
  }
}
main().then(x => process.stdout.write(JSON.stringify(x))).catch(() => { process.stderr.write("Selected SSH journey failed; private diagnostics withheld"); process.exitCode = 1; });
