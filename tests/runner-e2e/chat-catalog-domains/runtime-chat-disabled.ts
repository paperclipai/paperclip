import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { RunnerApi } from "../api.js";
import { setupLiveFixtures, type LiveFixtureValues } from "../live-fixtures.js";
import { createAuthenticatedPerson } from "./identity-auth.js";
import { checks } from "./internal-support.js";
import type { IdentityBoundaryCase, IdentityBoundaryContext } from "./identity-boundary-contract.js";
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const owned = new WeakMap<IdentityBoundaryContext, { person: Person; api: RunnerApi; companyId?: string; fixtures?: LiveFixtureValues; keyId?: string }>();
interface DisabledObservation { companyId: string; agentId: string; personId: string; canonicalIntent: string; agentChatEnabled: boolean;
  unavailableVisible: boolean; composerAbsent: boolean; supportedOperatorStepVisible: boolean; profileAccessible: boolean;
  agentSettingsStatus: number; createChatStatus: number; createChatErrorCategory: string; createChatProbePersonId: string; gateAfterProbe: boolean; beforeTaskIds: string[]; afterTaskIds: string[]; chatIds: string[]; runIds: string[] }
/** Use the same genuine person's existing private same-origin session wrapper.
 * Return only a closed error category, never the raw response or credential. */
export async function probeDisabledChatAsPerson(person: Pick<Person, "id" | "request">, companyId: string, agentId: string) {
  const response = await person.request(`/api/companies/${encodeURIComponent(companyId)}/chats/${encodeURIComponent(agentId)}`, "POST", {});
  const status = response.status;
  const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
  const errorCategory = body?.error === "Agent Chat is disabled" ? "agent-chat-disabled"
    : body?.error === "Board mutation requires trusted browser origin" ? "trusted-origin-required" : "unrecognized-response";
  return { createChatStatus: status, createChatErrorCategory: errorCategory, createChatProbePersonId: person.id };
}
export function gradeDisabledChat(value: unknown) {
  const c = checks(); const o = value as DisabledObservation | undefined;
  c.add("actual-disabled-canonical-context", !!o && !!o.companyId && !!o.agentId && !!o.personId && o.personId !== "local-board"
    && o.canonicalIntent === "Open a chat with Morgan." && o.agentChatEnabled === false && o.unavailableVisible && o.composerAbsent,
  "The real signed-in human opens the intended Morgan Agent Chat target with its actual gate disabled; canonical intent remains unsent.");
  c.add("clear-supported-human-path", !!o && o.supportedOperatorStepVisible && o.profileAccessible,
  "The unavailable surface identifies Experimental settings as the human management step, and the actual Morgan profile remains usable.");
  c.add("ordinary-agent-cannot-change-instance-gate", !!o && o.agentSettingsStatus === 403 && o.gateAfterProbe === false
    && o.createChatStatus === 404 && o.createChatErrorCategory === "agent-chat-disabled" && o.createChatProbePersonId === o.personId, "The real ordinary agent cannot enable instance Chat, and the public create-chat path enforces the same disabled gate.");
  c.add("no-disguised-task-or-admission", !!o && Array.isArray(o.beforeTaskIds) && Array.isArray(o.afterTaskIds)
    && JSON.stringify(o.beforeTaskIds) === JSON.stringify(o.afterTaskIds) && Array.isArray(o.chatIds) && !o.chatIds.length
    && Array.isArray(o.runIds) && !o.runIds.length,
  "Unavailable navigation admits no native work, duplicate standing chat or silently created task.");
  return c.result();
}
export const runtimeDisabledChatCases: readonly IdentityBoundaryCase[] = [{
  scenarioId: "agent-chat.chat-disabled", journeyKind: "browser-boundary", boundaryTarget: "authenticated-harness", authentication: "human-session",
  oracleVersion: "paperclip.chat-catalog.runtime.v2", expectedRunCount: 0, expectedHumanMessageCount: 0, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
  sourceFiles: ["chat-catalog-domains/runtime-chat-disabled.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-boundary-contract.ts", "live-fixtures.ts", "chat-scenarios/agent-chat.yaml"],
  grade: gradeDisabledChat,
  async run(ctx) {
    const browser = ctx.page.context().browser(); if (!browser) throw new Error("Unavailable Agent Chat boundary requires the real human browser");
    const person = await createAuthenticatedPerson({ api: ctx.api, browser, secrets: ctx.privateSecrets, name: "Alex" });
    const api = new RunnerApi(person.context.request); person.bindApiSession(api); const resource: { person: Person; api: RunnerApi; companyId?: string; fixtures?: LiveFixtureValues; keyId?: string } = { person, api }; owned.set(ctx, resource);
    await api.post("/api/bootstrap/claim");
    const workspacePath = path.join(ctx.privateDir, "disabled-chat-owned-workspace"); await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    const fixtures = await setupLiveFixtures({ api, execution: ctx.execution, executionNonce: ctx.nonce, workspacePath, credentials: ctx.credentials,
      async onCompanyCreated(id) { resource.companyId = id; ctx.observeResources({ companyId: id, runIds: [] }); } });
    resource.fixtures = fixtures;
    await api.patch(`/api/agents/${fixtures.agent.id}`, { name: "Morgan" });
    await api.patch("/api/instance/settings/experimental", { enableAgentChat: false });
    const settings = await api.get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental");
    const root = `/api/companies/${fixtures.company.id}`;
    const beforeTaskIds = (await api.get<Array<{ id: string }>>(`${root}/issues?includeAgentCreatedTasks=true&limit=1000`)).map(row => row.id).sort();
    // The boundary capture callback is bound to ctx.page. Authenticate that
    // actual page with the same genuine human session rather than inspecting
    // a second page while retaining an unrelated screenshot.
    await person.installSessionOn(ctx.page.context());
    person.bindApiSession(ctx.api); // Capture verification uses the same person through private Node fetch.
    const page = ctx.page;
    await page.goto(`/${fixtures.company.issuePrefix}/chats/${fixtures.agent.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Agent Chat is disabled for this instance\. An administrator can enable it in Experimental settings/)).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-input")).toHaveCount(0);
    const unavailableVisible = await page.getByText(/Agent Chat is disabled/).isVisible();
    const supportedOperatorStepVisible = await page.getByText(/can enable it in Experimental settings/).isVisible();
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds: [] });
    await ctx.capture("disabled-agent-chat", "Morgan Chat is genuinely unavailable; canonical intent remains unsent", "runtime-disabled-agent-chat.png");
    const key = await api.postSensitive<{ id: string; token: string }>(`/api/agents/${fixtures.agent.id}/keys`, { name: "disabled-chat-permission-probe" });
    ctx.privateSecrets.push(key.token); resource.keyId = key.id;
    const denied = await fetch(new URL("/api/instance/settings/experimental", api.baseURL), { method: "PATCH", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key.token}`, "content-type": "application/json" }, body: JSON.stringify({ enableAgentChat: true }) });
    const agentSettingsStatus = denied.status; await denied.body?.cancel();
    const createChatProbe = await probeDisabledChatAsPerson(person, fixtures.company.id, fixtures.agent.id);
    const gateAfterProbe = (await api.get<{ enableAgentChat: boolean }>("/api/instance/settings/experimental")).enableAgentChat;
    await page.goto(`/${fixtures.company.issuePrefix}/agents/${fixtures.agent.id}`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.getByRole("heading", { name: "Morgan", exact: true }).first()).toBeVisible();
    const tasks = await api.get<Array<{ id: string; conversationAgentId?: string | null }>>(`${root}/issues?includeAgentCreatedTasks=true&limit=1000`);
    const runIds = (await api.get<Array<{ id: string }>>(`${root}/heartbeat-runs?limit=100`)).map(row => row.id);
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds });
    const observation: DisabledObservation = { companyId: fixtures.company.id, agentId: fixtures.agent.id, personId: person.id, canonicalIntent: ctx.scenario.query,
      agentChatEnabled: settings.enableAgentChat, unavailableVisible, composerAbsent: true, supportedOperatorStepVisible, profileAccessible: true,
      agentSettingsStatus, ...createChatProbe, gateAfterProbe, beforeTaskIds, afterTaskIds: tasks.map(row => row.id).sort(),
      chatIds: tasks.filter(row => row.conversationAgentId).map(row => row.id), runIds };
    await ctx.evidence("runtime-disabled-chat-boundary.json", observation); return observation;
  },
  async cleanup(ctx) {
    const resource = owned.get(ctx); if (!resource) return;
    try { if (resource.keyId && resource.fixtures) await resource.api.delete(`/api/agents/${resource.fixtures.agent.id}/keys/${resource.keyId}`, { allowNotFound: true });
      await resource.fixtures?.teardown();
      if (resource.companyId) await resource.api.delete(`/api/companies/${resource.companyId}`, { allowNotFound: true });
    } finally { await resource.person.dispose(); owned.delete(ctx); }
  },
}];
