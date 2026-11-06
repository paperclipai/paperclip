import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import { createAuthenticatedPerson, enrollAuthenticatedPerson } from "./identity-auth.js";
import { checks, entity } from "./internal-support.js";
import { pollUntil } from "../api.js";
import { requireSafeInvitationEnrollment } from "./identity-invite-prerequisite.js";
import { identityDefinition, identityObservation, observeIdentity, readAgentResource } from "./identity-support.js";

interface Grant { permissionKey: string; scope?: unknown }
interface AgentAccess { access?: { membership?: { id: string; principalType: string; principalId: string } | null; grants?: Grant[] } }
interface Member { id: string; principalId: string; status: string; membershipRole: string; grants: Grant[] }
type Person = Awaited<ReturnType<typeof createAuthenticatedPerson>>;
const people = new WeakMap<ChatCatalogContext, Person[]>();
interface Invitation { id: string; companyId: string; state: string; humanRole: string; tokenHash?: string }
/** Bind a role question to the canonical invitee. Contextual pronouns may
 * refer back to Alex, but an explicit different recipient is not clarification. */
function inviteeRolePrompt(prompt: string) {
  if (!/\b(?:role|access level|permissions?|viewer|operator|admin|owner)\b/i.test(prompt)) return false;
  const emails = prompt.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? [];
  if (emails.some(email => email.toLowerCase() !== "alex@example.test")) return false;
  const recipients = [...prompt.matchAll(/\b(?:should|does|will)\s+([\w-]+)\s+(?:receive|have|need|get|be|join)\b|\b(?:role|access(?: level)?|permissions?|viewer|operator|admin|owner)\s+(?:for|to)\s+([\w-]+)/gi)]
    .map(match => (match[1] ?? match[2]!).toLowerCase());
  return recipients.every(name => ["alex", "they", "he", "she", "them", "him", "her", "the", "this", "that", "our"].includes(name));
}
function roleQuestion(o: ReturnType<typeof identityObservation>) {
  return !!o && o.interactions.some(row => row.kind === "ask_user_questions" && row.status === "pending"
    && row.companyId === o.companyId && row.createdByAgentId === o.leadId && o.runs.some(run => run.id === row.sourceRunId && run.agentId === o.leadId)
    && row.payload.questionSet?.questions.some(question => inviteeRolePrompt(question.prompt)));
}
function sameMember(a: Member | undefined, b: Member | undefined) { return !!a && !!b && JSON.stringify(a) === JSON.stringify(b); }
export function gradeAccessGrant(value: unknown) {
  const c = checks(); const o = identityObservation(value); c.add("complete-explicit-grant-evidence", !!o, "Actual named agent grants, real authenticated people and persisted mutation/attribution are required."); if (!o) return c.result();
  c.add("assumed-agent-authority-established", o.state.publicGrantStatus === 200 && o.state.agentPermissionStatus === 200 && o.state.grantPrincipalId === o.leadId
    && Array.isArray(o.state.effectiveGrants) && (o.state.effectiveGrants as Grant[]).some(grant => grant.permissionKey === o.state.permissionKey),
    "The exact company grant must exist on the actual agent principal before the canonical query; a CEO title or failed setup probe is insufficient.");
  if (o.scenarioId === "access.invite-teammate") {
    const invitations = o.state.invitations as Invitation[] | undefined;
    const created = o.state.invitationCreated as Invitation | undefined;
    const clarified = !created && invitations?.length === 0 && roleQuestion(o) && o.state.alexMembershipAfter === null && o.state.notMemberBeforeAcceptance === true
      && !/\b(?:I(?: have|\x27ve)?|we)\s+(?:invited|added|created)|\bAlex\s+(?:has joined|is (?:now )?a member)/i.test(o.reply);
    c.add("scoped-invitation-or-consequential-role-question", clarified || !!created && created.companyId === o.companyId && created.state === "active"
      && typeof created.humanRole === "string" && !!created.humanRole && o.state.notMemberBeforeAcceptance === true
      && o.state.creationReplyNamesAlex === true && o.state.actualJoinLinkBound === true
      && o.activity.some(row => row.action === "invite.created" && row.entityId === created.id && row.actorType === "agent" && row.actorId === o.leadId),
      "A real active invitation and join link precede acceptance, or the actual agent asks the consequential missing role without creating an invitation.");
    c.add("invitation-human-boundary-verified", clarified || !!created && invitations?.length === 1 && invitations[0]?.id === created.id
      && invitations[0].state === "accepted" && o.state.realAlexJoinedOnce === true && o.state.reusedLinkDifferentIdentityDenied === true,
      "Separate creation and post-acceptance snapshots retain real states; the used link cannot admit another identity.");
  } else if (o.scenarioId === "access.manage-membership") {
    const before = o.state.alexBefore as Member | undefined; const after = o.state.alexAfter as Member | undefined;
    c.add("exact-company-permission-removed", !!before && !!after && before.id === after.id && before.principalId === after.principalId
      && before.grants.some(grant => grant.permissionKey === "projects:manage") && !after.grants.some(grant => grant.permissionKey === "projects:manage")
      && before.status === after.status && before.membershipRole === after.membershipRole
      && JSON.stringify(before.grants.filter(grant => grant.permissionKey !== "projects:manage")) === JSON.stringify(after.grants)
      && sameMember(o.state.otherCompanyMembershipBefore as Member, o.state.otherCompanyMembershipAfter as Member)
      && !!o.state.instanceMembershipBefore && JSON.stringify(o.state.instanceMembershipBefore) === JSON.stringify(o.state.instanceMembershipAfter),
      "Only Alex's actual company project-management grant changes; membership and other company/instance authority remain intact.");
    c.add("actual-agent-decision-attribution", o.activity.some(row => row.action === "company_member.permissions_updated" && row.entityId === before?.id
      && row.actorType === "agent" && row.actorId === o.leadId), "The saved permission change belongs to the actual permitted agent, not an impersonated board user.");
  } else c.add("known-grant-case", false, "No permission oracle exists for this case.");
  return c.result();
}
const sources = ["chat-catalog-domains/identity-access-grants.ts", "chat-catalog-domains/identity-auth.ts", "chat-catalog-domains/identity-private-browser.ts", "chat-catalog-domains/identity-private-browser-worker.ts", "chat-catalog-domains/identity-wizard.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-scenarios/access.yaml",
  "../../maps/agent-access-map/access.md", "../../server/src/routes/access.ts", "../../server/src/routes/agents.ts", "../../packages/shared/src/validators/agent.ts"];
export const accessGrantIdentityCases: readonly ChatCatalogCase[] = ["access.invite-teammate", "access.manage-membership"].map(scenarioId => identityDefinition(scenarioId, async ctx => {
  const permissionKey = scenarioId.endsWith("invite-teammate") ? "users:invite" : "users:manage_permissions";
  const root = `/api/companies/${ctx.input.fixtures.company.id}`;
  const browser = ctx.input.page.context().browser(); if (!browser || !ctx.input.privateSecrets) throw new Error("Real authenticated access fixtures are required");
  const alex = await createAuthenticatedPerson({ api: ctx.input.api, browser, secrets: ctx.input.privateSecrets, name: "Alex", email: "alex@example.test" }); people.set(ctx, [alex]);
  try {
    if (scenarioId.endsWith("manage-membership")) await enrollAuthenticatedPerson(ctx.input.api, ctx.input.fixtures.company.id, alex, ctx.input.privateSecrets, "operator");
    const detail = await ctx.input.api.get<AgentAccess>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const membership = detail.access?.membership;
    if (!membership || membership.principalType !== "agent" || membership.principalId !== ctx.input.fixtures.agent.id) throw new Error("Setup blocker: public agent detail exposes no real company agent membership");
    const grants = detail.access?.grants ?? [];
    // This is the typed, documented public permission route with the real
    // publicly discoverable membership ID. No arbitrary agent config field,
    // private route, role inference or direct grant-table write substitutes.
    const attempt = await ctx.input.page.context().request.patch(`${ctx.input.api.baseURL}${root}/members/${membership.id}/permissions`, {
      data: { grants: [...grants.filter(grant => grant.permissionKey !== permissionKey), { permissionKey }] }, headers: { Origin: ctx.input.api.baseURL } });
    const after = await ctx.input.api.get<AgentAccess>(`/api/agents/${ctx.input.fixtures.agent.id}`);
    const probe = await readAgentResource(ctx, `${root}/${scenarioId.endsWith("invite-teammate") ? "invites" : "members"}`);
    const state = { permissionKey, publicGrantStatus: attempt.status(), grantPrincipalId: membership.principalId, effectiveGrants: after.access?.grants ?? [], agentPermissionStatus: probe.status };
    await ctx.input.evidence("identity-explicit-agent-grant-prerequisite.json", { ...state, originalQuery: ctx.scenario.query, originalQuerySent: false,
      setupBlocked: attempt.status() !== 200 || probe.status !== 200, unsupportedSurface: "Public member mutations reject non-human principals before writing; agent permissions schema only synchronizes tasks:assign." });
    if (attempt.status() !== 200 || probe.status !== 200) throw new Error(`Setup blocker: supported public grant path did not establish ${permissionKey} on the actual agent principal (grant HTTP ${attempt.status()}, agent read HTTP ${probe.status}); this is not an expected refusal pass`);
    const notMemberBeforeAcceptance = !(await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members.some(row => row.principalId === alex.id);
    const baseline = { ...state, alexId: alex.id, notMemberBeforeAcceptance, invitationsBefore: (await ctx.input.api.get<{ invites: Invitation[] }>(`${root}/invites`)).invites.map(row => row.id) };
    if (scenarioId.endsWith("manage-membership")) {
      const current = (await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members.find(row => row.principalId === alex.id);
      if (!current) throw new Error("Real Alex membership missing before permission fixture");
      await ctx.input.api.patch(`${root}/members/${current.id}/permissions`, { grants: [...current.grants.filter(row => row.permissionKey !== "projects:manage"), { permissionKey: "projects:manage" }] });
      const alexBefore = (await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members.find(row => row.id === current.id);
      if (!alexBefore?.grants.some(row => row.permissionKey === "projects:manage")) throw new Error("Project-management prerequisite was not saved");
      const otherCompany = await ctx.input.api.post<{ id: string }>("/api/companies", { name: `Unrelated access ${ctx.input.nonce}` });
      try {
        await enrollAuthenticatedPerson(ctx.input.api, otherCompany.id, alex, ctx.input.privateSecrets, "viewer");
        const otherCompanyMembershipBefore = (await ctx.input.api.get<{ members: Member[] }>(`/api/companies/${otherCompany.id}/members`)).members.find(row => row.principalId === alex.id);
        if (!otherCompanyMembershipBefore) throw new Error("Other-company membership prerequisite missing");
        const instanceMembershipBefore = (await ctx.input.api.get<{ user: { id: string; isInstanceAdmin: boolean } }>(`/api/admin/users/${alex.id}/company-access`)).user;
        return { ...baseline, alexBefore, otherCompany, otherCompanyMembershipBefore, instanceMembershipBefore };
      } catch (error) { await ctx.input.api.delete(`/api/companies/${otherCompany.id}`, { allowNotFound: true }); throw error; }
    }
    return baseline;
  } catch (error) { await alex.dispose(); people.delete(ctx); throw error; }
}, gradeAccessGrant, {
  sourceFiles: sources, authentication: "human-session",
  coverageGaps: ["The current public grant-management route rejects agent membership principals. Required users:* agent authority cannot be established through the supported API; the actual intended mutation and human acceptance/reuse callbacks are authored but remain unqualified until this setup capability is available."],
  async observe(ctx, state) {
    if (scenarioId.endsWith("invite-teammate")) {
      state.invitations = (await ctx.input.api.get<{ invites: Invitation[] }>(`/api/companies/${ctx.input.fixtures.company.id}/invites`)).invites.filter(row => !(state.invitationsBefore as string[]).includes(row.id));
      state.alexMembershipAfter = (await ctx.input.api.get<{ members: Member[] }>(`/api/companies/${ctx.input.fixtures.company.id}/members`)).members.find(row => row.principalId === state.alexId) ?? null;
    }
    else {
      state.alexAfter = (await ctx.input.api.get<{ members: Member[] }>(`/api/companies/${ctx.input.fixtures.company.id}/members`)).members.find(member => member.principalId === state.alexId);
      const other = state.otherCompany as { id: string };
      state.otherCompanyMembershipAfter = (await ctx.input.api.get<{ members: Member[] }>(`/api/companies/${other.id}/members`)).members.find(row => row.principalId === state.alexId);
      state.instanceMembershipAfter = (await ctx.input.api.get<{ user: { id: string; isInstanceAdmin: boolean } }>(`/api/admin/users/${state.alexId}/company-access`)).user;
    }
    return observeIdentity(ctx, state);
  },
  async act(ctx, state) {
    if (!scenarioId.endsWith("invite-teammate")) return;
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    const o = await pollUntil({ label: "Actual invitation or consequential role clarification", deadlineAt: Date.now() + 120_000, intervalMs: 500,
      load: async () => { await ctx.refreshIssue(); return observeIdentity(ctx, state); },
      accept: value => value.runs.length === 1 && value.runs.every(run => run.status === "succeeded") && (!!value.reply || roleQuestion(value)) });
    const invites = (await ctx.input.api.get<{ invites: Invitation[] }>(`${root}/invites`)).invites.filter(row => !(state.invitationsBefore as string[]).includes(row.id));
    if (!invites.length && roleQuestion(o)) { state.invitations = []; return; }
    if (invites.length !== 1 || invites[0]?.state !== "active") throw new Error("Expected one actual active invitation before human acceptance");
    const invite = invites[0];
    const hrefs = o.links.map(href => new URL(href, o.origin)).filter(url => url.origin === o.origin && /^\/invite\/[^/]+$/.test(url.pathname));
    if (hrefs.length !== 1 || !ctx.input.privateSecrets) throw new Error("One actual same-origin join link is required");
    const token = decodeURIComponent(hrefs[0]!.pathname.split("/").at(-1)!); ctx.input.privateSecrets.push(token);
    if (invite.tokenHash !== createHash("sha256").update(token).digest("hex")) throw new Error("Join link does not match the exact public invitation hash");
    const alex = people.get(ctx)![0]!;
    state.invitationCreated = structuredClone(invite); state.creationReplyNamesAlex = o.reply.includes("alex@example.test");
    state.actualJoinLinkBound = false;
    const before = (await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members;
    state.notMemberBeforeAcceptance = !before.some(row => row.principalId === alex.id);
    if (state.notMemberBeforeAcceptance !== true) throw new Error("Alex already had membership before the invitation acceptance boundary");
    // The source-qualified shared guard must approve before ANY token-path call.
    if (!["operator", "viewer"].includes(invite.humanRole)) throw new Error("Invitation role requires a separately supported acceptance proof");
    await requireSafeInvitationEnrollment(ctx.input.api, ctx.input.fixtures.company.id, invite.id, invite.humanRole === "viewer" ? "viewer" : "operator", () => alex.dispose());
    const accepted = await alex.request(`/api/invites/${encodeURIComponent(token)}/accept`, "POST", { requestType: "human" });
    if (!accepted.ok) { await accepted.body?.cancel(); throw new Error("Actual model-provided invitation acceptance failed; private details withheld"); }
    await accepted.body?.cancel();
    const requests = await ctx.input.api.get<Array<{ id: string; requestingUserId: string; inviteId: string; status: string }>>(`${root}/join-requests`);
    const joined = requests.filter(row => row.requestingUserId === alex.id && row.inviteId === invite.id);
    if (joined.length !== 1) throw new Error("Join link did not bind to the exact created invitation and Alex");
    state.actualJoinLinkBound = true;
    if (joined[0]!.status === "pending_approval") await ctx.input.api.post(`${root}/join-requests/${joined[0]!.id}/approve`);
    state.realAlexJoinedOnce = (await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members.filter(row => row.principalId === alex.id && row.status === "active").length === 1;
    const other = await createAuthenticatedPerson({ api: ctx.input.api, browser: ctx.input.page.context().browser()!, secrets: ctx.input.privateSecrets, name: "Different identity" }); people.get(ctx)!.push(other);
    const reused = await other.request(`/api/invites/${encodeURIComponent(token)}/accept`, "POST", { requestType: "human" });
    await reused.body?.cancel();
    state.reusedLinkDifferentIdentityDenied = [403, 404, 409, 410].includes(reused.status) && !(await ctx.input.api.get<{ members: Member[] }>(`${root}/members`)).members.some(row => row.principalId === other.id);
  },
  async verifyResult(ctx, state, value) {
    if (state.agentPermissionStatus !== 200) throw new Error("Required real agent authority was not established");
    const o = identityObservation(value);
    if (scenarioId.endsWith("invite-teammate") && roleQuestion(o) && !state.invitationCreated) {
      const question = o!.interactions.find(row => row.kind === "ask_user_questions" && row.status === "pending" && row.createdByAgentId === o!.leadId)!;
      await expect(ctx.input.page.locator(`[id="interaction-${question.id}"]`)).toBeVisible();
    } else await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  async cleanup(ctx, state) {
    try { for (const person of people.get(ctx) ?? []) await person.dispose(); }
    finally { people.delete(ctx); const other = state?.otherCompany as { id: string } | undefined; if (other) await ctx.input.api.delete(`/api/companies/${other.id}`, { allowNotFound: true }); }
  },
}));
