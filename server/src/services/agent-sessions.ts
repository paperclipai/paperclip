import { and, eq, desc, isNull } from "drizzle-orm";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentSessions, agents, projectWorkspaces } from "@paperclipai/db";
import { rebaseHomePath } from "./path-utils.js";

/**
 * Phase 4: durable session entity for a leader agent's Claude CLI.
 *
 * Design ref: docs/cos-v2/phase4-cli-design.md §10.1
 *
 * Core invariants (enforced by DB partial unique index
 * "agent_sessions_one_active_per_agent"):
 *   S1. At most one active session per agent.
 *   S2. ensureActive is idempotent.
 *   S3. archive + ensureActive → new row.
 *   S4. workspace_path is stable across restarts of the same session.
 */
export type AgentSessionRecord = typeof agentSessions.$inferSelect;

export interface AgentSessionService {
  ensureActive(params: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
  }): Promise<AgentSessionRecord>;

  archive(params: {
    sessionId: string;
    reason: string;
  }): Promise<AgentSessionRecord | null>;

  getActive(params: {
    agentId: string;
    projectId?: string | null;
  }): Promise<AgentSessionRecord | null>;

  listByAgent(params: {
    agentId: string;
  }): Promise<AgentSessionRecord[]>;

  getById(params: {
    sessionId: string;
  }): Promise<AgentSessionRecord | null>;
}

/**
 * Build a fallback workspace path for sessions without a project workspace.
 *
 * Stable per (agentId, sessionSuffix) — if the same session is reused
 * across restarts the path is the same, which lets Claude's
 * ~/.claude/projects/<hash(cwd)>/ history auto-restore.
 */
function buildFallbackWorkspacePath(agentId: string, sessionId: string): string {
  const agentShort = agentId.slice(0, 8);
  const sessionShort = sessionId.slice(0, 8);
  return path.join(
    os.homedir(),
    ".cos-v2",
    "leaders",
    `${agentShort}-${sessionShort}`,
  );
}

/**
 * Resolve workspace path: use project_workspace.cwd if project-scoped,
 * otherwise fall back to ~/.cos-v2/leaders/ pattern.
 */
async function resolveWorkspacePath(
  db: Db,
  agentId: string,
  sessionId: string,
  companyId: string,
  projectId: string | null | undefined,
): Promise<string> {
  if (projectId) {
    // Look up the primary workspace for this project — scoped to company
    const [ws] = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.companyId, companyId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      )
      .limit(1);
    if (ws?.cwd) return rebaseHomePath(ws.cwd);

    // Fallback: any workspace with a cwd (still company-scoped)
    const [anyWs] = await db
      .select({ cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.companyId, companyId),
        ),
      )
      .limit(1);
    if (anyWs?.cwd) return rebaseHomePath(anyWs.cwd);
  }
  return buildFallbackWorkspacePath(agentId, sessionId);
}

export function createAgentSessionService(db: Db): AgentSessionService {
  return {
    async ensureActive({ companyId, agentId, projectId }) {
      // Fast path: read the active session for this (agent, project) pair.
      const projectFilter = projectId
        ? eq(agentSessions.projectId, projectId)
        : isNull(agentSessions.projectId);
      const existing = await db
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.agentId, agentId),
            eq(agentSessions.status, "active"),
            projectFilter,
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (projectId) {
          // Ensure workspace path (cwd) is up-to-date
          const currentCwd = await resolveWorkspacePath(db, agentId, existing[0].id, companyId, projectId);
          if (currentCwd !== existing[0].workspacePath || existing[0].claudeProjectDir !== currentCwd) {
            const [updated] = await db
              .update(agentSessions)
              .set({
                workspacePath: currentCwd,
                claudeProjectDir: currentCwd,
                updatedAt: new Date(),
              })
              .where(eq(agentSessions.id, existing[0].id))
              .returning();
            return updated;
          }
        }
        return existing[0];
      }

      // Validate agent belongs to company before creating a session.
      const agent = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!agent[0]) {
        throw Object.assign(new Error(`Agent ${agentId} not found`), { status: 404 });
      }
      if (agent[0].companyId !== companyId) {
        throw Object.assign(
          new Error(`Agent ${agentId} does not belong to this company`),
          { status: 422 },
        );
      }

      // Two-phase insert: pre-generate id so workspace_path is deterministic.
      const newId = crypto.randomUUID();
      const workspacePath = await resolveWorkspacePath(db, agentId, newId, companyId, projectId);

      try {
        const [row] = await db
          .insert(agentSessions)
          .values({
            id: newId,
            companyId,
            agentId,
            projectId: projectId ?? null,
            workspacePath,
            claudeProjectDir: workspacePath,
            status: "active",
          })
          .returning();
        return row;
      } catch (err: any) {
        // Partial unique index collision — another caller raced us to
        // insert the active session. Re-query and return theirs.
        if (err?.code === "23505") {
          const [rowAfterRace] = await db
            .select()
            .from(agentSessions)
            .where(
              and(
                eq(agentSessions.agentId, agentId),
                eq(agentSessions.status, "active"),
                projectFilter,
              ),
            )
            .limit(1);
          if (rowAfterRace) return rowAfterRace;
        }
        throw err;
      }
    },

    async archive({ sessionId, reason }) {
      const [row] = await db
        .update(agentSessions)
        .set({
          status: "archived",
          archivedAt: new Date(),
          archiveReason: reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.status, "active"),
          ),
        )
        .returning();
      return row ?? null;
    },

    async getActive({ agentId, projectId }) {
      const projectFilter = projectId
        ? eq(agentSessions.projectId, projectId)
        : isNull(agentSessions.projectId);
      const [row] = await db
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.agentId, agentId),
            eq(agentSessions.status, "active"),
            projectFilter,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listByAgent({ agentId }) {
      return db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.agentId, agentId))
        .orderBy(desc(agentSessions.createdAt));
    },

    async getById({ sessionId }) {
      const [row] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
  };
}
