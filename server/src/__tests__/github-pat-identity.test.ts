// Personal access token (PAT) and shared company (organization) GitHub
// identities: PATs serve managed Git and `gh`, the token's account is recorded
// and bound to its secret version, and selection prefers the responsible
// person's own identity, then the agent's dedicated one, then a shared one.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrantMembers,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { recordGitHubTokenAccount } from "../services/github-token-account.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(
    async (_company: string, input: { responsibleUserId: string }) => ({
      value: `test-token-${input.responsibleUserId}`,
    }),
  ),
  resolveSecretValue: vi.fn(async () => "test-dedicated-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)(
  "GitHub personal access token and shared company identities",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
      db: ReturnType<typeof createDb>;
    beforeAll(async () => {
      vi.stubEnv(
        "PAPERCLIP_AGENT_JWT_SECRET",
        "test-github-broker-signing-secret",
      );
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-github-pat-identity-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
      vi.unstubAllEnvs();
    }, 60_000);
    async function seed() {
      const companyId = randomUUID(),
        agentId = randomUUID(),
        runId = randomUUID(),
        issueId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Shared",
        role: "engineer",
        adapterType: "codex_local",
      });
      await db
        .insert(issues)
        .values({ id: issueId, companyId, title: "Identity test" });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId },
      });
      await db.insert(companyMemberships).values(
        ["A", "B"].map((principalId) => ({
          companyId,
          principalType: "user",
          principalId,
          status: "active",
          membershipRole: "member",
        })),
      );
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: "A",
        cause: "instruction",
      });
      return { companyId, agentId, runId, issueId };
    }
    async function grant(
      input: Awaited<ReturnType<typeof seed>>,
      user: string,
      dedicated = false,
      options: { pat?: boolean; recordedAccount?: boolean } = {},
    ) {
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        secretId = randomUUID(),
        definitionId = randomUUID(),
        id = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: input.companyId,
        name: applicationId,
        type: "mcp_http",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: input.companyId,
        applicationId,
        name: connectionId,
        uid: connectionId,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        credentialPolicy: dedicated ? "per_agent" : "per_user",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: input.companyId,
        connectionId,
        targetType: "agent",
        targetId: input.agentId,
      });
      if (!dedicated)
        await db.insert(userSecretDefinitions).values({
          id: definitionId,
          companyId: input.companyId,
          key: definitionId,
          name: "Test GitHub",
        });
      await db.insert(companySecrets).values({
        id: secretId,
        companyId: input.companyId,
        key: secretId,
        name: `Test token ${secretId}`,
        scope: dedicated ? "company" : "user",
        ownerUserId: dedicated ? null : user,
        userSecretDefinitionId: dedicated ? null : definitionId,
      });
      await db.insert(connectionGrants).values({
        id,
        companyId: input.companyId,
        connectionId,
        kind: dedicated ? "agent" : "user",
        subjectUserId: dedicated ? null : user,
        subjectAgentId: dedicated ? input.agentId : null,
        status: "active",
        credentialSecretRefs: [
          {
            secretId,
            configPath: options.pat
              ? "credentials.authorization"
              : "oauth.access_token",
            versionSelector: "latest",
          },
        ],
        // A personal access token has no installations; its account is
        // recorded from `GET /user` (or not yet, for older connections).
        providerTenant: options.pat
          ? options.recordedAccount === false
            ? {}
            : {
                githubAccount: {
                  userId: user,
                  login: user,
                  verifiedAt: new Date().toISOString(),
                  secretId,
                  secretVersion: 1,
                },
              }
          : {
              github: {
                userId: user,
                login: user,
                installationCount: 1,
                repositoryCount: 1,
                repositorySelection: "selected",
                installationIds: ["1"],
                installationOwnerLogins: [user],
              },
            },
      });
      return { id, connectionId, secretId, definitionId };
    }
    /** A shared company GitHub connection (organization grant, company secret). */
    async function sharedGrant(
      input: Awaited<ReturnType<typeof seed>>,
      login: string,
    ) {
      const applicationId = randomUUID(),
        connectionId = randomUUID(),
        secretId = randomUUID(),
        id = randomUUID();
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: input.companyId,
        name: applicationId,
        type: "mcp_http",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: input.companyId,
        applicationId,
        name: connectionId,
        uid: connectionId,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        credentialPolicy: "shared",
        config: { sourceTemplateKey: "github" },
      });
      await db.insert(toolConnectionInstalls).values({
        companyId: input.companyId,
        connectionId,
        targetType: "company",
        targetId: input.companyId,
      });
      await db.insert(companySecrets).values({
        id: secretId,
        companyId: input.companyId,
        key: secretId,
        name: `Shared token ${secretId}`,
        scope: "company",
      });
      await db.insert(connectionGrants).values({
        id,
        companyId: input.companyId,
        connectionId,
        kind: "organization",
        status: "active",
        isDefault: true,
        credentialSecretRefs: [
          {
            secretId,
            configPath: "credentials.authorization",
            versionSelector: "latest",
          },
        ],
        providerTenant: {
          githubAccount: {
            userId: login,
            login,
            verifiedAt: new Date().toISOString(),
            secretId,
            secretVersion: 1,
          },
        },
      });
      return { id, connectionId, secretId };
    }
    it("uses the agent's dedicated identity when the responsible person has no GitHub", async () => {
      const input = await seed();
      await grant(input, "B");
      await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "dedicated",
        login: "robot",
      });
    });
    it("clones and pushes with the responsible person's own personal access token", async () => {
      const input = await seed();
      await grant(input, "A", false, { pat: true });
      const result = await resolveGitHubOperationCredentials(db, input);
      expect(result).toMatchObject({
        status: "available",
        source: "personal",
        login: "A",
        authenticationMode: "managed",
      });
      expect(result.env.GH_TOKEN).toBe("test-token-A");
      expect(result.env.GIT_AUTHOR_EMAIL).toBe("A+A@users.noreply.github.com");
    });
    it("learns an older personal access token's account on first use, and still resolves when GitHub is unreachable", async () => {
      const input = await seed();
      const pat = await grant(input, "A", false, {
        pat: true,
        recordedAccount: false,
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      try {
        fetchSpy.mockRejectedValueOnce(new Error("offline"));
        const offline = await resolveGitHubOperationCredentials(db, input);
        expect(offline).toMatchObject({ status: "available", source: "personal" });
        expect(offline.env.GH_TOKEN).toBe("test-token-A");
        expect(offline.env.GIT_AUTHOR_EMAIL).toBeUndefined();

        fetchSpy.mockImplementationOnce(async (url, init) => {
          expect(String(url)).toBe("https://api.github.com/user");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer test-token-A",
          );
          return Response.json({ id: 4242, login: "octo-a" });
        });
        const online = await resolveGitHubOperationCredentials(db, input);
        expect(online).toMatchObject({ status: "available", login: "octo-a" });
        expect(online.env.GIT_AUTHOR_EMAIL).toBe(
          "4242+octo-a@users.noreply.github.com",
        );
        const [stored] = await db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.id, pat.id));
        expect(stored!.providerTenant?.githubAccount).toMatchObject({
          userId: "4242",
          login: "octo-a",
        });
        expect(JSON.stringify(stored!.providerTenant)).not.toContain("test-token");
      } finally {
        fetchSpy.mockRestore();
      }
    });
    it("de-duplicates two personal access tokens for the same GitHub account", async () => {
      const input = await seed();
      await grant(input, "A", false, { pat: true });
      await grant(input, "A", false, { pat: true });
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "personal",
        login: "A",
      });
    });
    it("falls back to a shared company GitHub only when no person or agent identity exists", async () => {
      const input = await seed();
      await sharedGrant(input, "company-bot");
      const sharedOnly = await resolveGitHubOperationCredentials(db, input);
      expect(sharedOnly).toMatchObject({
        status: "available",
        source: "shared",
        login: "company-bot",
      });
      expect(sharedOnly.env.GH_TOKEN).toBe("test-dedicated-token");

      await grant(input, "robot", true);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        source: "dedicated",
        login: "robot",
      });

      // A person's own GitHub never conflicts with the shared one: it wins.
      await grant(input, "A", false, { pat: true });
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        source: "personal",
        login: "A",
      });
    });
    it("re-reads a token's account after the token is rotated, so an old account never authors commits", async () => {
      const input = await seed();
      const pat = await grant(input, "A", false, { pat: true });
      // Reconnect rotated the secret in place; the recorded account is for v1.
      await db
        .update(companySecrets)
        .set({ latestVersion: 2 })
        .where(eq(companySecrets.id, pat.secretId));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json({ id: 777, login: "rotated-a" }),
      );
      try {
        const result = await resolveGitHubOperationCredentials(db, input);
        expect(result).toMatchObject({ status: "available", login: "rotated-a" });
        expect(result.env.GIT_AUTHOR_EMAIL).toBe(
          "777+rotated-a@users.noreply.github.com",
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [stored] = await db
          .select()
          .from(connectionGrants)
          .where(eq(connectionGrants.id, pat.id));
        expect(stored!.providerTenant?.githubAccount).toMatchObject({
          userId: "777",
          secretId: pat.secretId,
          secretVersion: 2,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });
    it("rejects a stale token-account write that finishes after a rotation", async () => {
      const input = await seed();
      const pat = await grant(input, "A", false, { pat: true });
      await db
        .update(companySecrets)
        .set({ latestVersion: 2 })
        .where(eq(companySecrets.id, pat.secretId));
      const account = (login: string, userId: string) => ({
        userId,
        login,
        verifiedAt: new Date().toISOString(),
      });
      // A new account recorded for the rotated token (version 2)...
      expect(
        await recordGitHubTokenAccount(db, { id: pat.id, companyId: input.companyId },
          account("new-a", "202"), { secretId: pat.secretId, secretVersion: 2 }),
      ).not.toBeNull();
      // ...is not overwritten by an older lookup for version 1 finishing last.
      expect(
        await recordGitHubTokenAccount(db, { id: pat.id, companyId: input.companyId },
          account("old-a", "101"), { secretId: pat.secretId, secretVersion: 1 }),
      ).toBeNull();
      const [stored] = await db
        .select()
        .from(connectionGrants)
        .where(eq(connectionGrants.id, pat.id));
      expect(stored!.providerTenant?.githubAccount).toMatchObject({
        login: "new-a",
        secretVersion: 2,
      });
    });
    it("gives shared company GitHub only to people in its audience", async () => {
      const input = await seed();
      const shared = await sharedGrant(input, "company-bot");
      await db.insert(connectionGrantMembers).values({
        companyId: input.companyId,
        grantId: shared.id,
        subjectType: "user",
        subjectId: "B",
      });
      // The responsible person (A) is not in the audience: no credential.
      const denied = await resolveGitHubOperationCredentials(db, input);
      expect(denied.env).toEqual({});
      expect(denied.status).not.toBe("available");

      await db.insert(connectionGrantMembers).values({
        companyId: input.companyId,
        grantId: shared.id,
        subjectType: "user",
        subjectId: "A",
      });
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "shared",
        login: "company-bot",
      });

      // A run with no responsible person never gets a restricted grant.
      await db
        .update(runIdentityContexts)
        .set({ cause: "company_default" })
        .where(eq(runIdentityContexts.runId, input.runId));
      expect((await resolveGitHubOperationCredentials(db, input)).env).toEqual({});
    });
    it("gives a company-default run the shared company GitHub, never the default person's", async () => {
      const input = await seed();
      await grant(input, "A");
      await sharedGrant(input, "company-bot");
      await db
        .update(runIdentityContexts)
        .set({ cause: "company_default" })
        .where(eq(runIdentityContexts.runId, input.runId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        source: "shared",
        login: "company-bot",
      });
    });
  },
);
