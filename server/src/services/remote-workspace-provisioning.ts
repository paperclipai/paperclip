import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { RemoteWorkspaceTarget } from "./remote-workspace-transport.js";

/** Arbitrary provisioning commands cannot be replayed after an ambiguous reply. */
export async function provisionRemoteWorkspace(input: {
  db: Db; companyId: string; workspaceId: string; runId: string; epoch: number;
  remoteCwd: string; target: RemoteWorkspaceTarget; commands: Array<string | null | undefined>;
  assertOwned?: () => Promise<void>;
}) {
  for (const [index, command] of input.commands.entries()) {
    if (!command?.trim()) continue;
    await input.assertOwned?.();
    const digest = createHash("sha256").update(command).digest("hex");
    const operation = await input.db.transaction(async tx => {
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
      const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
      if (!authority || authority.epoch !== input.epoch || authority.writerRunId !== input.runId || run?.status !== "running") throw new Error("remote_workspace_provision_fenced");
      const [existing] = await tx.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
        eq(workspaceOperations.executionWorkspaceId, input.workspaceId), eq(workspaceOperations.heartbeatRunId, input.runId),
        eq(workspaceOperations.phase, "remote_workspace_provision"), sql`${workspaceOperations.metadata}->>'index' = ${String(index)}`,
        sql`${workspaceOperations.metadata}->>'epoch' = ${String(input.epoch)}`)).limit(1);
      if (existing) {
        if (existing.metadata?.commandSha256 !== digest || existing.status !== "succeeded") throw new Error("remote_workspace_provision_unverified");
        return null;
      }
      const [created] = await tx.insert(workspaceOperations).values({ companyId: input.companyId, executionWorkspaceId: input.workspaceId,
        heartbeatRunId: input.runId, issueId: workspace!.sourceIssueId, phase: "remote_workspace_provision", status: "running",
        metadata: { epoch: input.epoch, index, commandSha256: digest, uncertain: true } }).returning();
      return created!;
    });
    if (!operation) continue;
    await input.assertOwned?.();
    const result = await input.target.runner!.execute({ command: "bash", args: ["-lc", command], cwd: input.remoteCwd,
      timeoutMs: 300_000, bypassSession: true });
    if (result.exitCode !== 0 || result.timedOut) throw new Error("remote_workspace_provision_unverified");
    await input.assertOwned?.();
    await input.db.transaction(async tx => {
      const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
      const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
      if (authority?.epoch !== input.epoch || authority.writerRunId !== input.runId) throw new Error("remote_workspace_provision_fenced");
      await tx.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
        metadata: { ...operation.metadata, uncertain: false } }).where(eq(workspaceOperations.id, operation.id));
    });
  }
}
