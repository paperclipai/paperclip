import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { CompanyMemberRecord, CompanyMembersResponse, UserCompanyAccessResponse } from "../../../packages/shared/src/types/access.js";
import { grantsForHumanRole } from "../../../server/src/services/company-member-roles.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireSafeInvitationEnrollment } from "./identity-invite-prerequisite.js";
import { privateIdentityBrowser } from "./identity-private-browser.js";
import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { RunnerApi } from "../api.js";

/** Finite session transfer. Only the private file path reaches Playwright Test. */
export async function installIdentitySession(target: BrowserContext, origin: string, cookie: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "identity-human-session-"));
  try {
    const file = path.join(directory, "storage.json");
    await writeFile(file, JSON.stringify({ cookies: cookie.split("; ").filter(Boolean).map(value => ({ name: value.slice(0, value.indexOf("=")), value: value.slice(value.indexOf("=") + 1),
      domain: new URL(origin).hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" as const })), origins: [] }), { mode: 0o600 });
    await target.setStorageState(file);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Credentials remain in this closure and the attempt redactor, never case state/evidence.
 * Browser installation takes only a private state filename; password entry runs
 * in a standalone child with no Playwright Test API-step recorder. */
export async function createAuthenticatedPerson(input: {
  api: RunnerApi; browser: Browser; secrets: string[]; name: string; email?: string;
}) {
  const health = await input.api.get<{ deploymentMode: string }>("/api/health");
  if (health.deploymentMode !== "authenticated") throw new Error("Authenticated-person fixtures require authenticated deployment mode; implicit local board is not a human identity");
  const email = input.email ?? `chat-eval-${randomUUID()}@example.test`;
  const password = randomBytes(32).toString("base64url"); input.secrets.push(password);
  let cookie = "";
  async function auth(path: string, data: unknown) {
    const response = await fetch(new URL(`/api/auth/${path}`, input.api.baseURL), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", Origin: input.api.baseURL, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(data),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Public authentication returned HTTP ${response.status}; details withheld`); }
    const cookies = response.headers.getSetCookie().map(value => value.split(";")[0]!).filter(value => value.includes("="));
    if (cookies.length) { cookie = cookies.join("; "); for (const value of cookies) input.secrets.push(value.slice(value.indexOf("=") + 1)); }
    return response;
  }
  const response = await auth("sign-up/email", { name: input.name, email, password });
  const user = (await response.json() as { user: { id: string; name: string } }).user;
  if (!user?.id || !cookie) throw new Error("Signup did not establish a real user session");
  const context = await input.browser.newContext({ baseURL: input.api.baseURL });
  async function installSession(target: BrowserContext) { await installIdentitySession(target, input.api.baseURL, cookie); }
  await installSession(context);
  async function request(path: string, method = "GET", data?: unknown) {
    const url = new URL(path, input.api.baseURL);
    if (url.origin !== input.api.baseURL || !url.pathname.startsWith("/api/")) throw new Error("Person request escaped fixture API");
    return fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Cookie: cookie, Origin: input.api.baseURL,
      ...(data === undefined ? {} : { "content-type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  }
  return { id: user.id, name: user.name, context, request,
    async installSessionOn(target: BrowserContext) { await installSession(target); },
    bindApiSession(api: RunnerApi) {
      if (api.baseURL !== input.api.baseURL || !cookie) throw new Error("Public human API binding requires the same authenticated instance");
      api.setBrowserSession(cookie);
    },
    /** Server revocation leaves the old browser cookie in place so the next
     * navigation exercises an actually invalid session rather than a fake UI flag. */
    async expireSession() { await auth("sign-out", {}); cookie = ""; },
    async signInThroughBrowser(page: Page, returnPath: string) {
      if (page.context() !== context || !returnPath.startsWith("/") || returnPath.startsWith("//")) throw new Error("Human sign-in target must be the person's same-origin browser");
      await privateIdentityBrowser({ kind: "sign-in", origin: input.api.baseURL, startPath: page.url(), returnPath, email, password, cookies: [] }, {
        async storageState(file) {
          const state = JSON.parse(await readFile(file, "utf8")) as { cookies: Array<{ name: string; value: string }> };
          cookie = state.cookies.map(value => `${value.name}=${value.value}`).join("; ");
          for (const value of state.cookies) input.secrets.push(value.value);
          await context.setStorageState(file);
        },
      });
      await page.goto(new URL(returnPath, input.api.baseURL).href, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new URL(returnPath, input.api.baseURL).href);
      if (!cookie) throw new Error("Human browser sign-in returned no session");
    },
    async signOut() { await auth("sign-out", {}); cookie = ""; await context.clearCookies(); },
    async signIn() { await auth("sign-in/email", { email, password }); await installSession(context); },
    async dispose() { try { if (cookie) await auth("sign-out", {}); } finally { cookie = ""; await context.close(); } },
  };
}

/** A member is admitted only by the normal authorized invite and acceptance.
 * No synthetic headers, direct memberships, or first-admin claim are used. */
export async function enrollAuthenticatedPerson(api: RunnerApi, companyId: string, person: Awaited<ReturnType<typeof createAuthenticatedPerson>>, secrets: string[], role: "operator" | "viewer" = "operator") {
  const invite = await api.postSensitive<{ id: string; token: string }>(`/api/companies/${companyId}/invites`, { allowedJoinTypes: "human", humanRole: role });
  secrets.push(invite.token);
  await requireSafeInvitationEnrollment(api, companyId, invite.id, role, () => person.dispose());
  const response = await person.request(`/api/invites/${encodeURIComponent(invite.token)}/accept`, "POST", { requestType: "human" });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Public join request returned HTTP ${response.status}; details withheld`); }
  await response.body?.cancel();
  const requests = await api.get<Array<{ id: string; requestingUserId: string; status: string; inviteId: string }>>(`/api/companies/${companyId}/join-requests`);
  const pending = requests.filter(row => row.requestingUserId === person.id && row.inviteId === invite.id);
  if (pending.length !== 1 || !["pending_approval", "approved"].includes(pending[0]!.status)) throw new Error("Public invitation did not create one eligible scoped join request");
  // Human invitation acceptance normally auto-approves through the production
  // invited role. Retain support for a deployment's explicit approval gate.
  if (pending[0]!.status === "pending_approval") await api.post(`/api/companies/${companyId}/join-requests/${pending[0]!.id}/approve`);
  const companiesResponse = await person.request("/api/companies");
  if (!companiesResponse.ok || !(await companiesResponse.json() as Array<{ id: string }>).some(row => row.id === companyId)) throw new Error("Approved person cannot read the intended company");
  return { userId: person.id, companyId, inviteId: invite.id, joinRequestId: pending[0]!.id };
}

export const prerequisiteMembershipScenarioIds = Object.freeze([
  "activity.agent-feedback", "activity.work-timeline", "agents.choose-primary",
  "assistant-connections.consent-read-only", "connection-setup.wrong-person-resolves",
  "documents-artifacts.private-download", "documents-artifacts.restore-document",
  "inbox-search.archive-done", "inbox-search.notification-audience", "inbox-search.restore-archive", "inbox-search.show-decisions",
  "navigation-preferences.broken-link", "navigation-preferences.dismiss-announcement", "navigation-preferences.edit-profile", "navigation-preferences.quick-search", "navigation-preferences.sidebar-order",
  "projects.private-project", "projects.share-project", "questions-and-approvals.wrong-reviewer", "secrets.personal-secret",
  "tasks.completion-with-gate", "tasks.private-task", "tasks.share-private-task",
]);
export async function enrollPrerequisitePerson(ctx: ChatCatalogContext, person: Awaited<ReturnType<typeof createAuthenticatedPerson>>, role: "operator" | "viewer" = "operator") {
  if (!prerequisiteMembershipScenarioIds.includes(ctx.scenario.id) || ctx.input.execution.id !== `chat-features.runner-opencode.local.${ctx.scenario.id}` || !["operator", "viewer"].includes(role))
    throw new Error("Public prerequisite membership is not admitted for this scenario or role");
  const deadline = ctx.observationDeadlineAt;
  const remaining = () => { const now = Date.now(); if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original prerequisite observation budget exhausted or missing"); return Math.min(15000, deadline! - now); };
  const { api, fixtures } = ctx.input, companyId = fixtures.company.id;
  const read = async <T>(route: string) => { const value = await api.get<T>(route, { timeout: remaining() }); remaining(); return value; };
  const personal = async (route: string) => { remaining(); const response = await person.request(route); remaining(); return response; };
  const health = await read<{ deploymentMode: string }>("/api/health");
  if (health.deploymentMode !== "authenticated") throw new Error("Public membership requires real authenticated sessions");
  const session = await read<{ user: { id: string } }>("/api/auth/get-session");
  if (!session.user?.id || session.user.id === person.id || session.user.id === "local-board") throw new Error("Distinct real first-admin authority is required");
  const admin = await read<UserCompanyAccessResponse>(`/api/admin/users/${session.user.id}/company-access`);
  if (admin.user?.id !== session.user.id || admin.user.isInstanceAdmin !== true) throw new Error("Authenticated fixture administrator authority was not verified");
  const targetBefore = await read<UserCompanyAccessResponse>(`/api/admin/users/${person.id}/company-access`);
  if (targetBefore.user?.id !== person.id || targetBefore.user.isInstanceAdmin !== false || targetBefore.companyAccess.length !== 0) throw new Error("Prerequisite person must be a fresh non-admin user");
  const own = await personal("/api/auth/get-session");
  if (own.status !== 200) { await own.body?.cancel(); throw new Error("Prerequisite person's real session unavailable"); }
  if (((await own.json()) as { user?: { id?: string } }).user?.id !== person.id) throw new Error("Prerequisite session belongs to another person");
  const before = await personal(`/api/companies/${companyId}`), beforeStatus = before.status; await before.body?.cancel();
  if (![403, 404].includes(beforeStatus)) throw new Error("Fresh person already has company access or denial proof failed");
  remaining(); const assigned = await api.putSensitive<UserCompanyAccessResponse>(`/api/admin/users/${person.id}/company-access`, { companyIds: [companyId] }); remaining();
  const membership = assigned.companyAccess.find(row => row.companyId === companyId);
  if (assigned.user?.id !== person.id || assigned.user.isInstanceAdmin !== false || assigned.companyAccess.length !== 1 || membership?.principalId !== person.id || membership.principalType !== "user" || membership.status !== "active" || membership.membershipRole !== "operator") throw new Error("Public company access response did not establish the exact prerequisite member");
  const grants = grantsForHumanRole(role);
  remaining(); await api.patchSensitive<CompanyMemberRecord>(`/api/companies/${companyId}/members/${membership.id}/role-and-grants`, { membershipRole: role, status: "active", grants }); remaining();
  const members = await read<CompanyMembersResponse>(`/api/companies/${companyId}/members`), actual = members.members.find(row => row.id === membership.id);
  const keys = (rows: Array<{ permissionKey: string; scope?: Record<string, unknown> | null }>) => rows.map(row => `${row.permissionKey}:${JSON.stringify(row.scope ?? null)}`).sort().join("\n");
  if (!actual || actual.companyId !== companyId || actual.principalId !== person.id || actual.principalType !== "user" || actual.membershipRole !== role || actual.status !== "active" || keys(actual.grants) !== keys(grants) || actual.grants.some(row => row.companyId !== companyId || row.principalId !== person.id || row.principalType !== "user" || row.grantedByUserId !== session.user.id)) throw new Error("Persisted prerequisite role or grants differ from the public requested contract");
  const targetAfter = await read<UserCompanyAccessResponse>(`/api/admin/users/${person.id}/company-access`);
  if (targetAfter.user?.id !== person.id || targetAfter.user.isInstanceAdmin !== false || targetAfter.companyAccess.length !== 1 || targetAfter.companyAccess[0]?.id !== membership.id || targetAfter.companyAccess[0]?.companyId !== companyId || targetAfter.companyAccess[0]?.membershipRole !== role || targetAfter.companyAccess[0]?.status !== "active") throw new Error("Prerequisite membership or non-admin identity changed after role assignment");
  const allowed = await personal(`/api/companies/${companyId}`);
  if (allowed.status !== 200) { await allowed.body?.cancel(); throw new Error("Real prerequisite person cannot read its company"); }
  if (((await allowed.json()) as { id?: string }).id !== companyId) throw new Error("Real prerequisite person read another company");
  const denied = await personal("/api/admin/users"), deniedStatus = denied.status; await denied.body?.cancel();
  if (deniedStatus !== 403) throw new Error("Prerequisite person acquired instance authority or denial proof failed");
  const receipt = { userId: person.id, companyId, membershipId: membership.id, role, grantKeys: grants.map(row => row.permissionKey).sort(), authentication: "real-person-session", administrator: "verified-instance-admin", enrollment: "public-company-access", beforeStatus, companyReadStatus: 200, instanceAdminReadStatus: deniedStatus };
  remaining(); await ctx.input.evidence("identity-public-prerequisite-membership.json", receipt); remaining();
  return receipt;
}
