import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi, type Mock } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issueAccessGrants, issues } from "@paperclipai/db";
import { executionWorkspaceRepositoryService } from "../../services/execution-workspace-repositories.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export function createRepositoryTrustFixture(acquisition: { managedAuth: Mock; materialize: Mock; catalog: Mock }) {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  async function setup() {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    database = await startEmbeddedPostgresTestDatabase("paperclip-repository-trust-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "paperclip-repository-trust-"));
    return { db, root };
  }
  async function cleanup() {
    vi.unstubAllEnvs();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  }

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const userId = randomUUID(), cwd = path.join(root, issueId);
    await mkdir(cwd);
    await db.insert(companies).values({ id: companyId, name: "Repository trust", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat worker", adapterType: "process", status: "idle" });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, name: "Task files", cwd,
      mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Unlinked chat work", assigneeAgentId: agentId,
      executionWorkspaceId: workspace.id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId,
      contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    acquisition.catalog.mockResolvedValue({ repositories: [{ id: "private-repo", fullName: "sponsor/private", private: true,
      url: "https://github.com/sponsor/private", connections: ["sponsor-github"] }] });
    acquisition.managedAuth.mockRejectedValue(new Error("Managed credentials must not be acquired"));
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId, onBehalfOfUserId: userId };
    const policy = { trustPreset: "low_trust_review" as const, authorizationPolicy: {
      trustPreset: "low_trust_review" as const, trustBoundary: { mode: "low_trust_review" as const, companyId, rootIssueId: issueId },
    } };
    const service = executionWorkspaceRepositoryService(db);
    const request = (repository: { kind: "catalog"; id: string } | { kind: "url"; url: string }, requestKey = randomUUID()) =>
      service.request({ companyId, issueId, actor, request: { repository, requestKey } });
    const admission = { companyId, issueId, workspaceId: workspace.id, cwd, agentId, runId, responsibleUserId: userId };
    return { companyId, agentId, issueId, runId, userId, workspace, policy, service, actor, request, admission };
  }

  async function lowTrustPeer(f: Awaited<ReturnType<typeof fixture>>, cwd = f.admission.cwd) {
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Low-trust alias",
      cwd, mode: "isolated_workspace", strategyType: "task_directory" }).returning();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Low-trust peer",
      assigneeAgentId: f.agentId, executionWorkspaceId: workspace.id });
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
      trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, rootIssueId: issueId } } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      responsibleUserId: f.userId, contextSnapshot: { issueId, executionPolicy: policy } });
    return { workspace, admission: { ...f.admission, cwd, issueId, runId, workspaceId: workspace.id }, actor: { ...f.actor, runId } };
  }

  async function standardPeer(f: Awaited<ReturnType<typeof fixture>>) {
    const userId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Other sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId: f.companyId, name: "Other worker", adapterType: "process" });
    await db.insert(companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" },
      { companyId: f.companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
    ]);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Other task files", cwd: f.admission.cwd,
      mode: "shared_workspace", strategyType: "operator_directory" }).returning();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Other task", assigneeAgentId: agentId, executionWorkspaceId: workspace.id });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, responsibleUserId: userId, status: "running", contextSnapshot: { issueId } });
    return { userId, agentId, issueId, runId, workspace,
      actor: { ...f.actor, agentId, runId, onBehalfOfUserId: userId },
      admission: { ...f.admission, agentId, runId, issueId, workspaceId: workspace.id, responsibleUserId: userId } };
  }
  async function privateTask(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: f.issueId, responsibleUserId: f.userId }).where(eq(issues.id, f.issueId));
  }
  async function grantPeer(f: Awaited<ReturnType<typeof fixture>>, peer: Awaited<ReturnType<typeof standardPeer>>) {
    return db.insert(issueAccessGrants).values([
      { issueId: f.issueId, subjectType: "agent", subjectId: peer.agentId, source: "explicit", grantedByUserId: f.userId },
      { issueId: f.issueId, subjectType: "user", subjectId: peer.userId, source: "explicit", grantedByUserId: f.userId },
    ]).returning();
  }
  async function localPrivateClone(f: Awaited<ReturnType<typeof fixture>>, beforePublish?: () => Promise<void>) {
    const source = path.join(root, `${f.issueId}-privacy-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "private.txt"), "Private task edits\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const actual = await vi.importActual<typeof import("../../services/managed-repository-checkout.js")>("../../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce((cwd, input) => actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source,
      beforePublish: async cloneCwd => { await beforePublish?.(); await input.beforePublish(cloneCwd); } }));
  }

  return { setup, cleanup, fixture, lowTrustPeer, standardPeer, privateTask, grantPeer, localPrivateClone };
}
