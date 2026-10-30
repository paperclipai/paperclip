import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, executionWorkspaceRepositories,
  executionWorkspaceRepositoryAccess, executionWorkspaceRepositoryRoots, executionWorkspaces,
  heartbeatRuns, issueAccessGrants, issues, type Db,
} from "@paperclipai/db";
import type { AuthorizationActor } from "../../services/authorization.js";

const exec = promisify(execFile);

/** Synthetic data only. The caller owns the disposable database and directory. */
export async function createWorkspacePreparationHistoryFixture(db: Db, directory: string, options: {
  workspaces: number; sharedRoots: number; sources: number; readers: number;
  privateHistory?: boolean;
}) {
  const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID();
  const issueId = randomUUID(), workspaceId = randomUUID(), runId = randomUUID();
  await fs.mkdir(directory, { recursive: true });
  const cwd = await fs.realpath(directory);
  await exec("git", ["init", "--initial-branch=main", cwd]);
  await fs.writeFile(path.join(cwd, "result.txt"), "Synthetic task workspace\n");
  await exec("git", ["-C", cwd, "add", "."]);
  await exec("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Fixture"]);
  const pin = (await exec("git", ["-C", cwd, "rev-parse", "HEAD"])).stdout.trim();
  await db.insert(companies).values({ id: companyId, name: "Synthetic workspace preparation", issuePrefix: `H${companyId.slice(0, 6)}` });
  const principals = Array.from({ length: 8 }, (_, index) => ({
    userId: index === 0 ? userId : randomUUID(), agentId: index === 0 ? agentId : randomUUID(),
  }));
  await db.insert(authUsers).values(principals.map(({ userId: id }) => ({ id, name: "Synthetic sponsor", email: `${id}@example.test`,
    createdAt: new Date(), updatedAt: new Date(), emailVerified: true })));
  await db.insert(agents).values(principals.map(({ agentId: id }) => ({ id, companyId, name: "Synthetic worker", adapterType: "process" })));
  await db.insert(companyMemberships).values(principals.flatMap(principal => [
    { companyId, principalType: "user", principalId: principal.userId, membershipRole: "operator", status: "active" },
    { companyId, principalType: "agent", principalId: principal.agentId, membershipRole: "member", status: "active" },
  ]));
  await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, cwd, name: "Current task workspace",
    mode: "shared_workspace", strategyType: "operator_directory" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Current task", responsibleUserId: userId,
    assigneeAgentId: agentId, executionWorkspaceId: workspaceId });
  await db.update(executionWorkspaces).set({ sourceIssueId: issueId }).where(eq(executionWorkspaces.id, workspaceId));
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: userId, status: "running",
    issueId, contextSnapshot: { issueId } });
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

  const privateRoots = Array.from({ length: 8 }, () => randomUUID());
  await db.insert(issues).values(privateRoots.map((id, index) => ({ id, companyId, title: `Private historical context ${index}`,
    visibility: "private", privacyRootIssueId: id, responsibleUserId: principals[1].userId, assigneeAgentId: principals[1].agentId })));
  if (!options.privateHistory) {
    await db.insert(issueAccessGrants).values(privateRoots.flatMap(root => principals.flatMap(principal => [
      { issueId: root, subjectType: "user", subjectId: principal.userId, source: "explicit" },
      { issueId: root, subjectType: "agent", subjectId: principal.agentId, source: "explicit" },
    ])));
  }
  const historyWorkspaceIds = Array.from({ length: options.workspaces }, () => randomUUID());
  const historyTaskIds = Array.from({ length: options.workspaces }, () => randomUUID());
  const otherRoot = path.join(path.dirname(cwd), `${path.basename(cwd)}-unrelated`);
  await fs.mkdir(otherRoot, { recursive: true });
  for (let offset = 0; offset < historyWorkspaceIds.length; offset += 400) {
    await db.insert(executionWorkspaces).values(historyWorkspaceIds.slice(offset, offset + 400).map((id, batchIndex) => ({
      id, companyId, name: "Historical workspace", cwd: offset + batchIndex < options.sharedRoots ? cwd : otherRoot,
      mode: "shared_workspace", strategyType: "operator_directory",
    })));
    await db.insert(issues).values(historyTaskIds.slice(offset, offset + 400).map((id, batchIndex) => ({
      id, companyId, title: "Historical task", visibility: "private", parentId: privateRoots[(offset + batchIndex) % privateRoots.length],
      privacyRootIssueId: privateRoots[(offset + batchIndex) % privateRoots.length],
      privacyParentIssueId: privateRoots[(offset + batchIndex) % privateRoots.length], responsibleUserId: principals[1].userId,
      assigneeAgentId: principals[1].agentId, executionWorkspaceId: historyWorkspaceIds[offset + batchIndex],
    })));
  }
  // The trigger retains task disclosure sources on each workspace. It intentionally remains active.
  const rootKey = createHash("sha256").update(cwd).digest("hex");
  for (let offset = 0; offset < options.sources; offset += 400) {
    await db.insert(executionWorkspaceRepositoryAccess).values(historyWorkspaceIds.slice(offset, Math.min(offset + 400, options.sources))
      .map(scopeId => ({ companyId, canonicalCwd: cwd, rootKey, kind: "source" as const, scopeId })));
  }
  const readerRunIds = Array.from({ length: options.readers }, () => randomUUID());
  if (readerRunIds.length) {
    await db.insert(heartbeatRuns).values(readerRunIds.map((id, index) => ({ id, companyId,
      agentId: principals[index % principals.length].agentId, responsibleUserId: principals[index % principals.length].userId,
      issueId, status: "succeeded", contextSnapshot: { issueId } })));
    await db.insert(executionWorkspaceRepositoryAccess).values(readerRunIds.map((scopeId, index) => ({ companyId, canonicalCwd: cwd,
      rootKey, kind: "reader" as const, scopeId, issueId, agentId: principals[index % principals.length].agentId,
      responsibleUserId: principals[index % principals.length].userId })));
  }
  const foreignCompanyId = randomUUID(), foreignWorkspaceId = randomUUID();
  await db.insert(companies).values({ id: foreignCompanyId, name: "Cross-company decoy", issuePrefix: `D${foreignCompanyId.slice(0, 6)}` });
  await db.insert(executionWorkspaces).values({ id: foreignWorkspaceId, companyId: foreignCompanyId, cwd, name: "Foreign workspace",
    mode: "shared_workspace", strategyType: "operator_directory" });
  await db.$client.unsafe("ANALYZE");
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId, runId, onBehalfOfUserId: userId };
  const input = { companyId, issueId, workspaceId, cwd, agentId, runId, responsibleUserId: userId };
  return { ...input, userId, input, actor, pin, rootKey, principals, privateRoots, historyWorkspaceIds, historyTaskIds, readerRunIds,
    foreignCompanyId, foreignWorkspaceId, options };
}

export async function addReadyWorkspaceHistoryRepository(db: Db,
  fixture: Awaited<ReturnType<typeof createWorkspacePreparationHistoryFixture>>,
  options: { matchingHistoricalReceipts?: boolean } = {},
) {
  const repositoryIdentity = "https://github.com/paperclip-synthetic/history-fixture";
  const relativePath = `.paperclip-repositories/task-repo-${createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 24)}`;
  const checkout = path.join(fixture.cwd, relativePath);
  await fs.mkdir(path.dirname(checkout), { recursive: true });
  await exec("git", ["clone", "--no-hardlinks", fixture.cwd, checkout]);
  await exec("git", ["-C", checkout, "remote", "set-url", "origin", repositoryIdentity]);
  const [row] = await db.insert(executionWorkspaceRepositories).values({ companyId: fixture.companyId,
    executionWorkspaceId: fixture.workspaceId, requestedByIssueId: fixture.issueId, repositoryIdentity, repoUrl: repositoryIdentity,
    relativePath, requestedRef: "HEAD", pinnedCommit: fixture.pin, state: "ready", requestKey: randomUUID() }).returning();
  let ownerId = row.id;
  if (options.matchingHistoricalReceipts) {
    for (let offset = 0; offset < fixture.historyWorkspaceIds.length; offset += 400) {
      const peers = await db.insert(executionWorkspaceRepositories).values(fixture.historyWorkspaceIds.slice(offset, offset + 400)
        .map((executionWorkspaceId, index) => ({ companyId: fixture.companyId, executionWorkspaceId,
          requestedByIssueId: fixture.historyTaskIds[offset + index], repositoryIdentity, repoUrl: repositoryIdentity,
          relativePath, requestedRef: "HEAD", pinnedCommit: offset === 0 && index === 0 ? fixture.pin : null,
          state: offset === 0 && index === 0 ? "ready" : "pending", requestKey: randomUUID() })))
        .returning({ id: executionWorkspaceRepositories.id });
      if (offset === 0 && peers[0]) ownerId = peers[0].id;
    }
  }
  await fs.writeFile(path.join(checkout, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1,
    repositoryId: ownerId, pinnedCommit: fixture.pin }));
  return { row, checkout };
}

export async function addPoisonedWorkspaceHistory(db: Db, fixture: Awaited<ReturnType<typeof createWorkspacePreparationHistoryFixture>>) {
  await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: fixture.companyId, canonicalCwd: fixture.cwd,
    rootKey: fixture.rootKey, mode: "anonymous_only" });
  await db.insert(executionWorkspaceRepositoryAccess).values({ companyId: fixture.companyId, canonicalCwd: fixture.cwd,
    rootKey: fixture.rootKey, kind: "reader", scopeId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(),
    responsibleUserId: "deleted-historical-user" });
  await db.insert(executionWorkspaceRepositoryAccess).values({ companyId: fixture.companyId, canonicalCwd: fixture.cwd,
    rootKey: fixture.rootKey, kind: "source", scopeId: randomUUID() });
  // Exercise the actual durable app-disclosure trigger: NEW metadata cannot forge its retained set.
  await db.update(executionWorkspaces).set({ sourceIssueId: fixture.privateRoots[0] })
    .where(eq(executionWorkspaces.id, fixture.workspaceId));
  await db.update(executionWorkspaces).set({ sourceIssueId: fixture.issueId })
    .where(eq(executionWorkspaces.id, fixture.workspaceId));
}
