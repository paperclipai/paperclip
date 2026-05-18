import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { externalLinks, issues } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import type { CreateExternalLink, IssueExternalRefsJira } from "@paperclipai/shared";

export function externalLinkService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getLink(linkId: string) {
    return db
      .select({
        id: externalLinks.id,
        issueId: externalLinks.issueId,
        platform: externalLinks.platform,
        externalKey: externalLinks.externalKey,
        externalUrl: externalLinks.externalUrl,
        metadata: externalLinks.metadata,
        createdAt: externalLinks.createdAt,
        updatedAt: externalLinks.updatedAt,
        companyId: issues.companyId,
      })
      .from(externalLinks)
      .innerJoin(issues, eq(externalLinks.issueId, issues.id))
      .where(eq(externalLinks.id, linkId))
      .then((rows) => rows[0] ?? null);
  }

  return {
    listForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      return db
        .select()
        .from(externalLinks)
        .where(eq(externalLinks.issueId, issueId))
        .orderBy(externalLinks.createdAt);
    },

    create: async (issueId: string, input: CreateExternalLink) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const existing = await db
        .select({ id: externalLinks.id })
        .from(externalLinks)
        .where(
          and(
            eq(externalLinks.issueId, issueId),
            eq(externalLinks.platform, input.platform),
            eq(externalLinks.externalKey, input.externalKey),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        throw conflict("A link for this platform and key already exists on this issue");
      }

      return db
        .insert(externalLinks)
        .values({
          issueId,
          platform: input.platform,
          externalKey: input.externalKey,
          externalUrl: input.externalUrl,
          metadata: (input.metadata ?? {}) as Record<string, unknown>,
        })
        .returning()
        .then((rows) => rows[0]!);
    },

    getById: async (linkId: string) => {
      const row = await getLink(linkId);
      if (!row) throw notFound("External link not found");
      return row;
    },

    deleteById: async (linkId: string) => {
      const rows = await db
        .delete(externalLinks)
        .where(eq(externalLinks.id, linkId))
        .returning({ id: externalLinks.id });

      if (rows.length === 0) throw notFound("External link not found");
    },

    // Upsert the Jira external link for an issue. Used by PATCH /issues/:id externalRefs.
    upsertJiraLink: async (issueId: string, input: IssueExternalRefsJira) => {
      const metadata: Record<string, unknown> = {};
      if (input.projectKey) metadata.projectKey = input.projectKey;
      if (input.instanceUrl) metadata.instanceUrl = input.instanceUrl;

      await db
        .insert(externalLinks)
        .values({
          issueId,
          platform: "jira",
          externalKey: input.key,
          externalUrl: input.externalUrl,
          metadata,
        })
        .onConflictDoUpdate({
          target: [externalLinks.issueId, externalLinks.platform, externalLinks.externalKey],
          set: {
            externalUrl: input.externalUrl,
            metadata: sql`excluded.metadata`,
            updatedAt: sql`now()`,
          },
        });
    },

    // Remove all Jira links for an issue. Used when externalRefs.jira is set to null.
    deleteJiraLinks: async (issueId: string) => {
      await db
        .delete(externalLinks)
        .where(and(eq(externalLinks.issueId, issueId), eq(externalLinks.platform, "jira")));
    },

    // Returns the first Jira link for an issue, or null.
    getJiraLink: async (issueId: string) => {
      return db
        .select()
        .from(externalLinks)
        .where(and(eq(externalLinks.issueId, issueId), eq(externalLinks.platform, "jira")))
        .orderBy(externalLinks.createdAt)
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },

    lookupByPlatformKey: async (platform: string, externalKey: string) => {
      const row = await db
        .select({
          id: externalLinks.id,
          issueId: externalLinks.issueId,
          platform: externalLinks.platform,
          externalKey: externalLinks.externalKey,
          externalUrl: externalLinks.externalUrl,
          metadata: externalLinks.metadata,
          createdAt: externalLinks.createdAt,
          updatedAt: externalLinks.updatedAt,
          companyId: issues.companyId,
        })
        .from(externalLinks)
        .innerJoin(issues, eq(externalLinks.issueId, issues.id))
        .where(
          and(
            eq(externalLinks.platform, platform),
            eq(externalLinks.externalKey, externalKey),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!row) throw notFound("External link not found");
      return row;
    },
  };
}
