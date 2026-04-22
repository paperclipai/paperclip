import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectQuickLinks, projects } from "@paperclipai/db";
import {
  deriveProjectQuickLinkTitle,
  type ProjectQuickLink,
  type ProjectQuickLinkCreateRequest,
  type ProjectQuickLinkMetadataInput,
  type ProjectQuickLinkPreview,
  type ProjectQuickLinkUpdateRequest,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  createProjectQuickLinkPreviewFetcher,
  type ProjectQuickLinkPreviewFetcher,
} from "./project-quick-link-preview.js";

type ProjectQuickLinkRow = typeof projectQuickLinks.$inferSelect;
type ProjectQuickLinkServiceOptions = {
  previewFetcher?: ProjectQuickLinkPreviewFetcher;
};

function toProjectQuickLink(row: ProjectQuickLinkRow): ProjectQuickLink {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    title: row.title,
    url: row.url,
    siteName: row.siteName ?? null,
    description: row.description ?? null,
    imageUrl: row.imageUrl ?? null,
    faviconUrl: row.faviconUrl ?? null,
    metadataFetchedAt: row.metadataFetchedAt ?? null,
    position: row.position,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const metadataKeys = ["siteName", "description", "imageUrl", "faviconUrl"] as const;

function hasMetadataInput(input: ProjectQuickLinkMetadataInput) {
  return metadataKeys.some((key) => input[key] !== undefined);
}

function hasMetadataValue(input: ProjectQuickLinkMetadataInput) {
  return metadataKeys.some((key) => {
    const value = input[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function metadataPatch(input: ProjectQuickLinkMetadataInput): Pick<
  typeof projectQuickLinks.$inferInsert,
  "siteName" | "description" | "imageUrl" | "faviconUrl" | "metadataFetchedAt"
> {
  return {
    siteName: input.siteName ?? null,
    description: input.description ?? null,
    imageUrl: input.imageUrl ?? null,
    faviconUrl: input.faviconUrl ?? null,
    metadataFetchedAt: hasMetadataValue(input) ? new Date() : null,
  };
}

export function projectQuickLinkService(db: Db, options: ProjectQuickLinkServiceOptions = {}) {
  const previewFetcher = options.previewFetcher ?? createProjectQuickLinkPreviewFetcher();

  async function requireProject(companyId: string, projectId: string) {
    const project = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)))
      .then((rows) => rows[0] ?? null);
    if (!project) throw unprocessable("Project does not belong to this company.");
    return project;
  }

  async function getNextPosition(companyId: string, projectId: string) {
    const row = await db
      .select({ position: projectQuickLinks.position })
      .from(projectQuickLinks)
      .where(and(eq(projectQuickLinks.companyId, companyId), eq(projectQuickLinks.projectId, projectId)))
      .orderBy(desc(projectQuickLinks.position))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return (row?.position ?? -100) + 100;
  }

  async function getLink(companyId: string, projectId: string, linkId: string) {
    return db
      .select()
      .from(projectQuickLinks)
      .where(
        and(
          eq(projectQuickLinks.companyId, companyId),
          eq(projectQuickLinks.projectId, projectId),
          eq(projectQuickLinks.id, linkId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  return {
    list: async (companyId: string, projectId: string): Promise<ProjectQuickLink[]> => {
      await requireProject(companyId, projectId);
      const rows = await db
        .select()
        .from(projectQuickLinks)
        .where(and(eq(projectQuickLinks.companyId, companyId), eq(projectQuickLinks.projectId, projectId)))
        .orderBy(asc(projectQuickLinks.position), asc(projectQuickLinks.createdAt));
      return rows.map(toProjectQuickLink);
    },

    preview: async (
      companyId: string,
      projectId: string,
      url: string,
    ): Promise<ProjectQuickLinkPreview> => {
      await requireProject(companyId, projectId);
      return previewFetcher(url);
    },

    create: async (
      companyId: string,
      projectId: string,
      input: ProjectQuickLinkCreateRequest & {
        createdByAgentId?: string | null;
        createdByUserId?: string | null;
      },
    ): Promise<ProjectQuickLink> => {
      await requireProject(companyId, projectId);
      const position = input.position ?? (await getNextPosition(companyId, projectId));
      const row = await db
        .insert(projectQuickLinks)
        .values({
          companyId,
          projectId,
          title: deriveProjectQuickLinkTitle(input),
          url: input.url,
          ...metadataPatch(input),
          position,
          createdByAgentId: input.createdByAgentId ?? null,
          createdByUserId: input.createdByUserId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);
      return toProjectQuickLink(row);
    },

    update: async (
      companyId: string,
      projectId: string,
      linkId: string,
      input: ProjectQuickLinkUpdateRequest,
    ): Promise<ProjectQuickLink | null> => {
      const existing = await getLink(companyId, projectId, linkId);
      if (!existing) return null;

      const patch: Partial<typeof projectQuickLinks.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (input.title !== undefined) {
        patch.title = deriveProjectQuickLinkTitle({ title: input.title, url: input.url ?? existing.url });
      }
      if (input.url !== undefined) patch.url = input.url;
      if (input.position !== undefined) patch.position = input.position;
      if (hasMetadataInput(input)) {
        Object.assign(patch, metadataPatch(input));
      } else if (input.url !== undefined) {
        Object.assign(patch, metadataPatch({}));
      }

      const row = await db
        .update(projectQuickLinks)
        .set(patch)
        .where(
          and(
            eq(projectQuickLinks.companyId, companyId),
            eq(projectQuickLinks.projectId, projectId),
            eq(projectQuickLinks.id, linkId),
          ),
        )
        .returning()
        .then((rows) => rows[0]!);
      return toProjectQuickLink(row);
    },

    remove: async (companyId: string, projectId: string, linkId: string): Promise<ProjectQuickLink | null> => {
      const existing = await getLink(companyId, projectId, linkId);
      if (!existing) return null;
      await db
        .delete(projectQuickLinks)
        .where(
          and(
            eq(projectQuickLinks.companyId, companyId),
            eq(projectQuickLinks.projectId, projectId),
            eq(projectQuickLinks.id, linkId),
          ),
        );
      return toProjectQuickLink(existing);
    },
  };
}
