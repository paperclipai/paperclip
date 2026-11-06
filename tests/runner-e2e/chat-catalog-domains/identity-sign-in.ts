import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { RunnerApi } from "../api.js";
import { setupLiveFixtures, type LiveFixtureValues } from "../live-fixtures.js";
import type { IdentityBoundaryCase, IdentityBoundaryContext } from "./identity-boundary-contract.js";
import { checks } from "./internal-support.js";
import { createAuthenticatedPerson } from "./identity-auth.js";

type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
interface Owned { person: Person; api: RunnerApi; other?: Person; companyId?: string; fixtures?: LiveFixtureValues }
const owned = new WeakMap<IdentityBoundaryContext, Owned>();
interface SignInEvidence {
  personId: string; returnedPersonId: string; companyId: string; conversationId: string; returnedConversationId: string;
  beforeComposerVisible: boolean; expiredReadStatus: number; expiredComposerAbsent: boolean;
  configuredSignInVisible: boolean; safeReturnPath: string; intendedReturnPath: string; restoredComposerVisible: boolean;
  nonmemberCompanyStatus: number; nonmemberConversationStatus: number; nonmemberBrowserBlocked: boolean;
  beforeCommentIds: string[]; afterCommentIds: string[]; runIds: string[];
}
export function gradeSignInBoundary(value: unknown) {
  const c = checks(); const o = value as SignInEvidence | undefined;
  c.add("real-invalidated-human-session", !!o && !!o.personId && o.personId !== "local-board" && o.beforeComposerVisible
    && [401, 404].includes(o.expiredReadStatus) && o.expiredComposerAbsent, "A previously usable real human session is revoked by the server; the expired browser cannot read or compose in its conversation.");
  c.add("configured-safe-sign-in-return", !!o && o.configuredSignInVisible && typeof o.safeReturnPath === "string" && o.safeReturnPath === o.intendedReturnPath
    && o.safeReturnPath.startsWith("/") && !o.safeReturnPath.startsWith("//") && o.returnedPersonId === o.personId
    && o.returnedConversationId === o.conversationId && o.restoredComposerVisible,
    "The ordinary configured sign-in form authenticates the same person and returns to the same real company conversation.");
  c.add("authentication-retains-resource-checks", !!o && [403, 404].includes(o.nonmemberCompanyStatus)
    && [403, 404].includes(o.nonmemberConversationStatus) && o.nonmemberBrowserBlocked,
    "A different genuinely signed-in nonmember remains unable to access either the company or the original conversation.");
  c.add("no-expired-query-or-dispatch", !!o && Array.isArray(o.runIds) && o.runIds.length === 0
    && Array.isArray(o.beforeCommentIds) && Array.isArray(o.afterCommentIds)
    && JSON.stringify(o.beforeCommentIds) === JSON.stringify(o.afterCommentIds),
    "The boundary retains unsent intent: no native run or extra human/agent comment is admitted before or after authentication.");
  return c.result();
}
export const signInIdentityBoundaryCases: readonly IdentityBoundaryCase[] = [{
  scenarioId: "access.sign-in", journeyKind: "browser-boundary", boundaryTarget: "authenticated-harness", authentication: "human-session",
  oracleVersion: "paperclip.chat-catalog.identity.v1", expectedRunCount: 0, expectedHumanMessageCount: 0, turnTimeoutMs: 120_000, attemptTimeoutMs: 300_000,
  sourceFiles: ["chat-catalog-domains/identity-sign-in.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-boundary-contract.ts", "chat-catalog-domains/internal-support.ts", "live-fixtures.ts", "chat-scenarios/access.yaml"],
  grade: gradeSignInBoundary,
  async run(ctx) {
    const browser = ctx.page.context().browser(); if (!browser) throw new Error("Real human boundary needs a browser");
    const person = await createAuthenticatedPerson({ api: ctx.api, browser, secrets: ctx.privateSecrets, name: "Alex" });
    const api = new RunnerApi(person.context.request); person.bindApiSession(api); const resources: Owned = { person, api }; owned.set(ctx, resources);
    // The isolated installation's first real account follows the public operator
    // claim, exactly as the authenticated Product E2E harness does. This does not
    // grant any later observer or agent an instance-admin identity.
    await api.post("/api/bootstrap/claim");
    await api.patch("/api/instance/settings/experimental", { enableAgentChat: true });
    const workspacePath = path.join(ctx.privateDir, "sign-in-workspace"); await mkdir(workspacePath, { recursive: true, mode: 0o700 });
    const fixtures = await setupLiveFixtures({ api, execution: ctx.execution, executionNonce: ctx.nonce, workspacePath, credentials: ctx.credentials,
      async onCompanyCreated(id) { resources.companyId = id; ctx.observeResources({ companyId: id, runIds: [] }); } });
    resources.fixtures = fixtures;
    const root = `/api/companies/${fixtures.company.id}`;
    const conversation = await api.post<{ id: string }>(`${root}/chats/${fixtures.agent.id}`);
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds: [] });
    const intendedReturnPath = `/${fixtures.company.issuePrefix}/chats/${fixtures.agent.id}`;
    const page = await person.context.newPage();
    await page.goto(intendedReturnPath, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    const beforeCommentIds = (await api.get<Array<{ id: string }>>(`/api/issues/${conversation.id}/comments`)).map(row => row.id).sort();
    await person.expireSession();
    const expired = await person.context.request.get(`${api.baseURL}/api/issues/${conversation.id}`); const expiredReadStatus = expired.status(); await expired.dispose();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Sign in to Paperclip", exact: true })).toBeVisible();
    const safeReturnPath = new URL(page.url()).searchParams.get("next") ?? "";
    const expiredComposerAbsent = await page.getByTestId("task-chat-composer-input").count() === 0;
    await person.signInThroughBrowser(page, intendedReturnPath); person.bindApiSession(api);
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    const returned = await api.get<{ user: { id: string } }>("/api/auth/get-session");
    const same = await api.get<{ id: string }>(`${root}/chats/${fixtures.agent.id}`);
    const other = await createAuthenticatedPerson({ api, browser, secrets: ctx.privateSecrets, name: "Unenrolled Riley" }); resources.other = other;
    const deniedCompany = await other.request(root); const nonmemberCompanyStatus = deniedCompany.status; await deniedCompany.body?.cancel();
    const deniedConversation = await other.request(`/api/issues/${conversation.id}`); const nonmemberConversationStatus = deniedConversation.status; await deniedConversation.body?.cancel();
    const otherPage = await other.context.newPage(); await otherPage.goto(intendedReturnPath, { waitUntil: "domcontentloaded" });
    await expect(otherPage.getByRole("heading", { name: "No organization access", exact: true })).toBeVisible();
    const runIds = (await api.get<Array<{ id: string }>>(`${root}/heartbeat-runs?limit=100`)).map(row => row.id);
    ctx.observeResources({ companyId: fixtures.company.id, agentId: fixtures.agent.id, runIds });
    const observation: SignInEvidence = { personId: person.id, returnedPersonId: returned.user.id, companyId: fixtures.company.id, conversationId: conversation.id,
      returnedConversationId: same.id, beforeComposerVisible: true, expiredReadStatus, expiredComposerAbsent, configuredSignInVisible: true,
      safeReturnPath, intendedReturnPath, restoredComposerVisible: true, nonmemberCompanyStatus, nonmemberConversationStatus, nonmemberBrowserBlocked: true,
      beforeCommentIds, afterCommentIds: (await api.get<Array<{ id: string }>>(`/api/issues/${conversation.id}/comments`)).map(row => row.id).sort(), runIds };
    await ctx.evidence("identity-real-sign-in.json", observation); return observation;
  },
  async cleanup(ctx) {
    const resources = owned.get(ctx); if (!resources) return;
    try {
      // Reauthenticate privately if an earlier phase stopped with its session
      // expired; cleanup must not rely on the positive sign-in assertion.
      await resources.person.signIn(); resources.person.bindApiSession(resources.api);
      await resources.fixtures?.teardown();
      if (resources.companyId) await resources.api.delete(`/api/companies/${resources.companyId}`, { allowNotFound: true });
    } finally { try { await resources.other?.dispose(); } finally { await resources.person.dispose(); owned.delete(ctx); } }
  },
}];
