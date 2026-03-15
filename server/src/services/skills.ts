import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";

const execFileAsync = promisify(execFile);
import type { Db } from "@paperclipai/db";
import { skills, agentSkillAssignments, agents, approvals } from "@paperclipai/db";
import {
  learnedSkillApprovalPayloadSchema,
  learnedSkillCandidateMetadataSchema,
  type LearnedSkillApprovalPayload,
  type LearnedSkillCandidateMetadata,
  type ResolvedSkill,
  type SkillTier,
  type SkillSourceType,
} from "@paperclipai/shared";
import { readSkillFrontmatter } from "./skill-seeding.js";

type SkillRow = typeof skills.$inferSelect;

interface DiscoveredLocalSkill {
  name: string;
  description: string;
  path: string;
}

const AGENT_SKILLS_SUBDIRS = [".agents/skills", ".claude/skills"];
const LEARNED_SKILL_AUTHORING_NAME = "paperclip-create-skill";

function normalizeSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "learned-skill";
}

function normalizeLearnedCandidateMetadata(
  metadata: Record<string, unknown> | null | undefined,
): LearnedSkillCandidateMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const candidateRaw = (metadata as Record<string, unknown>).learnedCandidate;
  const parsed = learnedSkillCandidateMetadataSchema.safeParse(candidateRaw);
  return parsed.success ? parsed.data : null;
}

function parseLearnedSkillApprovalPayload(payload: unknown): LearnedSkillApprovalPayload | null {
  const parsed = learnedSkillApprovalPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function validateLearnedSkillProvenance(payload: unknown): {
  ok: boolean;
  reason: string | null;
  parsed: LearnedSkillApprovalPayload | null;
} {
  const parsed = parseLearnedSkillApprovalPayload(payload);
  if (!parsed) {
    return { ok: false, reason: "Invalid learned-skill payload shape", parsed: null };
  }
  if (parsed.provenance.authoringSkill !== LEARNED_SKILL_AUTHORING_NAME) {
    return {
      ok: false,
      reason: `Learned skill provenance must use ${LEARNED_SKILL_AUTHORING_NAME}`,
      parsed: null,
    };
  }
  return { ok: true, reason: null, parsed };
}

async function discoverLocalAgentSkills(agentCwd: string): Promise<DiscoveredLocalSkill[]> {
  const results: DiscoveredLocalSkill[] = [];
  const seen = new Set<string>();

  for (const subdir of AGENT_SKILLS_SUBDIRS) {
    const skillsRoot = path.join(agentCwd, subdir);
    const isDir = await fs.stat(skillsRoot).then((s) => s.isDirectory()).catch(() => false);
    if (!isDir) continue;

    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const skillPath = path.join(skillsRoot, entry.name);
      const hasSKILL = await fs.stat(path.join(skillPath, "SKILL.md")).catch(() => null);
      if (!hasSKILL) continue;
      seen.add(entry.name);
      const meta = await readSkillFrontmatter(skillPath);
      results.push({ name: meta.name, description: meta.description, path: skillPath });
    }
  }

  return results;
}

interface CreateSkillInput {
  name: string;
  description?: string | null;
  tier: SkillTier;
  defaultEnabled?: boolean;
  agentId?: string | null;
  sourceType: SkillSourceType;
  sourceUrl?: string | null;
  installedPath: string;
  metadata?: Record<string, unknown> | null;
}

export function skillService(db: Db) {
  async function list(companyId: string): Promise<SkillRow[]> {
    return db.select().from(skills).where(eq(skills.companyId, companyId));
  }

  async function getById(id: string): Promise<SkillRow | null> {
    const rows = await db.select().from(skills).where(eq(skills.id, id));
    return rows[0] ?? null;
  }

  async function getByName(companyId: string, name: string): Promise<SkillRow | null> {
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.companyId, companyId), eq(skills.name, name)));
    return rows[0] ?? null;
  }

  async function create(companyId: string, input: CreateSkillInput): Promise<SkillRow> {
    const [row] = await db
      .insert(skills)
      .values({
        companyId,
        name: input.name,
        description: input.description ?? null,
        tier: input.tier,
        defaultEnabled: input.defaultEnabled ?? true,
        agentId: input.agentId ?? null,
        sourceType: input.sourceType,
        sourceUrl: input.sourceUrl ?? null,
        installedPath: input.installedPath,
        metadata: input.metadata ?? null,
      })
      .returning();
    return row!;
  }

  async function remove(id: string): Promise<boolean> {
    const rows = await db.delete(skills).where(eq(skills.id, id)).returning();
    return rows.length > 0;
  }

  function resolveAgentCwd(agent: typeof agents.$inferSelect): string | null {
    const config = agent.adapterConfig as Record<string, unknown> | null;
    if (!config) return null;
    const cwd = config.cwd;
    return typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
  }

  function localSkillToRow(skill: DiscoveredLocalSkill, companyId: string, agentId: string): SkillRow {
    return {
      id: `local:${agentId}:${skill.name}`,
      companyId,
      name: skill.name,
      description: skill.description || null,
      tier: "agent",
      defaultEnabled: true,
      agentId,
      sourceType: "local",
      sourceUrl: null,
      installedPath: skill.path,
      metadata: { discoveredFromFilesystem: true },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async function listForAgent(agentId: string): Promise<SkillRow[]> {
    const agentRows = await db.select().from(agents).where(eq(agents.id, agentId));
    const agent = agentRows[0];
    if (!agent) return [];

    const companyId = agent.companyId;

    const allBuiltIn = await db
      .select()
      .from(skills)
      .where(and(eq(skills.companyId, companyId), eq(skills.tier, "built_in")));

    const coreBuiltIn = allBuiltIn.filter((s) => s.defaultEnabled);
    const optionalBuiltIn = allBuiltIn.filter((s) => !s.defaultEnabled);

    const assignments = await db
      .select({ skillId: agentSkillAssignments.skillId })
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.agentId, agentId));
    const assignedIds = new Set(assignments.map((a) => a.skillId));

    const assignedOptionalBuiltIn = optionalBuiltIn.filter((s) => assignedIds.has(s.id));

    let companyAssigned: SkillRow[] = [];
    const companyAssignedIds = assignments
      .map((a) => a.skillId)
      .filter((id) => !optionalBuiltIn.some((s) => s.id === id));
    if (companyAssignedIds.length > 0) {
      companyAssigned = await db
        .select()
        .from(skills)
        .where(and(eq(skills.tier, "company"), inArray(skills.id, companyAssignedIds)));
    }

    const agentDbSkills = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tier, "agent"), eq(skills.agentId, agentId)));
    const visibleAgentDbSkills = agentDbSkills.filter((row) => {
      const candidate = normalizeLearnedCandidateMetadata(row.metadata ?? null);
      if (!candidate) return true;
      return candidate.state === "approved";
    });

    const dbSkillNames = new Set([
      ...coreBuiltIn.map((s) => s.name),
      ...assignedOptionalBuiltIn.map((s) => s.name),
      ...companyAssigned.map((s) => s.name),
      ...visibleAgentDbSkills.map((s) => s.name),
    ]);

    let localSkills: SkillRow[] = [];
    const agentCwd = resolveAgentCwd(agent);
    if (agentCwd) {
      const discovered = await discoverLocalAgentSkills(agentCwd);
      localSkills = discovered
        .filter((s) => !dbSkillNames.has(s.name))
        .map((s) => localSkillToRow(s, companyId, agentId));
    }

    return [
      ...coreBuiltIn,
      ...assignedOptionalBuiltIn,
      ...companyAssigned,
      ...visibleAgentDbSkills,
      ...localSkills,
    ];
  }

  async function assignToAgent(agentId: string, skillId: string, companyId: string): Promise<void> {
    await db
      .insert(agentSkillAssignments)
      .values({ agentId, skillId, companyId })
      .onConflictDoNothing();
  }

  async function unassignFromAgent(agentId: string, skillId: string): Promise<void> {
    await db
      .delete(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.agentId, agentId),
          eq(agentSkillAssignments.skillId, skillId),
        ),
      );
  }

  async function listAssignmentsForAgent(agentId: string) {
    return db
      .select()
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.agentId, agentId));
  }

  async function resolveForExecution(agentId: string): Promise<ResolvedSkill[]> {
    const allSkills = await listForAgent(agentId);
    return allSkills.map((row) => ({
      name: row.name,
      tier: row.tier as ResolvedSkill["tier"],
      path: row.installedPath,
    }));
  }

  async function seedBuiltInSkills(companyId: string, builtInSkillDefs: { name: string; description: string; path: string; defaultEnabled?: boolean }[]): Promise<void> {
    for (const def of builtInSkillDefs) {
      const existing = await getByName(companyId, def.name);
      if (existing) {
        if (existing.defaultEnabled !== (def.defaultEnabled ?? true)) {
          await db
            .update(skills)
            .set({ defaultEnabled: def.defaultEnabled ?? true })
            .where(eq(skills.id, existing.id));
        }
        continue;
      }
      await create(companyId, {
        name: def.name,
        description: def.description,
        tier: "built_in",
        defaultEnabled: def.defaultEnabled ?? true,
        sourceType: "bundled",
        installedPath: def.path,
      });
    }
  }

  function resolveInstallDir(tier: string, agentId: string | null): string {
    if (tier === "agent" && agentId) {
      const agentRows = db.select().from(agents).where(eq(agents.id, agentId));
      // Synchronous path resolution isn't possible here, so we handle it in the async wrapper
      throw new Error("Use resolveInstallDirAsync for agent tier");
    }
    const paperclipHome = process.env.PAPERCLIP_DATA_DIR ||
      path.join(os.homedir(), ".paperclip", "instances", "default");
    return path.join(paperclipHome, "skills");
  }

  async function resolveInstallDirAsync(tier: string, agentId: string | null | undefined, explicitDir: string | null | undefined): Promise<string> {
    if (explicitDir && explicitDir.trim().length > 0) {
      const dir = explicitDir.trim();
      await fs.mkdir(dir, { recursive: true });
      return dir;
    }

    if (tier === "agent" && agentId) {
      const agentRows = await db.select().from(agents).where(eq(agents.id, agentId));
      const agent = agentRows[0];
      if (!agent) throw new Error(`Agent ${agentId} not found`);
      const cwd = resolveAgentCwd(agent);
      if (!cwd) throw new Error(`Agent ${agentId} has no working directory configured`);
      const dir = path.join(cwd, ".agents", "skills");
      await fs.mkdir(dir, { recursive: true });
      return dir;
    }

    const paperclipHome = process.env.PAPERCLIP_DATA_DIR ||
      path.join(os.homedir(), ".paperclip", "instances", "default");
    const dir = path.join(paperclipHome, "skills");
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async function scanForNewSkills(dir: string, knownBefore: Set<string>): Promise<{ name: string; description: string; path: string }[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const results: { name: string; description: string; path: string }[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (knownBefore.has(entry.name)) continue;
      const skillPath = path.join(dir, entry.name);
      const hasSKILL = await fs.stat(path.join(skillPath, "SKILL.md")).catch(() => null);
      if (!hasSKILL) continue;
      const meta = await readSkillFrontmatter(skillPath);
      results.push({ name: meta.name, description: meta.description, path: skillPath });
    }
    return results;
  }

  async function installViaCommand(
    companyId: string,
    command: string,
    opts: { tier?: string; agentId?: string | null; targetDir?: string | null },
  ): Promise<{ installed: SkillRow[]; stdout: string; stderr: string }> {
    const tier = (opts.tier ?? "company") as SkillTier;
    const targetDir = await resolveInstallDirAsync(tier, opts.agentId, opts.targetDir);

    const existingEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => []);
    const knownBefore = new Set(existingEntries.filter((e) => e.isDirectory()).map((e) => e.name));

    const parts = command.trim().split(/\s+/);
    const cmd = parts[0]!;
    const args = parts.slice(1);

    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: targetDir,
      timeout: 60_000,
      env: { ...process.env, HOME: os.homedir(), PATH: process.env.PATH },
    });

    const newSkills = await scanForNewSkills(targetDir, knownBefore);

    const installed: SkillRow[] = [];
    for (const skill of newSkills) {
      const existing = await getByName(companyId, skill.name);
      if (existing) continue;
      const row = await create(companyId, {
        name: skill.name,
        description: skill.description,
        tier,
        agentId: opts.agentId ?? null,
        sourceType: "local",
        sourceUrl: command,
        installedPath: skill.path,
        metadata: { installedViaCommand: command },
      });
      installed.push(row);
    }

    return { installed, stdout, stderr };
  }

  async function createLearnedCandidate(input: {
    companyId: string;
    agentId: string;
    skillName: string;
    summary: string;
    draftSkillContent: string;
    confidence: number | null;
    sourceRunId: string;
    sourceChatSessionId: string | null;
    sourceChatMessageId: string | null;
    provenance: {
      authoringSkill: "paperclip-create-skill";
      authoringMethod?: string | null;
      evidence?: string | null;
    };
    requestedByAgentId?: string | null;
  }) {
    const normalizedName = normalizeSlug(input.skillName);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const installRoot = path.join(
      process.env.PAPERCLIP_DATA_DIR || path.join(os.homedir(), ".paperclip", "instances", "default"),
      "skills",
      "learned-candidates",
      input.companyId,
      `${normalizedName}-${timestamp}`,
    );
    await fs.mkdir(installRoot, { recursive: true });
    const installedPath = installRoot;
    await fs.writeFile(
      path.join(installRoot, "SKILL.md"),
      input.draftSkillContent.endsWith("\n") ? input.draftSkillContent : `${input.draftSkillContent}\n`,
      "utf8",
    );

    const requestedAt = new Date();
    const initialCandidate: LearnedSkillCandidateMetadata = {
      state: "pending_board",
      summary: input.summary,
      confidence: input.confidence,
      sourceRunId: input.sourceRunId,
      sourceChatSessionId: input.sourceChatSessionId,
      sourceChatMessageId: input.sourceChatMessageId,
      approvalId: null,
      provenance: input.provenance,
      draftSkillContent: input.draftSkillContent,
      requestedAt: requestedAt.toISOString(),
      reviewedAt: null,
      reviewedByUserId: null,
    };

    let uniqueName = `${normalizedName}-${input.sourceRunId.slice(0, 8)}`;
    const existingByName = await getByName(input.companyId, uniqueName);
    if (existingByName) {
      uniqueName = `${uniqueName}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const createdSkill = await create(input.companyId, {
      name: uniqueName,
      description: input.summary,
      tier: "agent",
      agentId: input.agentId,
      defaultEnabled: false,
      sourceType: "local",
      sourceUrl: null,
      installedPath,
      metadata: {
        learnedCandidate: initialCandidate,
      },
    });

    const approvalPayload: LearnedSkillApprovalPayload = {
      skillId: createdSkill.id,
      skillName: uniqueName,
      tier: "agent",
      agentId: input.agentId,
      summary: input.summary,
      confidence: input.confidence,
      sourceRunId: input.sourceRunId,
      sourceChatSessionId: input.sourceChatSessionId,
      sourceChatMessageId: input.sourceChatMessageId,
      provenance: input.provenance,
      draftSkillContent: input.draftSkillContent,
    };

    const validation = validateLearnedSkillProvenance(approvalPayload);
    if (!validation.ok || !validation.parsed) {
      throw new Error(validation.reason ?? "Invalid learned-skill provenance");
    }

    const [approval] = await db
      .insert(approvals)
      .values({
        companyId: input.companyId,
        type: "learned_skill",
        status: "pending",
        requestedByAgentId: input.requestedByAgentId ?? input.agentId,
        requestedByUserId: null,
        payload: validation.parsed as unknown as Record<string, unknown>,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
      })
      .returning();

    if (!approval) {
      throw new Error("Failed to create learned-skill approval");
    }

    const mergedMetadata: Record<string, unknown> = {
      ...(createdSkill.metadata ?? {}),
      learnedCandidate: {
        ...initialCandidate,
        approvalId: approval.id,
      },
    };

    const [updatedSkill] = await db
      .update(skills)
      .set({
        metadata: mergedMetadata,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, createdSkill.id))
      .returning();

    return {
      skill: updatedSkill ?? createdSkill,
      approval,
    };
  }

  async function applyLearnedApprovalResolution(input: {
    approval: typeof approvals.$inferSelect;
    targetStatus: "approved" | "rejected" | "revision_requested" | "resubmitted";
    decidedByUserId?: string | null;
    reviewedAt?: Date;
  }) {
    if (input.approval.type !== "learned_skill") return null;
    const validation = validateLearnedSkillProvenance(input.approval.payload);
    if (!validation.ok || !validation.parsed) {
      throw new Error(validation.reason ?? "Invalid learned-skill provenance");
    }

    const payload = validation.parsed;
    const row = await getById(payload.skillId);
    if (!row) return null;
    if (row.companyId !== input.approval.companyId) {
      throw new Error("Learned-skill approval does not match skill company");
    }

    const existingCandidate = normalizeLearnedCandidateMetadata(row.metadata ?? null);
    const current = existingCandidate ?? {
      state: "pending_board",
      summary: payload.summary,
      confidence: payload.confidence,
      sourceRunId: payload.sourceRunId,
      sourceChatSessionId: payload.sourceChatSessionId,
      sourceChatMessageId: payload.sourceChatMessageId,
      approvalId: input.approval.id,
      provenance: payload.provenance,
      draftSkillContent: payload.draftSkillContent,
      requestedAt: new Date().toISOString(),
      reviewedAt: null,
      reviewedByUserId: null,
    };

    const nextState =
      input.targetStatus === "approved"
        ? "approved"
        : input.targetStatus === "rejected"
          ? "rejected"
          : input.targetStatus === "revision_requested"
            ? "revision_requested"
            : "pending_board";

    const nextCandidate: LearnedSkillCandidateMetadata = {
      ...current,
      state: nextState,
      approvalId: input.approval.id,
      reviewedAt:
        input.targetStatus === "resubmitted"
          ? null
          : (input.reviewedAt ?? new Date()).toISOString(),
      reviewedByUserId:
        input.targetStatus === "resubmitted" ? null : (input.decidedByUserId ?? null),
    };

    const nextMetadata: Record<string, unknown> = {
      ...(row.metadata ?? {}),
      learnedCandidate: nextCandidate,
    };

    const [updated] = await db
      .update(skills)
      .set({
        metadata: nextMetadata,
        defaultEnabled: nextState === "approved" ? true : row.defaultEnabled,
        updatedAt: new Date(),
      })
      .where(eq(skills.id, row.id))
      .returning();
    return updated ?? row;
  }

  return {
    list,
    getById,
    getByName,
    create,
    remove,
    listForAgent,
    assignToAgent,
    unassignFromAgent,
    listAssignmentsForAgent,
    resolveForExecution,
    seedBuiltInSkills,
    installViaCommand,
    createLearnedCandidate,
    applyLearnedApprovalResolution,
    validateLearnedSkillProvenance,
  };
}
