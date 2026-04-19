import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyRolloutEntityLinks,
  companyRolloutReleases,
  companyRolloutTargets,
} from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityFileEntry,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilityProjectManifestEntry,
} from "@paperclipai/shared";
import type {
  CompanyRolloutApplyResult,
  CompanyRolloutApplyTargetResult,
  CompanyRolloutCounts,
  CompanyRolloutCreateRequest,
  CompanyRolloutEntityKind,
  CompanyRolloutEntityPreview,
  CompanyRolloutPreviewResult,
  CompanyRolloutRelease,
  CompanyRolloutTargetPreview,
  CompanyRolloutTargetSelectionRequest,
} from "@paperclipai/shared";
import {
  ISSUE_PRIORITIES,
  PROJECT_STATUSES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_SIGNING_MODES,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import { writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { companyService } from "./companies.js";
import { companyPortabilityService } from "./company-portability.js";
import { companySkillService } from "./company-skills.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";
import { logActivity } from "./activity-log.js";

type ReleaseRow = typeof companyRolloutReleases.$inferSelect;
type LinkRow = typeof companyRolloutEntityLinks.$inferSelect;

type EntityKey = `${CompanyRolloutEntityKind}:${string}`;
type RolloutTargetCompany = {
  id: string;
  name: string;
  status: string;
};

type TargetContext = {
  company: RolloutTargetCompany;
  links: Map<EntityKey, LinkRow>;
  agentsBySlug: Map<string, { id: string; name: string; status: string }>;
  agentsById: Map<string, { id: string; name: string; status: string }>;
  skillsByKey: Map<string, { id: string; key: string; slug: string; name: string }>;
  skillsBySlug: Map<string, { id: string; key: string; slug: string; name: string }>;
  skillsById: Map<string, { id: string; key: string; slug: string; name: string }>;
  projectsBySlug: Map<string, { id: string; name: string; urlKey: string }>;
  projectsById: Map<string, { id: string; name: string; urlKey: string }>;
  routinesByTitle: Map<string, { id: string; title: string }>;
  routinesById: Map<string, { id: string; title: string }>;
};

type AppliedEntityIds = {
  agents: Map<string, string>;
  projects: Map<string, string>;
  routines: Map<string, string>;
  skills: Map<string, string>;
};

const EMPTY_COUNTS: CompanyRolloutCounts = {
  create: 0,
  update: 0,
  skipNoChange: 0,
  skipUnmanagedConflict: 0,
  error: 0,
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (!isPlainRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashValue(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizePortablePath(input: string) {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function ensureMarkdownPath(input: string) {
  return input.endsWith(".md") ? input : `${input}.md`;
}

function portableText(entry: CompanyPortabilityFileEntry | undefined): string | null {
  return typeof entry === "string" ? entry : null;
}

function parseMarkdownBody(raw: string | null) {
  if (!raw) return null;
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return normalized.trim();
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) return normalized.trim();
  return normalized.slice(closing + 5).trim();
}

function pickTextFiles(files: Record<string, CompanyPortabilityFileEntry>) {
  return Object.fromEntries(
    Object.entries(files).flatMap(([filePath, content]) =>
      typeof content === "string" ? [[filePath, content] as const] : [],
    ),
  );
}

function entityKey(kind: CompanyRolloutEntityKind, key: string): EntityKey {
  return `${kind}:${key}`;
}

function countActions(entityActions: CompanyRolloutEntityPreview[]): CompanyRolloutCounts {
  const counts = { ...EMPTY_COUNTS };
  for (const action of entityActions) {
    if (action.action === "create") counts.create += 1;
    if (action.action === "update") counts.update += 1;
    if (action.action === "skip_no_change") counts.skipNoChange += 1;
    if (action.action === "skip_unmanaged_conflict") counts.skipUnmanagedConflict += 1;
    if (action.action === "error") counts.error += 1;
  }
  return counts;
}

function toRelease(row: ReleaseRow): CompanyRolloutRelease {
  const counts = row.countsJson ?? {};
  return {
    id: row.id,
    sourceCompanyId: row.sourceCompanyId,
    version: row.version,
    title: row.title,
    notes: row.notes,
    manifest: row.manifestJson,
    files: row.filesJson,
    selectedFiles: row.selectedFiles ?? [],
    packageHash: row.packageHash,
    counts: {
      files: Number(counts.files ?? Object.keys(row.filesJson).length),
      agents: Number(counts.agents ?? row.manifestJson.agents.length),
      skills: Number(counts.skills ?? row.manifestJson.skills.length),
      projects: Number(counts.projects ?? row.manifestJson.projects.length),
      routines: Number(counts.routines ?? row.manifestJson.issues.filter((issue) => issue.recurring).length),
      issues: Number(counts.issues ?? row.manifestJson.issues.filter((issue) => !issue.recurring).length),
    },
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function sourceHash(input: {
  release: CompanyRolloutRelease;
  kind: CompanyRolloutEntityKind;
  key: string;
  entry: unknown;
  paths: string[];
}) {
  const files = Object.fromEntries(
    input.paths.map((filePath) => [filePath, input.release.files[filePath] ?? null]),
  );
  return hashValue({
    packageHash: input.release.packageHash,
    kind: input.kind,
    key: input.key,
    entry: input.entry,
    files,
  });
}

function filesUnder(files: Record<string, CompanyPortabilityFileEntry>, directory: string) {
  const prefix = `${normalizePortablePath(directory).replace(/\/+$/, "")}/`;
  return Object.keys(files).filter((filePath) => normalizePortablePath(filePath).startsWith(prefix)).sort();
}

function agentFilePaths(release: CompanyRolloutRelease, agent: CompanyPortabilityAgentManifestEntry) {
  const entryPath = ensureMarkdownPath(normalizePortablePath(agent.path));
  const dir = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : `agents/${agent.slug}`;
  return Array.from(new Set([entryPath, ...filesUnder(release.files, dir)])).sort();
}

function projectFilePaths(release: CompanyRolloutRelease, project: CompanyPortabilityProjectManifestEntry) {
  const entryPath = ensureMarkdownPath(normalizePortablePath(project.path));
  const dir = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : `projects/${project.slug}`;
  return Array.from(new Set([entryPath, ...filesUnder(release.files, dir)])).sort();
}

function issueFilePaths(release: CompanyRolloutRelease, issue: CompanyPortabilityIssueManifestEntry) {
  const entryPath = ensureMarkdownPath(normalizePortablePath(issue.path));
  const dir = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : `tasks/${issue.slug}`;
  return Array.from(new Set([entryPath, ...filesUnder(release.files, dir)])).sort();
}

function skillFilePaths(release: CompanyRolloutRelease, skill: CompanyRolloutRelease["manifest"]["skills"][number]) {
  const paths = new Set<string>([ensureMarkdownPath(normalizePortablePath(skill.path))]);
  for (const file of skill.fileInventory ?? []) {
    if (release.files[file.path] !== undefined) paths.add(file.path);
  }
  const entryDir = skill.path.includes("/") ? skill.path.slice(0, skill.path.lastIndexOf("/")) : `skills/${skill.slug}`;
  for (const filePath of filesUnder(release.files, entryDir)) paths.add(filePath);
  return Array.from(paths).sort();
}

function entityAction(input: {
  kind: CompanyRolloutEntityKind;
  key: string;
  label: string;
  hash: string;
  link: LinkRow | null;
  linkedTargetExists: boolean;
  unmanagedConflict: { id: string; reason: string } | null;
}): CompanyRolloutEntityPreview {
  if (input.link && input.link.sourceEntityHash === input.hash && input.linkedTargetExists) {
    return {
      kind: input.kind,
      key: input.key,
      label: input.label,
      action: "skip_no_change",
      targetEntityId: input.link.targetEntityId,
      reason: "Managed target already matches this release.",
    };
  }
  if (input.link && input.linkedTargetExists) {
    return {
      kind: input.kind,
      key: input.key,
      label: input.label,
      action: "update",
      targetEntityId: input.link.targetEntityId,
      reason: "Managed target will be updated from the release.",
    };
  }
  if (input.unmanagedConflict) {
    return {
      kind: input.kind,
      key: input.key,
      label: input.label,
      action: "skip_unmanaged_conflict",
      targetEntityId: input.unmanagedConflict.id,
      reason: input.unmanagedConflict.reason,
    };
  }
  return {
    kind: input.kind,
    key: input.key,
    label: input.label,
    action: "create",
    targetEntityId: null,
    reason: input.link ? "Previous managed target no longer exists; a new managed copy will be created." : null,
  };
}

function scrubAdapterConfig(config: Record<string, unknown>) {
  const next = { ...config };
  delete next.promptTemplate;
  delete next.bootstrapPromptTemplate;
  delete next.instructionsFilePath;
  delete next.instructionsBundleMode;
  delete next.instructionsRootPath;
  delete next.instructionsEntryFile;
  return next;
}

function buildAgentBundleFiles(release: CompanyRolloutRelease, agent: CompanyPortabilityAgentManifestEntry) {
  const prefix = `agents/${agent.slug}/`;
  const out = Object.fromEntries(
    Object.entries(release.files)
      .filter(([filePath]) => normalizePortablePath(filePath).startsWith(prefix))
      .flatMap(([filePath, content]) =>
        typeof content === "string"
          ? [[normalizePortablePath(filePath).slice(prefix.length), content] as const]
          : [],
      ),
  );
  const markdownPath = ensureMarkdownPath(normalizePortablePath(agent.path));
  const markdown = portableText(release.files[markdownPath]);
  if (markdown) {
    const entryRelative = markdownPath.startsWith(prefix) ? markdownPath.slice(prefix.length) : "AGENTS.md";
    const body = parseMarkdownBody(markdown) ?? "";
    out[entryRelative] = body;
    out["AGENTS.md"] = body;
  }
  return out;
}

function actionsForKind(preview: CompanyRolloutTargetPreview, kind: CompanyRolloutEntityKind) {
  return new Map(
    preview.entityActions
      .filter((entry) => entry.kind === kind)
      .map((entry) => [entry.key, entry]),
  );
}

export function companyRolloutService(db: Db) {
  const companies = companyService(db);
  const portability = companyPortabilityService(db);
  const agentsSvc = agentService(db);
  const access = accessService(db);
  const instructions = agentInstructionsService();
  const skills = companySkillService(db);
  const projects = projectService(db);
  const routines = routineService(db);

  async function nextVersion(sourceCompanyId: string) {
    const row = await db
      .select({ version: sql<number>`coalesce(max(${companyRolloutReleases.version}), 0)::int` })
      .from(companyRolloutReleases)
      .where(eq(companyRolloutReleases.sourceCompanyId, sourceCompanyId))
      .then((rows) => rows[0] ?? { version: 0 });
    return Number(row.version ?? 0) + 1;
  }

  async function getReleaseRow(releaseId: string) {
    return db
      .select()
      .from(companyRolloutReleases)
      .where(eq(companyRolloutReleases.id, releaseId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRelease(releaseId: string) {
    const row = await getReleaseRow(releaseId);
    if (!row) throw notFound("Company rollout release not found");
    return toRelease(row);
  }

  async function loadTargetContext(release: CompanyRolloutRelease, company: RolloutTargetCompany): Promise<TargetContext> {
    const [agentRows, skillRows, projectRows, routineRows, linkRows] = await Promise.all([
      agentsSvc.list(company.id),
      skills.listFull(company.id),
      projects.list(company.id),
      routines.list(company.id),
      db
        .select()
        .from(companyRolloutEntityLinks)
        .where(
          and(
            eq(companyRolloutEntityLinks.sourceCompanyId, release.sourceCompanyId),
            eq(companyRolloutEntityLinks.targetCompanyId, company.id),
          ),
        ),
    ]);

    const links = new Map<EntityKey, LinkRow>();
    for (const link of linkRows) {
      links.set(entityKey(link.sourceEntityKind as CompanyRolloutEntityKind, link.sourceEntityKey), link);
    }

    return {
      company,
      links,
      agentsBySlug: new Map(agentRows.map((agent) => [normalizeAgentUrlKey(agent.name) ?? agent.id, agent])),
      agentsById: new Map(agentRows.map((agent) => [agent.id, agent])),
      skillsByKey: new Map(skillRows.map((skill) => [skill.key, skill])),
      skillsBySlug: new Map(skillRows.map((skill) => [normalizeAgentUrlKey(skill.slug) ?? skill.slug, skill])),
      skillsById: new Map(skillRows.map((skill) => [skill.id, skill])),
      projectsBySlug: new Map(projectRows.map((project) => [project.urlKey, project])),
      projectsById: new Map(projectRows.map((project) => [project.id, project])),
      routinesByTitle: new Map(routineRows.map((routine) => [routine.title.trim().toLowerCase(), routine])),
      routinesById: new Map(routineRows.map((routine) => [routine.id, routine])),
    };
  }

  async function resolveTargets(release: CompanyRolloutRelease, selection?: CompanyRolloutTargetSelectionRequest) {
    const allCompanies = await companies.list();
    if (selection?.targetCompanyIds && selection.targetCompanyIds.length > 0) {
      const requested = new Set(selection.targetCompanyIds);
      return allCompanies
        .filter((company) => requested.has(company.id))
        .filter((company) => company.id !== release.sourceCompanyId)
        .filter((company) => company.status !== "archived");
    }
    return allCompanies
      .filter((company) => company.id !== release.sourceCompanyId)
      .filter((company) => company.status === "active");
  }

  function previewTargetFromContext(release: CompanyRolloutRelease, ctx: TargetContext): CompanyRolloutTargetPreview {
    const warnings: string[] = [];
    const entityActions: CompanyRolloutEntityPreview[] = [];

    for (const skill of release.manifest.skills) {
      const key = skill.key;
      const link = ctx.links.get(entityKey("skill", key)) ?? null;
      const hash = sourceHash({ release, kind: "skill", key, entry: skill, paths: skillFilePaths(release, skill) });
      const linkedTargetExists = Boolean(link && ctx.skillsById.has(link.targetEntityId));
      const normalizedSlug = normalizeAgentUrlKey(skill.slug) ?? skill.slug;
      const conflict = ctx.skillsByKey.get(skill.key) ?? ctx.skillsBySlug.get(normalizedSlug) ?? null;
      entityActions.push(entityAction({
        kind: "skill",
        key,
        label: skill.name,
        hash,
        link,
        linkedTargetExists,
        unmanagedConflict: (!link || !linkedTargetExists) && conflict
          ? { id: conflict.id, reason: `Target company already has unmanaged skill "${conflict.name}".` }
          : null,
      }));
    }

    for (const agent of release.manifest.agents) {
      const key = agent.slug;
      const link = ctx.links.get(entityKey("agent", key)) ?? null;
      const hash = sourceHash({ release, kind: "agent", key, entry: agent, paths: agentFilePaths(release, agent) });
      const linkedTargetExists = Boolean(link && ctx.agentsById.has(link.targetEntityId));
      const conflict = ctx.agentsBySlug.get(key) ?? null;
      entityActions.push(entityAction({
        kind: "agent",
        key,
        label: agent.name,
        hash,
        link,
        linkedTargetExists,
        unmanagedConflict: (!link || !linkedTargetExists) && conflict
          ? { id: conflict.id, reason: `Target company already has unmanaged agent "${conflict.name}".` }
          : null,
      }));
    }

    for (const project of release.manifest.projects) {
      const key = project.slug;
      const link = ctx.links.get(entityKey("project", key)) ?? null;
      const hash = sourceHash({ release, kind: "project", key, entry: project, paths: projectFilePaths(release, project) });
      const linkedTargetExists = Boolean(link && ctx.projectsById.has(link.targetEntityId));
      const conflict = ctx.projectsBySlug.get(key) ?? null;
      entityActions.push(entityAction({
        kind: "project",
        key,
        label: project.name,
        hash,
        link,
        linkedTargetExists,
        unmanagedConflict: (!link || !linkedTargetExists) && conflict
          ? { id: conflict.id, reason: `Target company already has unmanaged project "${conflict.name}".` }
          : null,
      }));
    }

    const agentActions = new Map(entityActions.filter((entry) => entry.kind === "agent").map((entry) => [entry.key, entry]));
    const projectActions = new Map(entityActions.filter((entry) => entry.kind === "project").map((entry) => [entry.key, entry]));
    for (const issue of release.manifest.issues) {
      if (!issue.recurring) {
        entityActions.push({
          kind: "issue",
          key: issue.slug,
          label: issue.title,
          action: "skip_no_change",
          targetEntityId: null,
          reason: "One-off tasks are not rewritten by company rollouts.",
        });
        continue;
      }

      const key = issue.slug;
      const link = ctx.links.get(entityKey("routine", key)) ?? null;
      const hash = sourceHash({ release, kind: "routine", key, entry: issue, paths: issueFilePaths(release, issue) });
      const linkedTargetExists = Boolean(link && ctx.routinesById.has(link.targetEntityId));
      const conflict = ctx.routinesByTitle.get(issue.title.trim().toLowerCase()) ?? null;
      const action = entityAction({
        kind: "routine",
        key,
        label: issue.title,
        hash,
        link,
        linkedTargetExists,
        unmanagedConflict: (!link || !linkedTargetExists) && conflict
          ? { id: conflict.id, reason: `Target company already has unmanaged routine "${conflict.title}".` }
          : null,
      });

      if (action.action === "create" || action.action === "update") {
        const projectAction = issue.projectSlug ? projectActions.get(issue.projectSlug) : null;
        const agentAction = issue.assigneeAgentSlug ? agentActions.get(issue.assigneeAgentSlug) : null;
        if (!issue.projectSlug || !projectAction || projectAction.action === "skip_unmanaged_conflict" || projectAction.action === "error") {
          action.action = "error";
          action.reason = `Routine requires rolled-out project "${issue.projectSlug ?? "none"}".`;
        }
        if (!issue.assigneeAgentSlug || !agentAction || agentAction.action === "skip_unmanaged_conflict" || agentAction.action === "error") {
          action.action = "error";
          action.reason = `Routine requires rolled-out assignee "${issue.assigneeAgentSlug ?? "none"}".`;
        }
      }
      entityActions.push(action);
    }

    const errors = entityActions
      .filter((entry) => entry.action === "error")
      .map((entry) => `${entry.kind} ${entry.key}: ${entry.reason ?? "rollout error"}`);
    if (entityActions.some((entry) => entry.action === "skip_unmanaged_conflict")) {
      warnings.push("Unmanaged target content with matching names was skipped.");
    }

    return {
      companyId: ctx.company.id,
      companyName: ctx.company.name,
      companyStatus: ctx.company.status,
      status: errors.length > 0 ? "failed" : "previewed",
      counts: countActions(entityActions),
      warnings,
      errors,
      entityActions,
      updatedAt: null,
    };
  }

  async function persistTargetPreview(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    status = preview.status,
    applyResult?: Record<string, unknown> | null,
  ) {
    const now = new Date();
    await db
      .insert(companyRolloutTargets)
      .values({
        releaseId: release.id,
        sourceCompanyId: release.sourceCompanyId,
        targetCompanyId: preview.companyId,
        status,
        countsJson: preview.counts,
        entityActionsJson: preview.entityActions as unknown as Array<Record<string, unknown>>,
        warningsJson: preview.warnings,
        errorsJson: preview.errors,
        applyResultJson: applyResult ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [companyRolloutTargets.releaseId, companyRolloutTargets.targetCompanyId],
        set: {
          status,
          countsJson: preview.counts,
          entityActionsJson: preview.entityActions as unknown as Array<Record<string, unknown>>,
          warningsJson: preview.warnings,
          errorsJson: preview.errors,
          applyResultJson: applyResult ?? null,
          updatedAt: now,
        },
      });
  }

  async function upsertEntityLink(input: {
    release: CompanyRolloutRelease;
    targetCompanyId: string;
    kind: CompanyRolloutEntityKind;
    key: string;
    hash: string;
    targetEntityType: string;
    targetEntityId: string;
  }) {
    const now = new Date();
    await db
      .insert(companyRolloutEntityLinks)
      .values({
        sourceCompanyId: input.release.sourceCompanyId,
        targetCompanyId: input.targetCompanyId,
        sourceEntityKind: input.kind,
        sourceEntityKey: input.key,
        sourceEntityHash: input.hash,
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        releaseId: input.release.id,
        lastAppliedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          companyRolloutEntityLinks.sourceCompanyId,
          companyRolloutEntityLinks.targetCompanyId,
          companyRolloutEntityLinks.sourceEntityKind,
          companyRolloutEntityLinks.sourceEntityKey,
        ],
        set: {
          sourceEntityHash: input.hash,
          targetEntityType: input.targetEntityType,
          targetEntityId: input.targetEntityId,
          releaseId: input.release.id,
          lastAppliedAt: now,
          updatedAt: now,
        },
      });
  }

  async function previewRelease(
    releaseId: string,
    selection?: CompanyRolloutTargetSelectionRequest,
    actorUserId?: string | null,
  ): Promise<CompanyRolloutPreviewResult> {
    const release = await getRelease(releaseId);
    const targets = await resolveTargets(release, selection);
    const previews: CompanyRolloutTargetPreview[] = [];
    for (const company of targets) {
      const ctx = await loadTargetContext(release, company);
      const preview = previewTargetFromContext(release, ctx);
      previews.push(preview);
      await persistTargetPreview(release, preview);
      await logActivity(db, {
        companyId: company.id,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "company_rollout.previewed",
        entityType: "company_rollout_release",
        entityId: release.id,
        details: {
          sourceCompanyId: release.sourceCompanyId,
          version: release.version,
          counts: preview.counts,
          errorCount: preview.errors.length,
        },
      });
    }
    return { release, targets: previews };
  }

  async function createRelease(
    sourceCompanyId: string,
    input: CompanyRolloutCreateRequest,
    actorUserId?: string | null,
  ): Promise<CompanyRolloutRelease> {
    const exported = await portability.exportBundle(sourceCompanyId, {
      include: { company: true, agents: true, projects: true, issues: true, skills: true },
      selectedFiles: input.selectedFiles,
    });
    const selectedFiles = Object.keys(exported.files).sort();
    const version = await nextVersion(sourceCompanyId);
    const counts = {
      files: selectedFiles.length,
      agents: exported.manifest.agents.length,
      skills: exported.manifest.skills.length,
      projects: exported.manifest.projects.length,
      routines: exported.manifest.issues.filter((issue) => issue.recurring).length,
      issues: exported.manifest.issues.filter((issue) => !issue.recurring).length,
    };
    const packageHash = hashValue({
      manifest: exported.manifest,
      files: exported.files,
      selectedFiles,
      counts,
    });
    const row = await db
      .insert(companyRolloutReleases)
      .values({
        sourceCompanyId,
        version,
        title: input.title,
        notes: input.notes ?? null,
        manifestJson: exported.manifest,
        filesJson: exported.files,
        selectedFiles,
        packageHash,
        countsJson: counts,
        createdByUserId: actorUserId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);
    const release = toRelease(row);
    await logActivity(db, {
      companyId: sourceCompanyId,
      actorType: "user",
      actorId: actorUserId ?? "board",
      action: "company_rollout.created",
      entityType: "company_rollout_release",
      entityId: release.id,
      details: {
        version: release.version,
        title: release.title,
        counts,
        packageHash,
      },
    });
    return release;
  }

  async function listReleases(sourceCompanyId: string): Promise<CompanyRolloutRelease[]> {
    const rows = await db
      .select()
      .from(companyRolloutReleases)
      .where(eq(companyRolloutReleases.sourceCompanyId, sourceCompanyId))
      .orderBy(desc(companyRolloutReleases.version));
    return rows.map(toRelease);
  }

  async function getReleaseDetail(releaseId: string): Promise<CompanyRolloutPreviewResult> {
    const release = await getRelease(releaseId);
    const targetRows = await db
      .select({ target: companyRolloutTargets })
      .from(companyRolloutTargets)
      .where(eq(companyRolloutTargets.releaseId, releaseId))
      .orderBy(desc(companyRolloutTargets.updatedAt));
    const companiesById = new Map((await companies.list()).map((company) => [company.id, company]));
    const targets = targetRows.map(({ target }) => {
      const company = companiesById.get(target.targetCompanyId);
      return {
        companyId: target.targetCompanyId,
        companyName: company?.name ?? target.targetCompanyId,
        companyStatus: company?.status ?? "unknown",
        status: target.status as CompanyRolloutTargetPreview["status"],
        counts: target.countsJson,
        warnings: target.warningsJson ?? [],
        errors: target.errorsJson ?? [],
        entityActions: target.entityActionsJson as unknown as CompanyRolloutEntityPreview[],
        updatedAt: target.updatedAt,
      };
    });
    return { release, targets };
  }

  async function resolveTargetEntityIds(release: CompanyRolloutRelease, ctx: TargetContext): Promise<AppliedEntityIds> {
    const out: AppliedEntityIds = {
      agents: new Map(),
      projects: new Map(),
      routines: new Map(),
      skills: new Map(),
    };
    for (const link of ctx.links.values()) {
      if (link.sourceEntityKind === "agent" && ctx.agentsById.has(link.targetEntityId)) out.agents.set(link.sourceEntityKey, link.targetEntityId);
      if (link.sourceEntityKind === "project" && ctx.projectsById.has(link.targetEntityId)) out.projects.set(link.sourceEntityKey, link.targetEntityId);
      if (link.sourceEntityKind === "routine" && ctx.routinesById.has(link.targetEntityId)) out.routines.set(link.sourceEntityKey, link.targetEntityId);
      if (link.sourceEntityKind === "skill" && ctx.skillsById.has(link.targetEntityId)) out.skills.set(link.sourceEntityKey, link.targetEntityId);
    }
    return out;
  }

  async function applySkills(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    ids: AppliedEntityIds,
  ) {
    const actionByKey = actionsForKind(preview, "skill");
    const selectedSkills = release.manifest.skills.filter((skill) => {
      const action = actionByKey.get(skill.key)?.action;
      return action === "create" || action === "update";
    });
    if (selectedSkills.length === 0) return;
    const allowedPaths = new Set(selectedSkills.flatMap((skill) => skillFilePaths(release, skill)));
    const files = Object.fromEntries(
      Object.entries(pickTextFiles(release.files)).filter(([filePath]) => allowedPaths.has(filePath)),
    );
    const imported = await skills.importPackageFiles(preview.companyId, files, { onConflict: "replace" });
    for (const result of imported) {
      const sourceSkill = selectedSkills.find((skill) => skill.key === result.originalKey || skill.slug === result.originalSlug);
      if (!sourceSkill || result.action === "skipped") continue;
      const hash = sourceHash({ release, kind: "skill", key: sourceSkill.key, entry: sourceSkill, paths: skillFilePaths(release, sourceSkill) });
      ids.skills.set(sourceSkill.key, result.skill.id);
      await upsertEntityLink({
        release,
        targetCompanyId: preview.companyId,
        kind: "skill",
        key: sourceSkill.key,
        hash,
        targetEntityType: "company_skill",
        targetEntityId: result.skill.id,
      });
    }
  }

  async function applyAgents(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    ids: AppliedEntityIds,
    actorUserId?: string | null,
  ) {
    const actionByKey = actionsForKind(preview, "agent");
    const changedAgents = release.manifest.agents.filter((agent) => {
      const action = actionByKey.get(agent.slug)?.action;
      return action === "create" || action === "update";
    });
    for (const manifestAgent of changedAgents) {
      const action = actionByKey.get(manifestAgent.slug);
      const desiredSkills = manifestAgent.skills ?? [];
      const adapterConfig = writePaperclipSkillSyncPreference(
        scrubAdapterConfig(manifestAgent.adapterConfig),
        desiredSkills,
      );
      const patch = {
        name: manifestAgent.name,
        role: manifestAgent.role,
        title: manifestAgent.title,
        icon: manifestAgent.icon,
        capabilities: manifestAgent.capabilities,
        reportsTo: null,
        adapterType: manifestAgent.adapterType,
        adapterConfig,
        runtimeConfig: manifestAgent.runtimeConfig,
        budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
        permissions: manifestAgent.permissions,
        metadata: {
          ...(manifestAgent.metadata ?? {}),
          rolloutSourceCompanyId: release.sourceCompanyId,
          rolloutSourceAgentSlug: manifestAgent.slug,
        },
      };
      const hash = sourceHash({ release, kind: "agent", key: manifestAgent.slug, entry: manifestAgent, paths: agentFilePaths(release, manifestAgent) });
      let agent = action?.targetEntityId
        ? await agentsSvc.update(action.targetEntityId, patch, {
          recordRevision: {
            createdByUserId: actorUserId ?? null,
            source: "company_rollout",
          },
        })
        : null;
      if (!agent) {
        agent = await agentsSvc.create(preview.companyId, patch);
        await access.ensureMembership(preview.companyId, "agent", agent.id, "member", "active");
        await access.setPrincipalPermission(preview.companyId, "agent", agent.id, "tasks:assign", true, actorUserId ?? null);
      }
      const bundleFiles = buildAgentBundleFiles(release, manifestAgent);
      if (Object.keys(bundleFiles).length > 0) {
        const materialized = await instructions.materializeManagedBundle(agent, bundleFiles, {
          clearLegacyPromptTemplate: true,
          replaceExisting: true,
        });
        agent = await agentsSvc.update(agent.id, { adapterConfig: materialized.adapterConfig }) ?? agent;
      }
      ids.agents.set(manifestAgent.slug, agent.id);
      await upsertEntityLink({
        release,
        targetCompanyId: preview.companyId,
        kind: "agent",
        key: manifestAgent.slug,
        hash,
        targetEntityType: "agent",
        targetEntityId: agent.id,
      });
    }

    for (const manifestAgent of release.manifest.agents) {
      const targetAgentId = ids.agents.get(manifestAgent.slug);
      if (!targetAgentId || !manifestAgent.reportsToSlug) continue;
      const managerId = ids.agents.get(manifestAgent.reportsToSlug);
      if (!managerId || managerId === targetAgentId) continue;
      await agentsSvc.update(targetAgentId, { reportsTo: managerId });
    }
  }

  async function applyProjects(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    ids: AppliedEntityIds,
  ) {
    const actionByKey = actionsForKind(preview, "project");
    for (const manifestProject of release.manifest.projects) {
      const action = actionByKey.get(manifestProject.slug);
      if (action?.action !== "create" && action?.action !== "update") continue;
      const patch = {
        name: manifestProject.name,
        description: manifestProject.description,
        leadAgentId: manifestProject.leadAgentSlug ? ids.agents.get(manifestProject.leadAgentSlug) ?? null : null,
        targetDate: manifestProject.targetDate,
        color: manifestProject.color,
        status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
          ? manifestProject.status as typeof PROJECT_STATUSES[number]
          : "backlog",
        env: manifestProject.env,
        executionWorkspacePolicy: manifestProject.executionWorkspacePolicy,
      };
      const hash = sourceHash({ release, kind: "project", key: manifestProject.slug, entry: manifestProject, paths: projectFilePaths(release, manifestProject) });
      const project = action.targetEntityId
        ? await projects.update(action.targetEntityId, patch)
        : await projects.create(preview.companyId, patch);
      if (!project) throw unprocessable(`Project ${manifestProject.slug} could not be applied.`);
      ids.projects.set(manifestProject.slug, project.id);
      await upsertEntityLink({
        release,
        targetCompanyId: preview.companyId,
        kind: "project",
        key: manifestProject.slug,
        hash,
        targetEntityType: "project",
        targetEntityId: project.id,
      });
    }
  }

  async function applyRoutineTriggers(
    routineId: string,
    issue: CompanyPortabilityIssueManifestEntry,
    actorUserId?: string | null,
  ) {
    const routineDefinition = issue.routine ?? {
      concurrencyPolicy: null,
      catchUpPolicy: null,
      variables: null,
      triggers: [],
    };
    for (const trigger of routineDefinition.triggers) {
      if (trigger.kind === "schedule") {
        await routines.createTrigger(routineId, {
          kind: "schedule",
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression!,
          timezone: trigger.timezone!,
        }, { userId: actorUserId ?? null, agentId: null });
        continue;
      }
      if (trigger.kind === "webhook") {
        await routines.createTrigger(routineId, {
          kind: "webhook",
          label: trigger.label,
          enabled: trigger.enabled,
          signingMode: trigger.signingMode && ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
            ? trigger.signingMode as typeof ROUTINE_TRIGGER_SIGNING_MODES[number]
            : "bearer",
          replayWindowSec: trigger.replayWindowSec ?? 300,
        }, { userId: actorUserId ?? null, agentId: null });
        continue;
      }
      await routines.createTrigger(routineId, {
        kind: "api",
        label: trigger.label,
        enabled: trigger.enabled,
      }, { userId: actorUserId ?? null, agentId: null });
    }
  }

  async function applyRoutines(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    ids: AppliedEntityIds,
    actorUserId?: string | null,
  ) {
    const actionByKey = actionsForKind(preview, "routine");
    for (const issue of release.manifest.issues.filter((entry) => entry.recurring)) {
      const action = actionByKey.get(issue.slug);
      if (action?.action !== "create" && action?.action !== "update") continue;
      const markdown = portableText(release.files[ensureMarkdownPath(issue.path)]);
      const description = parseMarkdownBody(markdown) || issue.description || null;
      const routineDefinition = issue.routine ?? {
        concurrencyPolicy: null,
        catchUpPolicy: null,
        variables: null,
        triggers: [],
      };
      const patch = {
        projectId: issue.projectSlug ? ids.projects.get(issue.projectSlug) ?? null : null,
        goalId: null,
        parentIssueId: null,
        title: issue.title,
        description,
        assigneeAgentId: issue.assigneeAgentSlug ? ids.agents.get(issue.assigneeAgentSlug) ?? null : null,
        priority: issue.priority && ISSUE_PRIORITIES.includes(issue.priority as any)
          ? issue.priority as typeof ISSUE_PRIORITIES[number]
          : "medium",
        status: issue.status && ROUTINE_STATUSES.includes(issue.status as any)
          ? issue.status as typeof ROUTINE_STATUSES[number]
          : "active",
        concurrencyPolicy:
          routineDefinition.concurrencyPolicy && ROUTINE_CONCURRENCY_POLICIES.includes(routineDefinition.concurrencyPolicy as any)
            ? routineDefinition.concurrencyPolicy as typeof ROUTINE_CONCURRENCY_POLICIES[number]
            : "coalesce_if_active",
        catchUpPolicy:
          routineDefinition.catchUpPolicy && ROUTINE_CATCH_UP_POLICIES.includes(routineDefinition.catchUpPolicy as any)
            ? routineDefinition.catchUpPolicy as typeof ROUTINE_CATCH_UP_POLICIES[number]
            : "skip_missed",
        variables: routineDefinition.variables ?? [],
      };
      if (!patch.projectId || !patch.assigneeAgentId) {
        throw unprocessable(`Routine ${issue.slug} is missing a target project or assignee.`);
      }
      const hash = sourceHash({ release, kind: "routine", key: issue.slug, entry: issue, paths: issueFilePaths(release, issue) });
      let routineId = action.targetEntityId;
      if (routineId) {
        const detail = await routines.getDetail(routineId);
        if (detail) {
          for (const trigger of detail.triggers) {
            await routines.deleteTrigger(trigger.id);
          }
          const updated = await routines.update(routineId, patch, { userId: actorUserId ?? null, agentId: null });
          routineId = updated?.id ?? null;
        } else {
          routineId = null;
        }
      }
      if (!routineId) {
        const created = await routines.create(preview.companyId, patch, { userId: actorUserId ?? null, agentId: null });
        routineId = created.id;
      }
      await applyRoutineTriggers(routineId, issue, actorUserId);
      ids.routines.set(issue.slug, routineId);
      await upsertEntityLink({
        release,
        targetCompanyId: preview.companyId,
        kind: "routine",
        key: issue.slug,
        hash,
        targetEntityType: "routine",
        targetEntityId: routineId,
      });
    }
  }

  async function applyTarget(
    release: CompanyRolloutRelease,
    preview: CompanyRolloutTargetPreview,
    actorUserId?: string | null,
  ): Promise<CompanyRolloutApplyTargetResult> {
    if (preview.errors.length > 0) {
      return { ...preview, status: "failed", applied: false };
    }
    const company = await companies.getById(preview.companyId);
    if (!company) throw notFound("Target company not found");
    const ctx = await loadTargetContext(release, company);
    const ids = await resolveTargetEntityIds(release, ctx);
    await applySkills(release, preview, ids);
    await applyAgents(release, preview, ids, actorUserId);
    await applyProjects(release, preview, ids);
    await applyRoutines(release, preview, ids, actorUserId);
    return {
      ...preview,
      status: "applied",
      applied: true,
    };
  }

  async function applyRelease(
    releaseId: string,
    selection?: CompanyRolloutTargetSelectionRequest,
    actorUserId?: string | null,
  ): Promise<CompanyRolloutApplyResult> {
    const preview = await previewRelease(releaseId, selection, actorUserId);
    const results: CompanyRolloutApplyTargetResult[] = [];
    for (const targetPreview of preview.targets) {
      try {
        const result = await applyTarget(preview.release, targetPreview, actorUserId);
        results.push(result);
        await persistTargetPreview(preview.release, result, result.status, { applied: result.applied });
        await logActivity(db, {
          companyId: result.companyId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: result.applied ? "company_rollout.applied" : "company_rollout.failed",
          entityType: "company_rollout_release",
          entityId: preview.release.id,
          details: {
            sourceCompanyId: preview.release.sourceCompanyId,
            version: preview.release.version,
            counts: result.counts,
            errors: result.errors,
          },
        });
      } catch (err) {
        const failed: CompanyRolloutApplyTargetResult = {
          ...targetPreview,
          status: "failed",
          applied: false,
          errors: [...targetPreview.errors, err instanceof Error ? err.message : String(err)],
        };
        failed.counts = countActions(failed.entityActions);
        failed.counts.error = Math.max(failed.counts.error, failed.errors.length);
        results.push(failed);
        await persistTargetPreview(preview.release, failed, "failed", { applied: false });
        await logActivity(db, {
          companyId: failed.companyId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: "company_rollout.failed",
          entityType: "company_rollout_release",
          entityId: preview.release.id,
          details: {
            sourceCompanyId: preview.release.sourceCompanyId,
            version: preview.release.version,
            errors: failed.errors,
          },
        });
      }
    }
    return {
      release: preview.release,
      targets: results,
    };
  }

  return {
    createRelease,
    listReleases,
    getReleaseDetail,
    previewRelease,
    applyRelease,
  };
}
