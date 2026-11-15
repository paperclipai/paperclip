import type { Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pollUntil, type RunnerApi } from "./api.js";
import { CHAT_OPENCODE_MODEL } from "./chat-runtime-profile.js";
import { readChatReadinessReceipts } from "./chat-readiness-observer.js";
import type { LiveFixtureValues } from "./live-fixtures.js";
import type { RunnerTaskFixture } from "./types.js";
export const CHAT_SETUP_HEALTH_SUITE = "chat-setup-health";
export const CHAT_SETUP_HEALTH_ID = "chat-setup-health.runner-opencode.local.setup-only";
export class SetupHealthAbort extends Error {
  constructor() { super("Setup health cleanup failed; owned supervisor stop requested, no further API observations"); }
}
const stopPath = (root: string) => path.join(root, "artifacts-private", "chat-setup-health-stop.json");
export async function requestSetupHealthStop(root: string) {
  await writeFile(stopPath(root), JSON.stringify({ executionId: CHAT_SETUP_HEALTH_ID, temporaryRoot: root }), { flag: "wx", mode: 0o600 });
}
/** Exact one-cell request, consumed only by the existing owned supervisor. */
export async function stopSetupHealthIfRequested(input: { executionIds: readonly string[]; temporaryRoot: string; stop(): Promise<void> }) {
  if (input.executionIds.length !== 1 || input.executionIds[0] !== CHAT_SETUP_HEALTH_ID) return false;
  let file;
  try {
    const root = await realpath(input.temporaryRoot), rootInfo = await stat(root);
    if (root !== input.temporaryRoot || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077)) return false;
    file = await open(stopPath(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== rootInfo.uid || (info.mode & 0o077) || info.size > 1024) return false;
    const row = JSON.parse(await file.readFile("utf8"));
    if (row?.executionId !== CHAT_SETUP_HEALTH_ID || row?.temporaryRoot !== root) return false;
  } catch { return false; }
  finally { await file?.close(); }
  await input.stop();
  return true;
}
export const chatSetupHealthTask: RunnerTaskFixture = {
  id: "setup-only", label: "One normal OpenCode setup verification; no catalog request", groups: [], flow: "setup_health", workMode: "standard",
  expectedRunCount: 0, automaticRetryPolicy: "single_attempt", turnTimeoutMs: 60_000,
  attemptTimeoutMs: { local: 180_000, daytona: 180_000 }, expectedTerminalState: { issue: "in_review", run: "succeeded" },
  buildTitle: () => "Setup health only", buildPrompt: () => "", buildVisibleMarker: () => "",
  buildMatchers: () => [],
};
export const chatSetupHealthDigest = createHash("sha256").update([
  "chat-setup-health.ts", "chat-setup-credential.ts", "chat-readiness-observer.ts", "server-entry.ts", "runner.spec.ts", "live-fixtures.ts", "chat-remote-host.ts", "server.ts",
].map(file => readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).join("\n")).digest("hex");
interface HealthAgent { id: string; companyId: string; lifecycleState?: string; lifecycleError?: string | null; status: string;
  defaultEnvironmentId?: string | null; adapterType: string; adapterConfig?: Record<string, unknown> }
export function gradeSetupHealth(state: {
  ready: boolean; agentCount: number; configMatches: boolean; issues: number; conversations: number; comments: number; humanComments: number; runs: number;
  probes: Awaited<ReturnType<typeof readChatReadinessReceipts>>;
}) {
  return [
    { id: "ordinary-agent-ready", passed: state.ready && state.agentCount === 1 && state.configMatches },
    { id: "one-ordinary-hello", passed: state.probes.length === 1 && !state.probes[0]!.thrown
      && ["pass", "warn"].includes(state.probes[0]!.status) && state.probes[0]!.checks.some(check => check.code === "opencode_hello_probe_passed" && check.level === "info") },
    { id: "zero-chat-or-task-work", passed: state.issues === 0 && state.conversations === 0 && state.comments === 0 && state.humanComments === 0 && state.runs === 0 },
  ];
}
export async function runChatSetupHealth(input: { api: RunnerApi; fixtures: LiveFixtureValues; temporaryRoot: string;
  evidence(name: string, value: unknown): Promise<void> }) {
  const { api, fixtures: f } = input;
  let ready = false;
  try {
    await pollUntil({ label: "ordinary setup-health agent readiness", deadlineAt: Date.now() + 75_000, intervalMs: 250,
      load: () => api.get<HealthAgent>(`/api/agents/${f.agent.id}`, { timeout: 5_000 }),
      accept: agent => agent.lifecycleState === "ready" && ["idle", "active"].includes(agent.status),
      reject: agent => agent.lifecycleError ? "Actual setup-health lifecycle verification failed" : undefined });
    ready = true;
  } finally {
    // GET only: no chat resolution/creation, task dispatch or explicit second probe.
    const company = `/api/companies/${f.company.id}`;
    let diagnosticFailure = false;
    try {
      const probes = await readChatReadinessReceipts(input.temporaryRoot, f.company.id);
      await input.evidence("chat-setup-health.json", { schema: "paperclip.chat-setup-health/v1", scope: "diagnostic-outside-244",
        companyId: f.company.id, agentId: f.agent.id, probes, publicState: "not-yet-verified",
        setupProbeUsage: "unavailable outside heartbeat accounting; never zero" });
    } catch { diagnosticFailure = true; }
    // Always fence future automatic verification, even when diagnostic I/O fails.
    try { await api.post(`/api/agents/${f.agent.id}/pause`, {}, { timeout: 5_000 }); }
    catch {
      let stopRequested = false;
      try { await requestSetupHealthStop(input.temporaryRoot); stopRequested = true; } catch { /* Preserve uncertain cleanup. */ }
      try { await input.evidence("chat-setup-health-cleanup.json", { scope: "diagnostic-outside-244", pauseFailed: true, stopRequested, cleanup: "failed" }); } catch { /* Do not delay owned stop for diagnostics. */ }
      throw new SetupHealthAbort();
    }
    if (diagnosticFailure) throw new Error("Setup health diagnostics unavailable after normal public pause");
    // Read after the pause fence too: a late second completion must fail the count.
    const probes = await readChatReadinessReceipts(input.temporaryRoot, f.company.id);
    const settings = await api.get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental", { timeout: 5_000 });
    if (!settings.enableAgentChat) await api.patch("/api/instance/settings/experimental", { enableAgentChat: true });
    const [agents, issues, conversations, runs] = await Promise.all([
      api.get<HealthAgent[]>(`${company}/agents`, { timeout: 5_000 }), api.get<Array<{ id: string }>>(`${company}/issues?includeAgentCreatedTasks=true&limit=100`, { timeout: 5_000 }),
      api.get<Array<{ id: string }>>(`${company}/chats`, { timeout: 5_000 }), api.get<unknown[]>(`${company}/heartbeat-runs?limit=100`, { timeout: 5_000 }),
    ]);
    const sourceIds = [...new Set([...issues, ...conversations].map(row => row.id))];
    const comments = (await Promise.all(sourceIds.map(id => api.get<Array<{ authorUserId?: string | null }>>(`/api/issues/${id}/comments?order=asc`, { timeout: 5_000 })))).flat();
    const agent = agents.find(row => row.id === f.agent.id);
    const state = { ready, agentCount: agents.length, configMatches: agent?.companyId === f.company.id && agent.defaultEnvironmentId === f.environment.id
      && agent.adapterType === "paperclip_runner" && agent.adapterConfig?.provider === "opencode" && agent.adapterConfig?.model === CHAT_OPENCODE_MODEL,
      issues: issues.length, conversations: conversations.length, comments: comments.length, humanComments: comments.filter(row => row.authorUserId).length,
      runs: runs.length, probes };
    const checks = gradeSetupHealth(state);
    await input.evidence("chat-setup-health.json", { schema: "paperclip.chat-setup-health/v1", scope: "diagnostic-outside-244", companyId: f.company.id,
      agentId: f.agent.id, state, checks, canonicalQueries: state.humanComments,
      setupProbeUsage: "One ordinary automatic lifecycle hello is expected. Provider tokens and cost are unavailable outside heartbeat accounting; never reported as zero." });
    await input.evidence("api-state.json", { scope: "diagnostic-outside-244", capturePhase: "after-public-pause",
      companyId: f.company.id, agentId: f.agent.id, observed: state, checks });
    if (checks.some(check => !check.passed)) throw new Error("Setup health failed; inspect retained closed readiness diagnostics");
  }
}

/** Genuine readonly diagnostic UI evidence, never published as a task screenshot. */
export async function captureSetupHealthProfile(input: {
  executionId: string; api: RunnerApi; page: Page; companyId: string; agentId: string;
  capturePrivate(id: string, filename: string): Promise<void>;
}) {
  if (input.executionId !== CHAT_SETUP_HEALTH_ID) throw new Error("Setup health evidence requires its exact diagnostic cell");
  const [company, agent] = await Promise.all([
    input.api.get<{ id: string; issuePrefix: string }>(`/api/companies/${input.companyId}`),
    input.api.get<{ id: string; companyId: string; name: string; urlKey: string }>(`/api/agents/${input.agentId}`),
  ]);
  if (company.id !== input.companyId || agent.id !== input.agentId || agent.companyId !== company.id
    || !company.issuePrefix || !agent.name || !agent.urlKey) throw new Error("Setup health evidence resource mismatch");
  const origin = new URL(input.api.baseURL);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.username || origin.password)
    throw new Error("Setup health evidence requires the owned loopback app");
  const url = new URL(`/${encodeURIComponent(company.issuePrefix)}/agents/${encodeURIComponent(agent.urlKey)}/overview`, origin).href;
  await input.page.goto(url, { waitUntil: "domcontentloaded" });
  await input.page.getByRole("main").getByRole("heading", { name: agent.name, exact: true }).waitFor({ state: "visible" });
  if (input.page.url() !== url) throw new Error("Setup health evidence route mismatch");
  await input.capturePrivate("setup-health-final-state", "final-state.png");
}
