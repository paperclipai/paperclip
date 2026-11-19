import { projects, type agents, type issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { environmentService } from "../environments.js";
import { instanceSettingsService } from "../instance-settings.js";
import { parseIssueExecutionWorkspaceSettings, resolveExecutionWorkspaceEnvironmentId } from "../execution-workspace-policy.js";
import { resolveCoreTrustPreset } from "../trust-preset-resolver.js";
import { unprocessable } from "../../errors.js";

/** Read placement policy for cooldown identity; environment admission still owns authority and leases. */
export async function harnessPoolEnvironmentScope(db: Db, agent: typeof agents.$inferSelect, task: typeof issues.$inferSelect | undefined): Promise<string> {
  const settings = instanceSettingsService(db);
  const environments = environmentService(db);
  const [instance, experimental, local] = await Promise.all([settings.get(), settings.getExperimental(), environments.ensureLocalEnvironment(agent.companyId)]);
  if (instance.general.executionMode === "kubernetes") {
    const target = await environments.findKubernetesEnvironment(agent.companyId);
    if (!target) throw unprocessable("Configure the required Kubernetes environment before using Pool");
    return target.id;
  }
  const [project] = task?.projectId ? await db.select().from(projects).where(and(eq(projects.companyId, agent.companyId), eq(projects.id, task.projectId))) : [];
  const trust = resolveCoreTrustPreset({ companyId: agent.companyId, agent, project, issue: task });
  const managed = experimental.enableManagedSandboxOnly ? await environments.findManagedSandboxEnvironment(agent.companyId) : null;
  return resolveExecutionWorkspaceEnvironmentId({
    agentDefaultEnvironmentId: agent.defaultEnvironmentId, instanceDefaultEnvironmentId: instance.defaultEnvironmentId,
    localDefaultEnvironmentId: local.id, managedSandboxOnly: experimental.enableManagedSandboxOnly,
    managedSandboxEnvironmentId: managed?.id ?? null,
    lowTrustIssueEnvironmentId: trust.kind === "low_trust_review" ? parseIssueExecutionWorkspaceSettings(task?.executionWorkspaceSettings, { includeEnvironmentId: true })?.environmentId : null,
  }).environmentId!;
}
