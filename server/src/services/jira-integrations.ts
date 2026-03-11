import { and, eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { jiraIntegrations } from "@paperclipai/db";
import type { CreateJiraIntegration, UpdateJiraIntegration, JiraImport, IssuePriority } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { secretService } from "./secrets.js";
import { issueService } from "./issues.js";
import { JiraClient } from "../lib/jira-client.js";
import type { StorageService } from "../storage/types.js";

function mapJiraPriority(jiraPriority: string): IssuePriority {
  const name = jiraPriority.toLowerCase();
  if (name === "highest" || name === "high") return "high";
  if (name === "medium") return "medium";
  if (name === "low" || name === "lowest") return "low";
  return "medium";
}

export function jiraIntegrationService(db: Db) {
  const secrets = secretService(db);
  const issues = issueService(db);

  async function getById(id: string) {
    return db
      .select()
      .from(jiraIntegrations)
      .where(eq(jiraIntegrations.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function resolveClient(id: string): Promise<{ client: JiraClient; integration: typeof jiraIntegrations.$inferSelect }> {
    const integration = await getById(id);
    if (!integration) throw notFound("Jira integration not found");

    const apiToken = await secrets.resolveSecretValue(
      integration.companyId,
      integration.credentialSecretId,
      "latest",
    );

    const client = new JiraClient(integration.hostUrl, integration.usernameOrEmail, apiToken);
    return { client, integration };
  }

  return {
    getById,

    list: async (companyId: string) => {
      return db
        .select()
        .from(jiraIntegrations)
        .where(eq(jiraIntegrations.companyId, companyId))
        .orderBy(desc(jiraIntegrations.createdAt));
    },

    create: async (companyId: string, input: CreateJiraIntegration) => {
      const existing = await db
        .select()
        .from(jiraIntegrations)
        .where(and(eq(jiraIntegrations.companyId, companyId), eq(jiraIntegrations.name, input.name)))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`Jira integration with name "${input.name}" already exists`);

      const secret = await secrets.create(companyId, {
        name: `jira-token-${input.name}`,
        provider: "local_encrypted",
        value: input.apiToken,
        description: `API token for Jira integration "${input.name}"`,
      });

      const [created] = await db
        .insert(jiraIntegrations)
        .values({
          companyId,
          name: input.name,
          hostUrl: input.hostUrl,
          usernameOrEmail: input.usernameOrEmail,
          credentialSecretId: secret.id,
          enabled: true,
        })
        .returning();
      return created;
    },

    update: async (id: string, patch: UpdateJiraIntegration) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Jira integration not found");

      if (patch.apiToken) {
        await secrets.rotate(existing.credentialSecretId, { value: patch.apiToken });
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.hostUrl !== undefined) updates.hostUrl = patch.hostUrl;
      if (patch.usernameOrEmail !== undefined) updates.usernameOrEmail = patch.usernameOrEmail;
      if (patch.enabled !== undefined) updates.enabled = patch.enabled;

      const [updated] = await db
        .update(jiraIntegrations)
        .set(updates)
        .where(eq(jiraIntegrations.id, id))
        .returning();
      return updated ?? null;
    },

    remove: async (id: string) => {
      const [deleted] = await db.delete(jiraIntegrations).where(eq(jiraIntegrations.id, id)).returning();
      return deleted ?? null;
    },

    resolveClient,

    testConnection: async (id: string) => {
      const { client } = await resolveClient(id);
      return client.testConnection();
    },

    listProjects: async (id: string) => {
      const { client } = await resolveClient(id);
      return client.listProjects();
    },

    getProjectStatuses: async (id: string, projectKey: string) => {
      const { client } = await resolveClient(id);
      return client.getProjectStatuses(projectKey);
    },

    getAssignableUsers: async (id: string, projectKey: string) => {
      const { client } = await resolveClient(id);
      return client.getAssignableUsers(projectKey);
    },

    previewIssues: async (id: string, request: JiraImport) => {
      const { client } = await resolveClient(id);
      const jql = client.buildJql(request.projectKey, request.statuses, request.assigneeAccountId);
      const issues = await client.searchIssues(jql);
      return { issues, jql };
    },

    importIssues: async (companyId: string, request: JiraImport, actor: { userId?: string | null }, storageService?: StorageService) => {
      const { client } = await resolveClient(request.integrationId);
      const jql = client.buildJql(request.projectKey, request.statuses, request.assigneeAccountId);
      const jiraIssues = await client.searchIssuesFull(jql);

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const jiraIssue of jiraIssues) {
        const titlePrefix = `[${jiraIssue.key}]`;

        // Check for duplicate by searching existing issues
        const existingIssues = await issues.list(companyId, { q: titlePrefix });
        if (existingIssues.length > 0 && existingIssues.some((e: { title: string }) => e.title.startsWith(titlePrefix))) {
          skipped++;
          continue;
        }

        try {
          const created = await issues.create(companyId, {
            title: `${titlePrefix} ${jiraIssue.summary}`,
            description: jiraIssue.description || null,
            status: request.targetStatus ?? "backlog",
            priority: request.targetPriority ?? mapJiraPriority(jiraIssue.priority),
            projectId: request.targetProjectId ?? null,
          });

          // Import comments
          if (jiraIssue.comments && jiraIssue.comments.length > 0) {
            for (const comment of jiraIssue.comments) {
              await issues.addComment(created.id, comment, {
                userId: actor.userId ?? undefined,
              });
            }
          }

          // Import attachments
          if (storageService && jiraIssue.attachments && jiraIssue.attachments.length > 0) {
            for (const attachment of jiraIssue.attachments) {
              try {
                const buffer = await client.downloadAttachment(attachment.contentUrl);
                const putResult = await storageService.putFile({
                  companyId,
                  namespace: `issues/${created.id}`,
                  originalFilename: attachment.filename,
                  contentType: attachment.mimeType,
                  body: buffer,
                });
                await issues.createAttachment({
                  issueId: created.id,
                  provider: putResult.provider,
                  objectKey: putResult.objectKey,
                  contentType: putResult.contentType,
                  byteSize: putResult.byteSize,
                  sha256: putResult.sha256,
                  originalFilename: putResult.originalFilename,
                });
              } catch (attachErr) {
                errors.push(`${jiraIssue.key} attachment "${attachment.filename}": ${attachErr instanceof Error ? attachErr.message : "Unknown error"}`);
              }
            }
          }

          imported++;
        } catch (err) {
          errors.push(`${jiraIssue.key}: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }

      // Update lastSyncAt
      await db
        .update(jiraIntegrations)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(jiraIntegrations.id, request.integrationId));

      return { imported, skipped, errors };
    },
  };
}
