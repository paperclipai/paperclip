import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  authUsers,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatIdentityLinks,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createChatInboundAuthority } from "../services/chat-channels/inbound/authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres chat inbound provider fence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * `lockCurrentPrincipalAuthorization` is the final authorization
 * fence at the task-mutation boundary. Provider-specific resolution (the
 * GitHub chat configuration, Speko voice sessions) returns its own resolved
 * user or sponsor; the fence must evaluate that resolved identity against the
 * endpoint's assigned agent instead of trusting the provider's success result
 * or the endpoint sponsor.
 */
describeEmbeddedPostgres("chat inbound provider authorization fence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const voiceAuthorize = vi.fn();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("chat-inbound-fence-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    voiceAuthorize.mockReset();
    await db.delete(chatGitHubConfigurations);
    await db.delete(chatIdentityLinks);
    await db.delete(chatExternalPrincipals);
    await db.delete(chatEndpoints);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
    tempDb = null;
  });

  function authority() {
    return createChatInboundAuthority(db, {
      voiceStore: { authorizePrincipal: voiceAuthorize },
      runtimeCallbackEndpoint: vi.fn(async () => null),
    });
  }

  /** A protected assigned agent with an endpoint for one provider. */
  async function seedEndpoint(input: {
    provider: "github" | "speko";
    sponsorUserId?: string | null;
    allowUnlinkedPeople?: boolean;
  }) {
    const companyId = randomUUID();
    const assignedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Fence Co ${companyId.slice(0, 8)}`,
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assignedAgentId,
      companyId,
      name: "Maya",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } },
    });
    const [application] = await db.insert(toolApplications).values({
      companyId,
      name: `Fence ${input.provider}`,
      type: "native",
    }).returning();
    const connectionId = randomUUID();
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId: application.id,
      uid: connectionId,
      name: `Fence ${input.provider}`,
      transport: "chat_sdk",
      connectionPurpose: "channel",
    });
    const [endpoint] = await db.insert(chatEndpoints).values({
      companyId,
      connectionId,
      provider: input.provider,
      publicId: `pub-${companyId.slice(0, 12)}`,
      assignedAgentId,
      sponsorUserId: input.sponsorUserId ?? null,
      allowUnlinkedPeople: input.allowUnlinkedPeople ?? false,
      status: "active",
    }).returning();
    return { companyId, assignedAgentId, endpoint };
  }

  async function member(companyId: string, userId: string) {
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: `User ${userId}`,
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    }).onConflictDoNothing();
  }

  async function grantAssignment(companyId: string, userId: string) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "tasks:assign",
      scope: null,
    });
  }

  async function revokeAssignment(companyId: string, userId: string) {
    await db.delete(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalId, userId),
      eq(principalPermissionGrants.permissionKey, "tasks:assign"),
    ));
  }

  async function principalRow(
    companyId: string,
    provider: "github" | "speko",
    externalId: string,
  ) {
    const [row] = await db.insert(chatExternalPrincipals).values({
      companyId,
      provider,
      providerAccountId: "T-FENCE",
      externalId,
      kind: "user",
    }).returning();
    return row;
  }

  it("gates a GitHub-resolved linked user on assignment authority at the final fence", async () => {
    const base = await seedEndpoint({ provider: "github" });
    await member(base.companyId, "endpoint-sponsor");
    await member(base.companyId, "linked-u");
    await db.insert(chatGitHubConfigurations).values({
      endpointId: base.endpoint.id,
      companyId: base.companyId,
      configuration: {
        version: 1,
        toolsEnabled: true,
        responsibleUserId: "endpoint-sponsor",
        memberAccess: "all_linked",
        people: [],
        defaults: defaultGitHubReviewPolicy(),
        repositories: {},
      },
      updatedByUserId: "endpoint-sponsor",
    });
    const principal = await principalRow(base.companyId, "github", "42");
    await db.insert(chatIdentityLinks).values({
      companyId: base.companyId,
      endpointId: base.endpoint.id,
      principalId: principal.id,
      paperclipUserId: "linked-u",
      status: "linked",
      confirmedAt: new Date(),
    });

    // The GitHub resolution succeeds for the linked member, but without an
    // assignment grant the fence must still deny the protected agent.
    const denied = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, principal.id);
    expect(denied).toMatchObject({ allowed: false, linkedDenied: true, userId: null });

    await grantAssignment(base.companyId, "linked-u");
    const allowed = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, principal.id);
    expect(allowed).toMatchObject({ allowed: true, linkedDenied: false, userId: "linked-u" });
  });

  it("evaluates the GitHub guest's configured sponsor, not the endpoint sponsor", async () => {
    const base = await seedEndpoint({ provider: "github", sponsorUserId: "endpoint-sponsor", allowUnlinkedPeople: true });
    await member(base.companyId, "endpoint-sponsor");
    await member(base.companyId, "guest-sponsor");
    await db.insert(chatGitHubConfigurations).values({
      endpointId: base.endpoint.id,
      companyId: base.companyId,
      configuration: {
        version: 1,
        toolsEnabled: true,
        responsibleUserId: "endpoint-sponsor",
        memberAccess: "all_linked",
        people: [
          { githubUserId: "901", login: "guest-901", kind: "guest", sponsorUserId: "guest-sponsor", permissionProfile: "restricted" },
        ],
        defaults: defaultGitHubReviewPolicy(),
        repositories: {},
      },
      updatedByUserId: "endpoint-sponsor",
    });
    const principal = await principalRow(base.companyId, "github", "901");

    // The endpoint sponsor may direct the agent, the guest's own sponsor may
    // not: the guest is denied.
    await grantAssignment(base.companyId, "endpoint-sponsor");
    const denied = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, principal.id);
    expect(denied).toMatchObject({ allowed: false, linkedDenied: true, userId: null });

    // Only the guest's sponsor may direct the agent: the guest is allowed.
    await revokeAssignment(base.companyId, "endpoint-sponsor");
    await grantAssignment(base.companyId, "guest-sponsor");
    const allowed = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, principal.id);
    expect(allowed).toMatchObject({ allowed: true, linkedDenied: false, userId: null, sponsorUserId: "guest-sponsor" });
  });

  it("gates a Speko-resolved caller on assignment authority, including the sponsor fallback", async () => {
    const base = await seedEndpoint({ provider: "speko" });
    await member(base.companyId, "voice-member");
    const caller = await principalRow(base.companyId, "speko", `voice:${randomUUID()}`);

    // The voice store resolves a member caller; the fence still evaluates her.
    voiceAuthorize.mockResolvedValue({ allowed: true, linkedDenied: false, userId: "voice-member" });
    const denied = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, caller.id);
    expect(denied).toMatchObject({ allowed: false, linkedDenied: true, userId: null });
    expect(voiceAuthorize).toHaveBeenCalledTimes(1);

    await grantAssignment(base.companyId, "voice-member");
    const allowed = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, caller.id);
    expect(allowed).toMatchObject({ allowed: true, linkedDenied: false, userId: "voice-member" });

    // A voice guest with no resolved user falls back to the endpoint sponsor.
    const sponsored = await seedEndpoint({ provider: "speko", sponsorUserId: "voice-sponsor" });
    await member(sponsored.companyId, "voice-sponsor");
    const guest = await principalRow(sponsored.companyId, "speko", `voice:${randomUUID()}`);
    voiceAuthorize.mockResolvedValue({ allowed: true, linkedDenied: false, userId: null });
    const guestDenied = await authority().lockCurrentPrincipalAuthorization(db, sponsored.endpoint, guest.id);
    expect(guestDenied).toMatchObject({ allowed: false, linkedDenied: true });
    await grantAssignment(sponsored.companyId, "voice-sponsor");
    const guestAllowed = await authority().lockCurrentPrincipalAuthorization(db, sponsored.endpoint, guest.id);
    expect(guestAllowed).toMatchObject({ allowed: true, userId: null });

    // A voice denial stays a denial; the gate never re-allows it.
    voiceAuthorize.mockResolvedValue({ allowed: false, linkedDenied: true, userId: null });
    const voiceDenied = await authority().lockCurrentPrincipalAuthorization(db, base.endpoint, caller.id);
    expect(voiceDenied).toMatchObject({ allowed: false, linkedDenied: true });

    // An unsponsored voice endpoint without an acting identity stays open by design.
    const unsponsored = await seedEndpoint({ provider: "speko", sponsorUserId: null });
    const unsponsoredCaller = await principalRow(unsponsored.companyId, "speko", `voice:${randomUUID()}`);
    voiceAuthorize.mockResolvedValue({ allowed: true, linkedDenied: false, userId: null });
    const unsponsoredAllowed = await authority().lockCurrentPrincipalAuthorization(db, unsponsored.endpoint, unsponsoredCaller.id);
    expect(unsponsoredAllowed).toMatchObject({ allowed: true, linkedDenied: false, userId: null });
  });
});
