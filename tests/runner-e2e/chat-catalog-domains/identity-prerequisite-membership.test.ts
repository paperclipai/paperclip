import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { grantsForHumanRole } from "../../../server/src/services/company-member-roles.js";
import { enrollPrerequisitePerson, prerequisiteMembershipScenarioIds } from "./identity-auth.js";
afterEach(() => vi.useRealTimers());
function fixture(role: "viewer" | "operator" = "operator") {
  const membership = { id: "membership", companyId: "company", principalId: "person", principalType: "user", status: "active", membershipRole: "operator" };
  const state = { assigned: false, administrator: true, targetAdministrator: false, preexisting: false, personalId: "person", companyReadId: "company", beforeStatus: 403, adminStatus: 403, readRole: role, extraGrant: false, foreignGrant: false, grantedBy: "admin", slowPut: false };
  const writes: Array<{ route: string; body: unknown }> = [], reads: string[] = [], personalReads: string[] = [];
  const api = {
    get: vi.fn(async (route: string) => {
      reads.push(route);
      if (route === "/api/health") return { deploymentMode: "authenticated" };
      if (route === "/api/auth/get-session") return { user: { id: "admin" } };
      if (route === "/api/admin/users/admin/company-access") return { user: { id: "admin", isInstanceAdmin: state.administrator }, companyAccess: [] };
      if (route === "/api/admin/users/person/company-access") return { user: { id: "person", isInstanceAdmin: state.targetAdministrator }, companyAccess: state.assigned ? [{ ...membership, membershipRole: state.readRole }] : state.preexisting ? [membership] : [] };
      if (route === "/api/companies/company/members") return { members: [{ ...membership, membershipRole: state.readRole, grants: [...grantsForHumanRole(role), ...(state.extraGrant ? [{ permissionKey: "users:manage_permissions", scope: null }] : [])].map(grant => ({ ...grant, companyId: state.foreignGrant ? "foreign" : "company", principalId: "person", principalType: "user", grantedByUserId: state.grantedBy })) }] };
      throw new Error("Unexpected fixture read");
    }),
    putSensitive: vi.fn(async (route: string, body: unknown) => { writes.push({ route, body }); state.assigned = true; if (state.slowPut) vi.setSystemTime(100000); return { user: { id: "person", isInstanceAdmin: state.targetAdministrator }, companyAccess: [membership] }; }),
    patchSensitive: vi.fn(async (route: string, body: unknown) => { writes.push({ route, body }); return membership; }),
  };
  const person = { id: "person", request: vi.fn(async (route: string) => {
    personalReads.push(route);
    if (route === "/api/auth/get-session") return new Response(JSON.stringify({ user: { id: state.personalId } }));
    if (route === "/api/admin/users") return new Response("closed", { status: state.adminStatus });
    if (route === "/api/companies/company") return new Response(JSON.stringify({ id: state.companyReadId }), { status: state.assigned ? 200 : state.beforeStatus });
    throw new Error("Unexpected person request");
  }) } as unknown as Parameters<typeof enrollPrerequisitePerson>[1];
  const evidence = vi.fn();
  const ctx = { scenario: { id: "inbox-search.show-decisions" }, observationDeadlineAt: 100000, input: { execution: { id: "chat-features.runner-opencode.local.inbox-search.show-decisions" }, api, fixtures: { company: { id: "company" } }, evidence } } as unknown as ChatCatalogContext;
  vi.useFakeTimers(); vi.setSystemTime(0);
  return { ctx, person, api, state, writes, reads, personalReads, evidence };
}
it.each(["operator", "viewer"] as const)("establishes only the real public %s prerequisite and proves the person's own scope", async role => {
  const f = fixture(role); const receipt = await enrollPrerequisitePerson(f.ctx, f.person, role);
  expect(f.writes).toEqual([{ route: "/api/admin/users/person/company-access", body: { companyIds: ["company"] } }, { route: "/api/companies/company/members/membership/role-and-grants", body: { membershipRole: role, status: "active", grants: grantsForHumanRole(role) } }]);
  expect(f.personalReads).toEqual(["/api/auth/get-session", "/api/companies/company", "/api/companies/company", "/api/admin/users"]);
  expect(receipt).toMatchObject({ userId: "person", companyId: "company", role, beforeStatus: 403, companyReadStatus: 200, instanceAdminReadStatus: 403 });
  expect(f.evidence).toHaveBeenCalledOnce(); expect([...f.reads, ...f.writes.map(row => row.route)]).not.toEqual(expect.arrayContaining([expect.stringContaining("invites")]));
});
it.each([
  ["activity.agent-feedback", "internal-agent-feedback.ts", "casey"],
  ["activity.work-timeline", "internal-work-timeline.ts", "owner"],
  ["agents.choose-primary", "runtime-primary.ts", "person"],
])("uses scoped public membership for the incidental %s fixture", async (scenarioId, sourceFile, personName) => {
  const f = fixture(); Object.assign(f.ctx.scenario, { id: scenarioId }); f.ctx.input.execution.id = `chat-features.runner-opencode.local.${scenarioId}`;
  const receipt = await enrollPrerequisitePerson(f.ctx, f.person);
  expect(receipt).toMatchObject({ role: "operator", enrollment: "public-company-access", instanceAdminReadStatus: 403 });
  expect(f.writes).toHaveLength(2); expect(f.evidence).toHaveBeenCalledOnce();
  const source = await readFile(new URL(sourceFile, import.meta.url), "utf8");
  expect(source).toContain(`await enrollPrerequisitePerson(ctx, ${personName}, "operator")`);
  expect(source).not.toContain("enrollAuthenticatedPerson");
});
it.each(["access.invite-teammate", "access.manage-membership", "unknown"])("does not substitute public membership for unapproved/invitation journey %s", async scenarioId => {
  const f = fixture(); Object.assign(f.ctx.scenario, { id: scenarioId }); f.ctx.input.execution.id = `chat-features.runner-opencode.local.${scenarioId}`;
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow("not admitted"); expect(f.api.get).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
});
it("requires the exact OpenCode local execution rather than authorizing by scenario name alone", async () => {
  const f = fixture(); f.ctx.input.execution.id = "chat-features.runner-codex.local.inbox-search.show-decisions";
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow("not admitted"); expect(f.writes).toHaveLength(0);
});
it.each(["administrator", "target administrator", "preexisting", "wrong person", "initial access"])("refuses %s before altering access", async invalid => {
  const f = fixture();
  if (invalid === "administrator") f.state.administrator = false;
  if (invalid === "target administrator") f.state.targetAdministrator = true;
  if (invalid === "preexisting") f.state.preexisting = true;
  if (invalid === "wrong person") f.state.personalId = "other";
  if (invalid === "initial access") f.state.beforeStatus = 200;
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow(); expect(f.writes).toHaveLength(0); expect(f.evidence).not.toHaveBeenCalled();
});
it.each(["wrong role", "extra grant", "foreign grant", "wrong author", "instance authority", "wrong company"])("rejects persisted %s or unauthorized own-session proof", async invalid => {
  const f = fixture();
  if (invalid === "wrong role") f.state.readRole = "viewer";
  if (invalid === "extra grant") f.state.extraGrant = true;
  if (invalid === "foreign grant") f.state.foreignGrant = true;
  if (invalid === "wrong author") f.state.grantedBy = "other";
  if (invalid === "instance authority") f.state.adminStatus = 200;
  if (invalid === "wrong company") f.state.companyReadId = "other";
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow(); expect(f.evidence).not.toHaveBeenCalled();
});
it.each([0, -1, Number.NaN, undefined])("will not start setup without a finite positive original clock (%s)", async deadline => {
  const f = fixture(); Object.assign(f.ctx, { observationDeadlineAt: deadline });
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow("budget"); expect(f.api.get).not.toHaveBeenCalled(); expect(f.writes).toHaveLength(0);
});
it("a slow public access write cannot reset the original clock or start role/grant mutation after expiry", async () => {
  const f = fixture(); f.state.slowPut = true;
  await expect(enrollPrerequisitePerson(f.ctx, f.person)).rejects.toThrow("budget"); expect(f.writes).toHaveLength(1); expect(f.api.patchSensitive).not.toHaveBeenCalled(); expect(f.evidence).not.toHaveBeenCalled();
});
it("the closed allowlist contains no access/invitation scenarios", () => {
  expect(prerequisiteMembershipScenarioIds).toHaveLength(23);
  expect(prerequisiteMembershipScenarioIds.some(id => id.startsWith("access."))).toBe(false);
});
