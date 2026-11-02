import { and, eq } from "drizzle-orm";
import { projects, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

export async function assertProjectRunAdmissionOpen(
  tx: Db,
  companyId: string,
  projectId: string | null | undefined,
): Promise<void> {
  if (!projectId) return;

  const [project] = await tx
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .for("share")
    .limit(1);

  if (!project || project.status === "deleting") {
    throw conflict("Project is being deleted; this run was not queued.", {
      code: "project_deleting",
      projectId,
    });
  }
}
