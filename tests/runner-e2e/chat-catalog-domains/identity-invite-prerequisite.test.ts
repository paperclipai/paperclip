import { describe, expect, it, vi } from "vitest";
import type { RunnerApi } from "../api.js";
import { enrollAuthenticatedPerson, type createAuthenticatedPerson } from "./identity-auth.js";
import { bindInvitationEnrollmentPrerequisite, invitationIncident, invitationRuntimeDisposition, type InvitationRuntimeProof } from "./identity-invite-prerequisite.js";
const companyId = "11111111-1111-4111-8111-111111111111", inviteId = "22222222-2222-4222-8222-222222222222";
const proof: InvitationRuntimeProof = { apiOrigin: "http://127.0.0.1:3100", processStartedAt: "2026-10-27T11:00:00Z", healthCommit: "6".repeat(40),
  redactorSha256: invitationIncident.affectedRedactorSha256, serverEntrySha256: "a".repeat(64), supervisorReceiptSha256: "b".repeat(64), priorProofSha256: invitationIncident.priorProofSha256 };
const health = { deploymentMode: "authenticated", commit: proof.healthCommit, serverInfo: { processStartedAt: proof.processStartedAt } };
function fixture(override?: Partial<InvitationRuntimeProof>, bind = true) {
  const calls: string[] = []; const evidence = vi.fn();
  const api = { baseURL: proof.apiOrigin,
    postSensitive: vi.fn(async (url: string) => { calls.push(url); return url.endsWith("/revoke") ? {} : { id: inviteId, token: "synthetic-private-invite-canary" }; }),
    get: vi.fn(async (url: string) => { calls.push(url);
      if (url === "/api/health") return health;
      if (url.includes("/join-requests")) return [{ id: "join", requestingUserId: "person", inviteId, status: "approved" }];
      return { invites: [{ id: inviteId, companyId, humanRole: "operator", allowedJoinTypes: "human", state: url.includes("state=revoked") ? "revoked" : "active" }] };
    }),
  } as unknown as RunnerApi;
  const request = vi.fn(async (url: string) => new Response(JSON.stringify(url === "/api/companies" ? [{ id: companyId }] : {})));
  const person = { id: "person", request, dispose: vi.fn(async () => {}) } as unknown as Awaited<ReturnType<typeof createAuthenticatedPerson>>;
  if (bind) bindInvitationEnrollmentPrerequisite(api, { verifyRuntime: async () => ({ ...proof, ...override }), evidence });
  return { api, person, request, evidence, calls, secrets: [] as string[] };
}
describe("invitation enrollment prerequisite quarantine", () => {
  it("proves an actual issued/read/revoked public prerequisite and stops before affected acceptance", async () => {
    const f = fixture(); await expect(enrollAuthenticatedPerson(f.api, companyId, f.person, f.secrets)).rejects.toMatchObject({ receipt: {
      disposition: "blocked-core-prerequisite", inviteReadback: true, inviteRevoked: true, acceptanceCalled: false, nativeDispatchFromPrerequisite: false } });
    expect(f.request).not.toHaveBeenCalled(); expect(f.calls.some(url => url.includes("synthetic-private-invite-canary"))).toBe(false);
    expect(f.secrets).toEqual(["synthetic-private-invite-canary"]); expect(JSON.stringify(f.evidence.mock.calls)).not.toContain(f.secrets[0]);
    expect(f.calls).toContain(`/api/invites/${inviteId}/revoke`);
  });
  it("keeps the full public enrollment flow available only with qualified fixed runtime proof", async () => {
    const f = fixture({ redactorSha256: invitationIncident.fixedRedactorSha256 });
    await expect(enrollAuthenticatedPerson(f.api, companyId, f.person, f.secrets)).resolves.toMatchObject({ inviteId, companyId });
    expect(f.request.mock.calls[0]?.[0]).toContain("/accept"); expect(f.evidence).not.toHaveBeenCalled();
  });
  it.each([undefined, { processStartedAt: "2026-10-27T10:00:00Z" }, { healthCommit: "7".repeat(40) },
    { redactorSha256: "c".repeat(64) }, { priorProofSha256: "d".repeat(64) }, { serverEntrySha256: "not-a-hash" }])("fails closed for missing, foreign or unverified runtime proof %j", async change => {
    const f = fixture(change, change !== undefined);
    await expect(enrollAuthenticatedPerson(f.api, companyId, f.person, f.secrets)).rejects.toMatchObject({ receipt: { disposition: "blocked-runtime-identity", inviteRevoked: true } });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("does not treat a null public commit alone as product identity", () => {
    expect(invitationRuntimeDisposition(undefined, proof.apiOrigin, { ...health, commit: null })).toBe("unknown");
    expect(invitationRuntimeDisposition({ ...proof, healthCommit: null }, proof.apiOrigin, { ...health, commit: null })).toBe("affected");
  });
  it("never accepts when readback is missing and still revokes its owned invite", async () => {
    const f = fixture(); f.api.get = vi.fn(async (url: string) => url === "/api/health" ? health : { invites: [] }) as RunnerApi["get"];
    await expect(enrollAuthenticatedPerson(f.api, companyId, f.person, f.secrets)).rejects.toThrow("probe incomplete");
    expect(f.calls).toContain(`/api/invites/${inviteId}/revoke`); expect(f.request).not.toHaveBeenCalled();
  });
});
