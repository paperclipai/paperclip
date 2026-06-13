import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, projects } from "@paperclipai/db";
import {
  deriveAgentUrlKey,
  deriveProjectUrlKey,
  normalizeAgentUrlKey,
  type DataRecoveryDetailField,
  type DataRecoveryItem,
  type DataRecoveryItemType,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

function companyHref(issuePrefix: string | null) {
  return issuePrefix ? `/${issuePrefix}/dashboard` : null;
}

function agentHref(issuePrefix: string | null, companyStatus: string | null, name: string, id: string) {
  return issuePrefix && companyStatus !== "archived" ? `/${issuePrefix}/agents/${deriveAgentUrlKey(name, id)}` : null;
}

function projectHref(issuePrefix: string | null, companyStatus: string | null, name: string, id: string) {
  return issuePrefix && companyStatus !== "archived"
    ? `/${issuePrefix}/projects/${deriveProjectUrlKey(name, id)}`
    : null;
}

function issueHref(issuePrefix: string | null, companyStatus: string | null, identifier: string | null, id: string) {
  if (!issuePrefix || companyStatus === "archived") return null;
  return `/${issuePrefix}/issues/${identifier ?? id}`;
}

function sortItems(items: DataRecoveryItem[]) {
  return items.sort((a, b) => {
    const left = a.removedAt ? new Date(a.removedAt).getTime() : 0;
    const right = b.removedAt ? new Date(b.removedAt).getTime() : 0;
    return right - left || a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
  });
}

function agentReplacementKey(companyId: string, name: string) {
  const urlKey = normalizeAgentUrlKey(name);
  return urlKey ? `${companyId}:${urlKey}` : null;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatDateValue(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

export function dataRecoveryService(db: Db) {
  async function list(): Promise<DataRecoveryItem[]> {
    const archivedCompanies = await db
      .select({
        id: companies.id,
        name: companies.name,
        status: companies.status,
        issuePrefix: companies.issuePrefix,
        updatedAt: companies.updatedAt,
      })
      .from(companies)
      .where(eq(companies.status, "archived"));

    const terminatedAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        companyId: companies.id,
        companyName: companies.name,
        companyStatus: companies.status,
        issuePrefix: companies.issuePrefix,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(companies, eq(agents.companyId, companies.id))
      .where(eq(agents.status, "terminated"));

    const activeAgentReplacements = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
      })
      .from(agents)
      .where(ne(agents.status, "terminated"));

    const activeAgentReplacementByKey = new Map<string, { id: string; name: string }>();
    for (const agent of activeAgentReplacements) {
      const key = agentReplacementKey(agent.companyId, agent.name);
      if (key) activeAgentReplacementByKey.set(key, { id: agent.id, name: agent.name });
    }

    const archivedProjects = await db
      .select({
        id: projects.id,
        name: projects.name,
        archivedAt: projects.archivedAt,
        companyId: companies.id,
        companyName: companies.name,
        companyStatus: companies.status,
        issuePrefix: companies.issuePrefix,
      })
      .from(projects)
      .innerJoin(companies, eq(projects.companyId, companies.id))
      .where(isNotNull(projects.archivedAt));

    const hiddenIssues = await db
      .select({
        id: issues.id,
        title: issues.title,
        identifier: issues.identifier,
        hiddenAt: issues.hiddenAt,
        companyId: companies.id,
        companyName: companies.name,
        companyStatus: companies.status,
        issuePrefix: companies.issuePrefix,
        projectId: projects.id,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(companies, eq(issues.companyId, companies.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(isNotNull(issues.hiddenAt));

    return sortItems([
      ...archivedCompanies.map((company): DataRecoveryItem => ({
        id: company.id,
        type: "company",
        name: company.name,
        state: "archived",
        removedAt: company.updatedAt,
        companyId: company.id,
        companyName: company.name,
        companyStatus: company.status,
        projectId: null,
        projectName: null,
        href: null,
        restoreBlockedReason: null,
      })),
      ...terminatedAgents.map((agent): DataRecoveryItem => {
        const replacementKey = agentReplacementKey(agent.companyId, agent.name);
        const replacement = replacementKey ? activeAgentReplacementByKey.get(replacementKey) : null;
        return {
          id: agent.id,
          type: "agent",
          name: agent.name,
          state: "terminated",
          removedAt: agent.updatedAt,
          companyId: agent.companyId,
          companyName: agent.companyName,
          companyStatus: agent.companyStatus,
          projectId: null,
          projectName: null,
          href: null,
          restoreBlockedReason: replacement
            ? `A non-terminated agent named "${replacement.name}" already uses this shortname (${shortId(replacement.id)}).`
            : null,
        };
      }),
      ...archivedProjects.map((project): DataRecoveryItem => ({
        id: project.id,
        type: "project",
        name: project.name,
        state: "archived",
        removedAt: project.archivedAt,
        companyId: project.companyId,
        companyName: project.companyName,
        companyStatus: project.companyStatus,
        projectId: project.id,
        projectName: project.name,
        href: projectHref(project.issuePrefix, project.companyStatus, project.name, project.id),
        restoreBlockedReason: null,
      })),
      ...hiddenIssues.map((issue): DataRecoveryItem => ({
        id: issue.id,
        type: "issue",
        name: issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title,
        state: "hidden",
        removedAt: issue.hiddenAt,
        companyId: issue.companyId,
        companyName: issue.companyName,
        companyStatus: issue.companyStatus,
        projectId: issue.projectId,
        projectName: issue.projectName,
        href: issueHref(issue.issuePrefix, issue.companyStatus, issue.identifier, issue.id),
        restoreBlockedReason: null,
      })),
    ]);
  }

  async function getItem(type: DataRecoveryItemType, id: string) {
    if (type === "company") {
      const company = await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          issuePrefix: companies.issuePrefix,
          updatedAt: companies.updatedAt,
        })
        .from(companies)
        .where(and(eq(companies.id, id), eq(companies.status, "archived")))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Recoverable company not found");
      return {
        id: company.id,
        type: "company",
        name: company.name,
        state: "archived",
        removedAt: company.updatedAt,
        companyId: company.id,
        companyName: company.name,
        companyStatus: company.status,
        projectId: null,
        projectName: null,
        href: null,
        restoreBlockedReason: null,
      } satisfies DataRecoveryItem;
    }

    if (type === "agent") {
      const agent = await db
        .select({
          id: agents.id,
          name: agents.name,
          status: agents.status,
          companyId: companies.id,
          companyName: companies.name,
          companyStatus: companies.status,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .innerJoin(companies, eq(agents.companyId, companies.id))
        .where(and(eq(agents.id, id), eq(agents.status, "terminated")))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Recoverable agent not found");

      const replacementKey = agentReplacementKey(agent.companyId, agent.name);
      const replacement = replacementKey
        ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, agent.companyId), ne(agents.status, "terminated")))
          .then((rows) =>
            rows.find((candidate) => agentReplacementKey(agent.companyId, candidate.name) === replacementKey) ?? null,
          )
        : null;

      return {
        id: agent.id,
        type: "agent",
        name: agent.name,
        state: "terminated",
        removedAt: agent.updatedAt,
        companyId: agent.companyId,
        companyName: agent.companyName,
        companyStatus: agent.companyStatus,
        projectId: null,
        projectName: null,
        href: null,
        restoreBlockedReason: replacement
          ? `A non-terminated agent named "${replacement.name}" already uses this shortname (${shortId(replacement.id)}).`
          : null,
      } satisfies DataRecoveryItem;
    }

    if (type === "project") {
      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          archivedAt: projects.archivedAt,
          companyId: companies.id,
          companyName: companies.name,
          companyStatus: companies.status,
          issuePrefix: companies.issuePrefix,
        })
        .from(projects)
        .innerJoin(companies, eq(projects.companyId, companies.id))
        .where(and(eq(projects.id, id), isNotNull(projects.archivedAt)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Recoverable project not found");
      return {
        id: project.id,
        type: "project",
        name: project.name,
        state: "archived",
        removedAt: project.archivedAt,
        companyId: project.companyId,
        companyName: project.companyName,
        companyStatus: project.companyStatus,
        projectId: project.id,
        projectName: project.name,
        href: projectHref(project.issuePrefix, project.companyStatus, project.name, project.id),
        restoreBlockedReason: null,
      } satisfies DataRecoveryItem;
    }

    if (type === "issue") {
      const issue = await db
        .select({
          id: issues.id,
          title: issues.title,
          identifier: issues.identifier,
          hiddenAt: issues.hiddenAt,
          companyId: companies.id,
          companyName: companies.name,
          companyStatus: companies.status,
          issuePrefix: companies.issuePrefix,
          projectId: projects.id,
          projectName: projects.name,
        })
        .from(issues)
        .innerJoin(companies, eq(issues.companyId, companies.id))
        .leftJoin(projects, eq(issues.projectId, projects.id))
        .where(and(eq(issues.id, id), isNotNull(issues.hiddenAt)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Recoverable issue not found");
      return {
        id: issue.id,
        type: "issue",
        name: issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title,
        state: "hidden",
        removedAt: issue.hiddenAt,
        companyId: issue.companyId,
        companyName: issue.companyName,
        companyStatus: issue.companyStatus,
        projectId: issue.projectId,
        projectName: issue.projectName,
        href: issueHref(issue.issuePrefix, issue.companyStatus, issue.identifier, issue.id),
        restoreBlockedReason: null,
      } satisfies DataRecoveryItem;
    }

    throw unprocessable("Unsupported recoverable item type");
  }

  return {
    list,
    details: async (type: DataRecoveryItemType, id: string): Promise<{ item: DataRecoveryItem; details: DataRecoveryDetailField[] }> => {
      const item = await getItem(type, id);

      if (type === "company") {
        const row = await db
          .select({
            id: companies.id,
            name: companies.name,
            description: companies.description,
            status: companies.status,
            issuePrefix: companies.issuePrefix,
            createdAt: companies.createdAt,
            updatedAt: companies.updatedAt,
          })
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.status, "archived")))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Recoverable company not found");
        return {
          item,
          details: [
            { label: "ID", value: row.id },
            { label: "Name", value: row.name },
            { label: "Description", value: row.description },
            { label: "Status", value: row.status },
            { label: "Issue prefix", value: row.issuePrefix },
            { label: "Created", value: formatDateValue(row.createdAt) },
            { label: "Updated", value: formatDateValue(row.updatedAt) },
          ],
        };
      }

      if (type === "agent") {
        const row = await db
          .select({
            id: agents.id,
            name: agents.name,
            role: agents.role,
            title: agents.title,
            status: agents.status,
            reportsTo: agents.reportsTo,
            adapterType: agents.adapterType,
            createdAt: agents.createdAt,
            updatedAt: agents.updatedAt,
          })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.status, "terminated")))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Recoverable agent not found");
        const manager = row.reportsTo
          ? await db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(eq(agents.id, row.reportsTo))
            .then((rows) => rows[0] ?? null)
          : null;
        return {
          item,
          details: [
            { label: "ID", value: row.id },
            { label: "Name", value: row.name },
            { label: "Role", value: row.role },
            { label: "Title", value: row.title },
            { label: "Status", value: row.status },
            { label: "Company", value: item.companyName },
            { label: "Reports to", value: manager ? `${manager.name} (${shortId(manager.id)})` : row.reportsTo },
            { label: "Adapter type", value: row.adapterType },
            { label: "Created", value: formatDateValue(row.createdAt) },
            { label: "Updated", value: formatDateValue(row.updatedAt) },
            { label: "Restore blocked", value: item.restoreBlockedReason },
          ],
        };
      }

      if (type === "project") {
        const row = await db
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            archivedAt: projects.archivedAt,
            createdAt: projects.createdAt,
            updatedAt: projects.updatedAt,
          })
          .from(projects)
          .where(and(eq(projects.id, id), isNotNull(projects.archivedAt)))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Recoverable project not found");
        return {
          item,
          details: [
            { label: "ID", value: row.id },
            { label: "Name", value: row.name },
            { label: "Description", value: row.description },
            { label: "Company", value: item.companyName },
            { label: "Archived", value: formatDateValue(row.archivedAt) },
            { label: "Created", value: formatDateValue(row.createdAt) },
            { label: "Updated", value: formatDateValue(row.updatedAt) },
          ],
        };
      }

      if (type === "issue") {
        const row = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            hiddenAt: issues.hiddenAt,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(eq(issues.id, id), isNotNull(issues.hiddenAt)))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Recoverable issue not found");
        return {
          item,
          details: [
            { label: "ID", value: row.id },
            { label: "Identifier", value: row.identifier },
            { label: "Title", value: row.title },
            { label: "Status", value: row.status },
            { label: "Priority", value: row.priority },
            { label: "Company", value: item.companyName },
            { label: "Project", value: item.projectName },
            { label: "Hidden", value: formatDateValue(row.hiddenAt) },
            { label: "Created", value: formatDateValue(row.createdAt) },
            { label: "Updated", value: formatDateValue(row.updatedAt) },
          ],
        };
      }

      throw unprocessable("Unsupported recoverable item type");
    },
    restore: async (type: DataRecoveryItemType, id: string): Promise<DataRecoveryItem> => {
      if (type === "company") {
        const [restored] = await db
          .update(companies)
          .set({ status: "active", updatedAt: new Date() })
          .where(and(eq(companies.id, id), eq(companies.status, "archived")))
          .returning();
        if (!restored) throw notFound("Recoverable company not found");
        return getItem("company", id).catch(() => ({
          id: restored.id,
          type: "company",
          name: restored.name,
          state: "archived",
          removedAt: null,
          companyId: restored.id,
          companyName: restored.name,
          companyStatus: "active",
          projectId: null,
          projectName: null,
          href: companyHref(restored.issuePrefix),
          restoreBlockedReason: null,
        }));
      }
      if (type === "agent") {
        const target = await db
          .select({ id: agents.id, companyId: agents.companyId, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.status, "terminated")))
          .then((rows) => rows[0] ?? null);
        if (!target) throw notFound("Recoverable agent not found");

        const targetShortname = normalizeAgentUrlKey(target.name);
        if (targetShortname) {
          const sameCompanyAgents = await db
            .select({ id: agents.id, name: agents.name, status: agents.status })
            .from(agents)
            .where(eq(agents.companyId, target.companyId));
          const replacement = sameCompanyAgents.find(
            (agent) =>
              agent.id !== target.id &&
              agent.status !== "terminated" &&
              normalizeAgentUrlKey(agent.name) === targetShortname,
          );
          if (replacement) {
            throw conflict(
              `Cannot restore terminated agent because non-terminated agent "${replacement.name}" already uses this shortname.`,
            );
          }
        }

        const [restored] = await db
          .update(agents)
          .set({ status: "idle", updatedAt: new Date() })
          .where(and(eq(agents.id, id), eq(agents.status, "terminated")))
          .returning();
        if (!restored) throw notFound("Recoverable agent not found");
        const company = await db
          .select({ name: companies.name, status: companies.status, issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, restored.companyId))
          .then((rows) => rows[0] ?? null);
        return {
          id: restored.id,
          type: "agent",
          name: restored.name,
          state: "terminated",
          removedAt: null,
          companyId: restored.companyId,
          companyName: company?.name ?? null,
          companyStatus: company?.status ?? null,
          projectId: null,
          projectName: null,
          href: agentHref(company?.issuePrefix ?? null, company?.status ?? null, restored.name, restored.id),
          restoreBlockedReason: null,
        };
      }
      if (type === "project") {
        const [restored] = await db
          .update(projects)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(and(eq(projects.id, id), isNotNull(projects.archivedAt)))
          .returning();
        if (!restored) throw notFound("Recoverable project not found");
        const company = await db
          .select({ name: companies.name, status: companies.status, issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, restored.companyId))
          .then((rows) => rows[0] ?? null);
        return {
          id: restored.id,
          type: "project",
          name: restored.name,
          state: "archived",
          removedAt: null,
          companyId: restored.companyId,
          companyName: company?.name ?? null,
          companyStatus: company?.status ?? null,
          projectId: restored.id,
          projectName: restored.name,
          href: projectHref(company?.issuePrefix ?? null, company?.status ?? null, restored.name, restored.id),
          restoreBlockedReason: null,
        };
      }
      if (type === "issue") {
        const [restored] = await db
          .update(issues)
          .set({ hiddenAt: null, updatedAt: new Date() })
          .where(and(eq(issues.id, id), isNotNull(issues.hiddenAt)))
          .returning();
        if (!restored) throw notFound("Recoverable issue not found");
        const company = await db
          .select({ name: companies.name, status: companies.status, issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, restored.companyId))
          .then((rows) => rows[0] ?? null);
        const project = restored.projectId
          ? await db
            .select({ name: projects.name })
            .from(projects)
            .where(eq(projects.id, restored.projectId))
            .then((rows) => rows[0] ?? null)
          : null;
        return {
          id: restored.id,
          type: "issue",
          name: restored.identifier ? `${restored.identifier}: ${restored.title}` : restored.title,
          state: "hidden",
          removedAt: null,
          companyId: restored.companyId,
          companyName: company?.name ?? null,
          companyStatus: company?.status ?? null,
          projectId: restored.projectId,
          projectName: project?.name ?? null,
          href: issueHref(company?.issuePrefix ?? null, company?.status ?? null, restored.identifier, restored.id),
          restoreBlockedReason: null,
        };
      }
      throw unprocessable("Unsupported recoverable item type");
    },
    renameAgent: async (id: string, name: string): Promise<DataRecoveryItem> => {
      const trimmedName = name.trim();
      if (!trimmedName) throw unprocessable("Agent name is required");

      const target = await db
        .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.status, "terminated")))
        .then((rows) => rows[0] ?? null);
      if (!target) throw notFound("Recoverable agent not found");

      const nextShortname = normalizeAgentUrlKey(trimmedName);
      if (!nextShortname) throw unprocessable("Agent name must contain at least one letter or number");

      const sameCompanyAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, target.companyId));
      const collision = sameCompanyAgents.find(
        (agent) =>
          agent.id !== target.id &&
          agent.status !== "terminated" &&
          normalizeAgentUrlKey(agent.name) === nextShortname,
      );
      if (collision) {
        throw conflict(
          `Cannot rename terminated agent because non-terminated agent "${collision.name}" already uses this shortname.`,
        );
      }

      await db
        .update(agents)
        .set({ name: trimmedName, updatedAt: new Date() })
        .where(and(eq(agents.id, id), eq(agents.status, "terminated")));

      return getItem("agent", id);
    },
    deletePermanent: async (type: DataRecoveryItemType, id: string): Promise<DataRecoveryItem> => {
      const item = await getItem(type, id);
      if (type === "company") {
        const removed = await companyService(db).remove(id);
        if (!removed) throw notFound("Recoverable company not found");
        return item;
      }
      if (type === "agent") {
        const removed = await agentService(db).remove(id);
        if (!removed) throw notFound("Recoverable agent not found");
        return item;
      }
      if (type === "project") {
        await db
          .update(issues)
          .set({ projectId: null, updatedAt: new Date() })
          .where(eq(issues.projectId, id));
        const removed = await projectService(db).remove(id);
        if (!removed) throw notFound("Recoverable project not found");
        return item;
      }
      if (type === "issue") {
        const removed = await issueService(db).remove(id);
        if (!removed) throw notFound("Recoverable issue not found");
        return item;
      }
      throw unprocessable("Unsupported recoverable item type");
    },
  };
}
