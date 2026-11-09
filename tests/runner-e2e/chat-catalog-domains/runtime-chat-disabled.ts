import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { RunnerApi } from "../api.js";
import { setupLiveFixtures, type LiveFixtureValues } from "../live-fixtures.js";
import { createAuthenticatedPerson } from "./identity-auth.js";
import { checks } from "./internal-support.js";
import type { IdentityBoundaryCase, IdentityBoundaryContext } from "./identity-boundary-contract.js";
/**
 * Agent Chat is always on since #19360, so this boundary now covers the gate that still exists:
 * the Conference Room experiment (enableConferenceRoomChat, default off, opt-in hidden from
 * settings by #8237). A real signed-in person follows an old Conference Room link. The product
 * redirects to the company dashboard rather than a broken route, does not list the Conference
 * Room, still offers ordinary Chat with Morgan, refuses the board discussion API, and an
 * ordinary agent cannot flip the instance setting. The opt-in is deliberately not offered in
 * the UI today, so no visible operator control is required here.
 */
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const owned = new WeakMap<IdentityBoundaryContext, { person: Person; api: RunnerApi; companyId?: string; fixtures?: LiveFixtureValues; keyId?: string }>();
export interface ConferenceRoomOffObservation { companyId: string; companyPrefix: string; agentId: string; personId: string; canonicalIntent: string;
  conferenceRoomEnabled: boolean; oldLinkLandedPath: string; conferenceComposerVisible: boolean; conferenceNavOffered: boolean;
  chatAlternativePath: string; chatAlternativeAgentRefs: string[]; chatComposerVisible: boolean;
  boardChatStatus: number; boardChatErrorCode: string; boardChatProbePersonId: string;
  agentSettingsStatus: number; gateAfterProbe: boolean;
  beforeTaskIds: string[]; afterTasks: Array<{ id: string; conversationAgentId: string | null }>; runIds: string[] }
/** Probe the board discussion API with the genuine person's same-origin session wrapper.
 * Return only the closed refusal code, never the raw response or credential. */
export async function probeBoardChatAsPerson(person: Pick<Person, "id" | "request">, companyId: string, message: string) {
  const response = await person.request("/api/board/chat/stream", "POST", { companyId, message });
  const status = response.status;
  const body = await response.json().catch(() => undefined) as { code?: unknown; error?: unknown } | undefined;
  const code = body?.code === "FEATURE_DISABLED" ? "FEATURE_DISABLED" : body?.code === "DEPLOYMENT_MODE_UNSUPPORTED" ? "DEPLOYMENT_MODE_UNSUPPORTED"
    : body?.error === "Board mutation requires trusted browser origin" ? "trusted-origin-required" : "unrecognized-response";
  return { boardChatStatus: status, boardChatErrorCode: code, boardChatProbePersonId: person.id };
}
export function gradeConferenceRoomOff(value: unknown) {
  const c = checks(); const o = value as ConferenceRoomOffObservation | undefined;
  c.add("actual-conference-room-off-context", !!o && !!o.companyId && !!o.companyPrefix && !!o.agentId && !!o.personId && o.personId !== "local-board"
    && o.canonicalIntent === "Open the conference room so I can talk with Morgan." && o.conferenceRoomEnabled === false,
  "The real signed-in human follows the Conference Room link with the instance experiment actually off; canonical intent remains unsent.");
  c.add("old-link-lands-on-working-page", !!o && o.oldLinkLandedPath === `/${o.companyPrefix}/dashboard` && !o.conferenceComposerVisible && !o.conferenceNavOffered,
  "The old Conference Room link opens this company's working dashboard, not a broken route or an unusable board composer, and navigation does not offer the Conference Room.");
  c.add("supported-chat-alternative", !!o && o.chatComposerVisible && o.chatAlternativeAgentRefs.includes(o.chatAlternativePath.split("/").at(-1) ?? "")
    && o.chatAlternativePath.startsWith(`/${o.companyPrefix}/chats/`),
  "Chat in the same navigation opens an ordinary, working chat with Morgan.");
  c.add("board-discussion-refused", !!o && o.boardChatStatus === 403 && o.boardChatErrorCode === "FEATURE_DISABLED" && o.boardChatProbePersonId === o.personId,
  "The same person's board discussion request is refused by the Conference Room gate itself, not by origin or another check.");
  c.add("ordinary-agent-cannot-change-instance-gate", !!o && o.agentSettingsStatus === 403 && o.gateAfterProbe === false,
  "The real ordinary agent cannot enable the Conference Room experiment.");
  const before = new Set(o?.beforeTaskIds ?? []);
  c.add("no-disguised-task-chat-or-run", !!o && Array.isArray(o.afterTasks) && o.beforeTaskIds.every(id => o.afterTasks.some(row => row.id === id))
    && o.afterTasks.filter(row => !before.has(row.id)).every(row => row.conversationAgentId === o.agentId)
    && Array.isArray(o.runIds) && !o.runIds.length,
  "Nothing creates a task posing as the conference room or starts a run; the only new record allowed is Morgan's own ordinary chat.");
  return c.result();
}
export const runtimeDisabledChatCases: readonly IdentityBoundaryCase[] = [{
  scenarioId: "agent-chat.chat-disabled", journeyKind: "browser-boundary", boundaryTarget: "authenticated-harness", authentication: "human-session",
  oracleVersion: "paperclip.chat-catalog.runtime-conference-off.v3", expectedRunCount: 0, expectedHumanMessageCount: 0, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
  sourceFiles: ["chat-catalog-domains/runtime-chat-disabled.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-boundary-contract.ts", "live-fixtures.ts", "chat-scenarios/agent-chat.yaml"],
  grade: gradeConferenceRoomOff,
  async run(ctx) {
    const browser = ctx.page.context().browser(); if (!browser) throw new Error("Conference Room boundary requires the real human browser");
    const person = await createAuthenticatedPerson({ api: ctx.api, browser, secrets: ctx.privateSecrets, name: "Alex" });
    const api = new RunnerApi(person.context.request); person.bindApiSession(api); const resource: { person: Person; api: RunnerApi; companyId?: string; fixtures?: LiveFixtureValues; keyId?: string } = { person, api }; owned.set(ctx, resource);
    await api.post("/api/bootstrap/claim");
    const workspacePath = path.join(ctx.privateDir, "conference-off-owned-workspace"); await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    const fixtures = await setupLiveFixtures({ api, execution: ctx.execution, executionNonce: ctx.nonce, workspacePath, credentials: ctx.credentials,
      async onCompanyCreated(id) { resource.companyId = id; ctx.observeResources({ companyId: id, runIds: [] }); } });
    resource.fixtures = fixtures;
    const prefix = fixtures.company.issuePrefix; if (!prefix) throw new Error("Conference Room boundary company has no route prefix");
    await api.patch(`/api/agents/${fixtures.agent.id}`, { name: "Morgan" });
    await api.patch("/api/instance/settings/experimental", { enableConferenceRoomChat: false });
    const settings = await api.get<{ enableConferenceRoomChat: boolean }>("/api/instance/settings/experimental");
    const morgan = await api.get<{ id: string; urlKey?: string | null }>(`/api/agents/${fixtures.agent.id}`);
    const root = `/api/companies/${fixtures.company.id}`;
    const beforeTaskIds = (await api.get<Array<{ id: string }>>(`${root}/issues?includeAgentCreatedTasks=true&limit=1000`)).map(row => row.id).sort();
    // The boundary capture callback is bound to ctx.page; authenticate that page with the same person.
    await person.installSessionOn(ctx.page.context());
    person.bindApiSession(ctx.api);
    const page = ctx.page;
    await page.goto(`/${prefix}/board-chat`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(url => url.pathname === `/${prefix}/dashboard`);
    const oldLinkLandedPath = new URL(page.url()).pathname;
    const conferenceComposerVisible = await page.getByPlaceholder("Ask anything about your organization...").isVisible();
    const chatLink = page.locator(`a[href="/${prefix}/chats"]`).first();
    await expect(chatLink).toBeVisible();
    const conferenceNavOffered = await page.locator(`a[href="/${prefix}/board-chat"]`).count() > 0;
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds: [] });
    await ctx.capture("conference-room-off", "The old Conference Room link lands on the working company dashboard; canonical intent remains unsent", "runtime-conference-room-off.png");
    // Supported alternative: the person's own Chat entry opens an ordinary chat with Morgan.
    await chatLink.click();
    const morganChoice = page.getByRole("button", { name: /Morgan/ });
    await expect.poll(async () => /\/chats\/[^/]+$/.test(new URL(page.url()).pathname) || await morganChoice.isVisible(), { timeout: 30_000 }).toBe(true);
    if (!/\/chats\/[^/]+$/.test(new URL(page.url()).pathname)) await morganChoice.click();
    await expect(page).toHaveURL(url => /\/chats\/[^/]+$/.test(url.pathname));
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    const chatAlternativePath = new URL(page.url()).pathname;
    await ctx.captureFinalState(page);
    const key = await api.postSensitive<{ id: string; token: string }>(`/api/agents/${fixtures.agent.id}/keys`, { name: "conference-off-permission-probe" });
    ctx.privateSecrets.push(key.token); resource.keyId = key.id;
    const denied = await fetch(new URL("/api/instance/settings/experimental", api.baseURL), { method: "PATCH", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key.token}`, "content-type": "application/json" }, body: JSON.stringify({ enableConferenceRoomChat: true }) });
    const agentSettingsStatus = denied.status; await denied.body?.cancel();
    const boardProbe = await probeBoardChatAsPerson(person, fixtures.company.id, ctx.scenario.query);
    const gateAfterProbe = (await api.get<{ enableConferenceRoomChat: boolean }>("/api/instance/settings/experimental")).enableConferenceRoomChat;
    const tasks = await api.get<Array<{ id: string; conversationAgentId?: string | null }>>(`${root}/issues?includeAgentCreatedTasks=true&limit=1000`);
    const runIds = (await api.get<Array<{ id: string }>>(`${root}/heartbeat-runs?limit=100`)).map(row => row.id);
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds });
    const observation: ConferenceRoomOffObservation = { companyId: fixtures.company.id, companyPrefix: prefix, agentId: fixtures.agent.id, personId: person.id,
      canonicalIntent: ctx.scenario.query, conferenceRoomEnabled: settings.enableConferenceRoomChat, oldLinkLandedPath, conferenceComposerVisible, conferenceNavOffered,
      chatAlternativePath, chatAlternativeAgentRefs: [morgan.id, ...(morgan.urlKey ? [morgan.urlKey] : [])], chatComposerVisible: true,
      ...boardProbe, agentSettingsStatus, gateAfterProbe, beforeTaskIds,
      afterTasks: tasks.map(row => ({ id: row.id, conversationAgentId: row.conversationAgentId ?? null })).sort((a, b) => a.id.localeCompare(b.id)), runIds };
    await ctx.evidence("runtime-conference-room-off-boundary.json", observation); return observation;
  },
  async cleanup(ctx) {
    const resource = owned.get(ctx); if (!resource) return;
    try { if (resource.keyId && resource.fixtures) await resource.api.delete(`/api/agents/${resource.fixtures.agent.id}/keys/${resource.keyId}`, { allowNotFound: true });
      await resource.fixtures?.teardown();
      if (resource.companyId) await resource.api.delete(`/api/companies/${resource.companyId}`, { allowNotFound: true });
    } finally { await resource.person.dispose(); owned.delete(ctx); }
  },
}];
