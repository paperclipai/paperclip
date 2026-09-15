import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveAndRetainRunTrustPreset } from "../services/run-trust-preset.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import {
  gateProjectExecutionWorkspacePolicy,
  parseProjectExecutionWorkspacePolicy,
} from "../services/execution-workspace-policy.js";

// Actual dispatch retention and operation-time authorization use real rows.
// Only the downstream credential store is a sentinel: reaching it would export
// a token, whether the selected credential belongs to the sponsor or a bot.
const credentials = vi.hoisted(() => ({
  resolveManagedGitHubCredential: vi.fn(),
  secretService: vi.fn(() => ({})),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: credentials.secretService,
}));
vi.mock("../services/git-credentials.js", () => ({
  resolveManagedGitHubCredential: credentials.resolveManagedGitHubCredential,
  buildGitAuthInvocation: () => ({ env: { GH_TOKEN: "test-export-sentinel" } }),
}));

const support = await getEmbeddedPostgresTestSupport();
it("dispatch retains raw trust before workspace and broker setup", () => {
  const heartbeat = readFileSync(
    new URL("../services/heartbeat.ts", import.meta.url),
    "utf8",
  );
  const start = heartbeat.indexOf(
    "const retainedTrust = await resolveAndRetainRunTrustPreset",
  );
  const end = heartbeat.indexOf(
    "const config = parseObject(agent.adapterConfig);",
    start,
  );
  const dispatch = heartbeat.slice(start, end);
  expect(start).toBeGreaterThan(0);
  expect(dispatch).toContain(
    "executionWorkspacePolicy: projectContext.executionWorkspacePolicy",
  );
  expect(dispatch).toContain(
    "context.executionPolicy = retainedTrust.executionPolicy",
  );
  expect(start).toBeLessThan(
    heartbeat.indexOf("const resolvedExecutionWorkspaceMode =", start),
  );
  expect(start).toBeLessThan(
    heartbeat.indexOf('scope: "github_credentials"', start),
  );
});

(support.supported ? describe : describe.skip)(
  "dispatch trust retention",
  () => {
    let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
    let db: ReturnType<typeof createDb>;

    beforeAll(async () => {
      database = await startEmbeddedPostgresTestDatabase(
        "paperclip-run-trust-",
      );
      db = createDb(database.connectionString);
    }, 30_000);
    afterAll(async () => {
      await database?.cleanup();
    }, 60_000);
    beforeEach(() => {
      vi.clearAllMocks();
      credentials.resolveManagedGitHubCredential.mockResolvedValue({
        configured: true,
        credential: {
          identitySource: "personal",
          githubIdentity: { login: "accepted-author" },
        },
      });
    });

    async function seed() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const projectId = randomUUID();
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: companyId,
        issuePrefix: companyId.slice(0, 8),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Native chat runner",
        role: "engineer",
        adapterType: "paperclip_runner",
      });
      await db
        .insert(projects)
        .values({ id: projectId, companyId, name: "Chat" });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId,
        title: "Chat turn",
        originKind: "chat_channel",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: {
          issueId,
          projectId,
          launchMarker: "preserved",
          executionPolicy: {
            retryPolicy: { maxAttempts: 2 },
            authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
          },
        },
      });
      await initializeRunIdentity(db, {
        companyId,
        runId,
        responsibleUserId: "accepted-author",
        issueId,
        cause: "instruction",
      });
      return { companyId, agentId, projectId, issueId, runId };
    }

    async function launch(input: Awaited<ReturnType<typeof seed>>) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId));
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId));
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, input.issueId));
      // Same helper as heartbeat dispatch: derive effective trust from live rows,
      // and read/retain run policy durably before any credential acquisition.
      return resolveAndRetainRunTrustPreset(db, {
        ...input,
        agent,
        project,
        issue,
      });
    }

    it.each(["agent", "project", "issue"] as const)(
      "retains %s-derived launch restrictions after live policies are removed",
      async (source) => {
        const input = await seed();
        const boundary = {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId: input.companyId,
          rootIssueId: input.issueId,
          allowedAgentIds: [input.agentId],
          allowedToolClasses: ["read"],
        };
        const policy = {
          authorizationPolicy: {
            trustPreset: LOW_TRUST_REVIEW_PRESET,
            trustBoundary: boundary,
          },
        };
        if (source === "agent") {
          await db
            .update(agents)
            .set({ permissions: policy })
            .where(eq(agents.id, input.agentId));
        } else if (source === "project") {
          await db
            .update(projects)
            .set({ executionWorkspacePolicy: policy })
            .where(eq(projects.id, input.projectId));
        } else {
          await db
            .update(issues)
            .set({ executionPolicy: policy })
            .where(eq(issues.id, input.issueId));
        }

        const firstLaunch = await launch(input);
        expect(firstLaunch.trustPreset).toMatchObject({
          kind: "low_trust_review",
          sourcePresets: { [source]: LOW_TRUST_REVIEW_PRESET },
          boundary,
        });
        const [retained] = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, input.runId));
        expect(retained.contextSnapshot).toMatchObject({
          issueId: input.issueId,
          launchMarker: "preserved",
          executionPolicy: {
            retryPolicy: { maxAttempts: 2 },
            trustPreset: LOW_TRUST_REVIEW_PRESET,
            authorizationPolicy: {
              assignmentPolicy: { mode: "protected" },
              trustPreset: LOW_TRUST_REVIEW_PRESET,
              trustBoundary: boundary,
            },
          },
        });

        // No manually seeded low-trust run policy: dispatch produced it above.
        await db
          .update(agents)
          .set({ permissions: {} })
          .where(eq(agents.id, input.agentId));
        await db
          .update(projects)
          .set({ executionWorkspacePolicy: null })
          .where(eq(projects.id, input.projectId));
        await db
          .update(issues)
          .set({ executionPolicy: null })
          .where(eq(issues.id, input.issueId));
        for (const identitySource of ["personal", "dedicated"]) {
          credentials.resolveManagedGitHubCredential.mockResolvedValue({
            configured: true,
            credential: {
              identitySource,
              githubIdentity: { login: "accepted-author" },
            },
          });
          expect(
            await resolveGitHubOperationCredentials(db, input),
          ).toMatchObject({
            status: "unavailable",
            env: {},
          });
        }
        expect(credentials.secretService).not.toHaveBeenCalled();
        expect(
          credentials.resolveManagedGitHubCredential,
        ).not.toHaveBeenCalled();

        const resumed = await launch(input);
        expect(resumed.trustPreset).toMatchObject({
          kind: "low_trust_review",
          sourcePresets: { run: LOW_TRUST_REVIEW_PRESET },
          boundary,
        });
        expect(resumed.executionPolicy).toEqual(firstLaunch.executionPolicy);
        expect(
          await resolveGitHubOperationCredentials(db, input),
        ).toMatchObject({ status: "unavailable", env: {} });
        expect(
          credentials.resolveManagedGitHubCredential,
        ).not.toHaveBeenCalled();
      },
    );

    it("preserves a standard run's policy and accepted author credential resolution", async () => {
      const input = await seed();
      const [before] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, input.runId));
      expect((await launch(input)).trustPreset.kind).toBe("standard");
      const [after] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, input.runId));
      expect(after.contextSnapshot).toEqual(before.contextSnapshot);
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "available",
        login: "accepted-author",
        env: { GH_TOKEN: "test-export-sentinel" },
      });
      expect(credentials.resolveManagedGitHubCredential).toHaveBeenCalledWith(
        db,
        {},
        input.companyId,
        expect.objectContaining({
          responsibleUserId: "accepted-author",
          allowStandingDelegation: false,
        }),
      );
    });

    it("retains a raw top-level project preset even when isolated workspaces are disabled", async () => {
      const input = await seed();
      const policy = {
        enabled: false,
        trustPreset: LOW_TRUST_REVIEW_PRESET,
        authorizationPolicy: {
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId: input.companyId,
            projectIds: [input.projectId],
          },
        },
      };
      await db
        .update(projects)
        .set({ executionWorkspacePolicy: policy })
        .where(eq(projects.id, input.projectId));
      expect(
        gateProjectExecutionWorkspacePolicy(
          parseProjectExecutionWorkspacePolicy(policy),
          false,
        ),
      ).toBeNull();
      expect((await launch(input)).trustPreset).toMatchObject({
        kind: "low_trust_review",
        sourcePresets: { project: LOW_TRUST_REVIEW_PRESET },
        boundary: { projectIds: [input.projectId] },
      });
      await db
        .update(projects)
        .set({ executionWorkspacePolicy: null })
        .where(eq(projects.id, input.projectId));
      expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({
        status: "unavailable",
        env: {},
      });
      expect(credentials.resolveManagedGitHubCredential).not.toHaveBeenCalled();
    });

    it("fails closed for a wrong company, wrong agent, missing run, or inactive execution", async () => {
      const input = await seed();
      for (const overrides of [
        { companyId: randomUUID() },
        { agentId: randomUUID() },
        { runId: randomUUID() },
      ]) {
        await expect(
          resolveAndRetainRunTrustPreset(db, { ...input, ...overrides }),
        ).rejects.toThrow("inactive execution");
      }
      await db
        .update(heartbeatRuns)
        .set({ status: "succeeded" })
        .where(eq(heartbeatRuns.id, input.runId));
      await expect(launch(input)).rejects.toThrow("inactive execution");
      expect(credentials.resolveManagedGitHubCredential).not.toHaveBeenCalled();
    });
  },
);
