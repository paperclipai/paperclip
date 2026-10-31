import { projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";

type Reader = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function resolveProjectDefaultWorkspaceId(db: Reader, input: {
  companyId: string;
  projectId: string;
  policy?: ReturnType<typeof parseProjectExecutionWorkspacePolicy>;
}): Promise<string | null> {
  let policy = input.policy;
  if (policy === undefined) {
    const [project] = await db.select({ executionWorkspacePolicy: projects.executionWorkspacePolicy }).from(projects)
      .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)));
    policy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
  }
  if (policy?.defaultProjectWorkspaceId) return policy.defaultProjectWorkspaceId;
  const [workspace] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id)).limit(1);
  return workspace?.id ?? null;
}
