import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clients, clientProjects, projects } from "@paperclipai/db";

export interface ActiveProjectClientLinkRow {
  linkId: string;
  companyId: string;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  clientContactName: string | null;
  clientNotes: string | null;
  clientStatus: string;
  clientMetadata: unknown;
  relationshipDescription: string | null;
  relationshipTags: string[] | null;
  projectNameOverride: string | null;
  projectMetadata: unknown;
  linkedAt: Date;
  updatedAt: Date;
  projectStatus: string;
}

export async function listActiveProjectClientLinks(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<ActiveProjectClientLinkRow[]> {
  return await db
    .select({
      linkId: clientProjects.id,
      companyId: clientProjects.companyId,
      clientId: clients.id,
      clientName: clients.name,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      clientContactName: clients.contactName,
      clientNotes: clients.notes,
      clientStatus: clients.status,
      clientMetadata: clients.metadata,
      relationshipDescription: clientProjects.description,
      relationshipTags: clientProjects.tags,
      projectNameOverride: clientProjects.projectNameOverride,
      projectMetadata: clientProjects.metadata,
      linkedAt: clientProjects.createdAt,
      updatedAt: clientProjects.updatedAt,
      projectStatus: projects.status,
    })
    .from(clientProjects)
    .innerJoin(
      clients,
      and(
        eq(clientProjects.clientId, clients.id),
        eq(clientProjects.companyId, clients.companyId),
      ),
    )
    .innerJoin(
      projects,
      and(
        eq(clientProjects.projectId, projects.id),
        eq(clientProjects.companyId, projects.companyId),
      ),
    )
    .where(
      and(
        eq(clientProjects.companyId, companyId),
        eq(clientProjects.projectId, projectId),
        eq(clientProjects.status, "active"),
        eq(clients.status, "active"),
      ),
    )
    .orderBy(asc(clientProjects.createdAt), asc(clients.name));
}
