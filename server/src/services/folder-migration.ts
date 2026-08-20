import type { Db } from "@paperclipai/db";
import { agents as agentsTable, agentFolders } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import type { AgentFolder } from "@paperclipai/shared";
import type { MigrationResult, InheritanceValidationResult } from "@paperclipai/shared";
import { agentFolderService } from "./agent-folders.js";
import {
  writeAgentFolderPointerFile,
  resolveFolderInstructionsDir,
} from "./agent-instructions-inheritance.js";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Service for migrating agents from a flat (no folder) organization
 * into the hierarchical folder structure.
 */
export class FolderMigrationService {
  constructor(private db: Db) {}

  /** Migrate agents grouped by `role` into role-based folders. Idempotent. */
  async migrateByRole(companyId: string): Promise<MigrationResult> {
    const agents = await this.db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        role: agentsTable.role,
        adapterConfig: agentsTable.adapterConfig,
        adapterType: agentsTable.adapterType,
        metadata: agentsTable.metadata,
      })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.companyId, companyId),
          isNull(agentsTable.folderId),
        ),
      );

    // Group agents by role
    const groups = new Map<string, typeof agents>();
    for (const agent of agents) {
      const role = agent.role ?? "general";
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role)!.push(agent);
    }

    const created: string[] = [];
    const svc = agentFolderService(this.db);
    for (const [role, roleAgents] of groups) {
      const slug = this.slugify(role);

      // Check if a folder with this slug already exists at root level
      const existing = await svc.list(companyId);
      const folderExists = existing.folders.some(
        (f) => f.slug === slug && f.parentId === null,
      );

      let folder: AgentFolder;
      if (folderExists) {
        folder = existing.folders.find(
          (f) => f.slug === slug && f.parentId === null,
        )!;
      } else {
        folder = await svc.create(companyId, {
          name: role,
          slug,
          metadata: { role },
        });
        created.push(folder.id);
      }

      for (const agent of roleAgents) {
        await this.db
          .update(agentsTable)
          .set({ folderId: folder.id, updatedAt: new Date() })
          .where(eq(agentsTable.id, agent.id));

        await writeAgentFolderPointerFile(
          {
            id: agent.id,
            companyId,
            name: agent.name,
            adapterConfig: agent.adapterConfig ?? {},
            adapterType: agent.adapterType,
            folderId: folder.id,
          },
          folder.id,
        );
      }
    }

    return {
      totalUnassigned: agents.length,
      groupsCreated: Array.from(groups.keys()),
      foldersCreated: created,
      foldersReused: groups.size - created.length,
    };
  }

  /** Migrate agents grouped by a metadata key (e.g. "team", "project"). */
  async migrateByMetadataKey(
    companyId: string,
    metadataKey: string,
  ): Promise<MigrationResult> {
    const agents = await this.db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        role: agentsTable.role,
        adapterConfig: agentsTable.adapterConfig,
        adapterType: agentsTable.adapterType,
        metadata: agentsTable.metadata,
      })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.companyId, companyId),
          isNull(agentsTable.folderId),
        ),
      );

    const groups = new Map<string, typeof agents>();
    for (const agent of agents) {
      const meta = (agent.metadata ?? {}) as Record<string, unknown>;
      const groupValue = meta[metadataKey];
      const groupKey =
        typeof groupValue === "string" && groupValue
          ? groupValue
          : "unspecified";
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push(agent);
    }

    const created: string[] = [];
    const svc = agentFolderService(this.db);
    for (const [groupKey, groupAgents] of groups) {
      const slug = this.slugify(groupKey);
      const folder = await svc.create(companyId, {
        name: groupKey,
        slug,
        metadata: { [metadataKey]: groupKey },
      });
      created.push(folder.id);

      for (const agent of groupAgents) {
        await this.db
          .update(agentsTable)
          .set({ folderId: folder.id, updatedAt: new Date() })
          .where(eq(agentsTable.id, agent.id));

        await writeAgentFolderPointerFile(
          {
            id: agent.id,
            companyId,
            name: agent.name,
            adapterConfig: agent.adapterConfig ?? {},
            adapterType: agent.adapterType,
            folderId: folder.id,
          },
          folder.id,
        );
      }
    }

    return {
      totalUnassigned: agents.length,
      groupsCreated: Array.from(groups.keys()),
      foldersCreated: created,
      foldersReused: 0,
    };
  }

  /** Migrate a specific list of agent IDs into a named folder. */
  async migrateToCustomFolder(
    companyId: string,
    folderName: string,
    agentIds: string[],
  ): Promise<MigrationResult> {
    const svc = agentFolderService(this.db);
    const folder = await svc.create(companyId, {
      name: folderName,
      slug: this.slugify(folderName),
      metadata: { migration: true },
    });

    for (const agentId of agentIds) {
      const [agent] = await this.db
        .select({
          id: agentsTable.id,
          name: agentsTable.name,
          adapterConfig: agentsTable.adapterConfig,
          adapterType: agentsTable.adapterType,
        })
        .from(agentsTable)
        .where(
          and(
            eq(agentsTable.id, agentId),
            eq(agentsTable.companyId, companyId),
          ),
        )
        .limit(1);

      if (!agent) continue;

      await this.db
        .update(agentsTable)
        .set({ folderId: folder.id, updatedAt: new Date() })
        .where(eq(agentsTable.id, agent.id));

      await writeAgentFolderPointerFile(
        {
          id: agent.id,
          companyId,
          name: agent.name,
          adapterConfig: agent.adapterConfig ?? {},
          adapterType: agent.adapterType,
          folderId: folder.id,
        },
        folder.id,
      );
    }

    return {
      totalUnassigned: agentIds.length,
      groupsCreated: [folderName],
      foldersCreated: [folder.id],
      foldersReused: 0,
    };
  }

  /** Get a summary of unassigned agents for a company. */
  async getUnassignedSummary(companyId: string): Promise<{
    total: number;
    roleGroups: Record<string, number>;
  }> {
    const agents = await this.db
      .select({ role: agentsTable.role })
      .from(agentsTable)
      .where(
        and(
          eq(agentsTable.companyId, companyId),
          isNull(agentsTable.folderId),
        ),
      );

    const roleGroups: Record<string, number> = {};
    for (const agent of agents) {
      const role = agent.role ?? "general";
      roleGroups[role] = (roleGroups[role] ?? 0) + 1;
    }

    return { total: agents.length, roleGroups };
  }

  /**
   * Validate the agent-folder inheritance chain for a company.
   *
   * Checks for:
   * - Broken folder references (agents pointing to folders that don't exist)
   * - Broken folder chains (folders referencing missing parents)
   * - Cycles in the folder hierarchy
   * - Missing folder-level instruction files (AGENTS.md)
   * - Conflicting external + folder instructions
   * - Misaligned managed instructions roots
   */
  async validateInheritance(companyId: string): Promise<InheritanceValidationResult> {
    // Fetch all agents for the company (with folder_id)
    const allAgents = await this.db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        role: agentsTable.role,
        folderId: agentsTable.folderId,
        adapterConfig: agentsTable.adapterConfig,
        adapterType: agentsTable.adapterType,
        companyId: agentsTable.companyId,
      })
      .from(agentsTable)
      .where(eq(agentsTable.companyId, companyId));

    // Fetch all folders for the company
    const allFolders = await this.db
      .select({
        id: agentFolders.id,
        name: agentFolders.name,
        parentId: agentFolders.parentId,
        slug: agentFolders.slug,
      })
      .from(agentFolders)
      .where(eq(agentFolders.companyId, companyId));

    const folderMap = new Map(allFolders.map((f) => [f.id, f]));
    const agentsInFolders = allAgents.filter((a) => a.folderId !== null);
    const agentsUnassigned = allAgents.filter((a) => a.folderId === null);

    const brokenFolderReferences: InheritanceValidationResult["brokenFolderReferences"] = [];
    const missingFolderInstructions: InheritanceValidationResult["missingFolderInstructions"] = [];
    const conflictingExternalFolderInstructions: InheritanceValidationResult["conflictingExternalFolderInstructions"] = [];
    const misalignedInstructionsRoots: InheritanceValidationResult["misalignedInstructionsRoots"] = [];

    // Helper: detect a cycle starting from a given folderId
    function detectCycle(startId: string): string[] | null {
      const visiting = new Set<string>();
      const path: string[] = [];
      let current: string | null = startId;
      while (current) {
        if (visiting.has(current)) {
          // Found cycle — extract the cycle portion
          const cycleStart = path.indexOf(current);
          if (cycleStart >= 0) {
            return [...path.slice(cycleStart), current];
          }
          return path;
        }
        visiting.add(current);
        path.push(current);
        const folder = folderMap.get(current);
        if (!folder) break;
        current = folder.parentId;
      }
      return null;
    }

    // Check each agent's folder reference
    for (const agent of agentsInFolders) {
      const folderId = agent.folderId!;
      const folder = folderMap.get(folderId);
      if (!folder) {
        brokenFolderReferences.push({
          agentId: agent.id,
          agentName: agent.name,
          folderId,
          reason: "folder_not_found",
        });
        continue;
      }

      // Check for missing folder-level instructions
      const instructionsDir = resolveFolderInstructionsDir(agent.companyId, folderId);
      let entryPathExists = false;
      try {
        const entryStat = await fs.stat(path.join(instructionsDir, "AGENTS.md"));
        entryPathExists = entryStat.isFile();
      } catch {
        entryPathExists = false;
      }

      if (!entryPathExists) {
        missingFolderInstructions.push({
          agentId: agent.id,
          agentName: agent.name,
          folderId,
          folderName: folder.name,
          instructionsDir,
        });
      }

      // Check for conflicting external + folder instructions
      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const instructionsFilePath = config.instructionsFilePath as string | undefined;
      const hasExternalInstructions =
        (instructionsFilePath && instructionsFilePath.trim() !== "") ||
        Boolean(config.promptTemplate);
      if (hasExternalInstructions && entryPathExists) {
        conflictingExternalFolderInstructions.push({
          agentId: agent.id,
          agentName: agent.name,
          folderId,
          folderName: folder.name,
        });
      }
    }

    // Check folder chains for broken parents and cycles
    const brokenFolderChains: InheritanceValidationResult["brokenFolderChains"] = [];
    const folderCycles: InheritanceValidationResult["folderCycles"] = [];
    const seenCycles = new Set<string>();

    for (const folder of allFolders) {
      // Check parent exists
      if (folder.parentId) {
        const parent = folderMap.get(folder.parentId);
        if (!parent) {
          brokenFolderChains.push({
            folderId: folder.id,
            folderName: folder.name,
            reason: "missing_parent",
          });
        }
      }

      // Check for cycles
      const cycle = detectCycle(folder.id);
      if (cycle) {
        const cycleKey = cycle.join("->");
        if (!seenCycles.has(cycleKey)) {
          seenCycles.add(cycleKey);
          folderCycles.push({
            folderId: folder.id,
            chain: cycle,
          });
          brokenFolderChains.push({
            folderId: folder.id,
            folderName: folder.name,
            reason: "cycle",
          });
        }
      }
    }

    // Check misaligned instructions roots (managed mode pointing outside folder dir)
    for (const agent of agentsInFolders) {
      const folder = folderMap.get(agent.folderId!);
      if (!folder) continue; // already reported as broken ref

      const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const rootPath = config.instructionsRootPath as string | undefined;
      if (rootPath) {
        const expectedRoot = resolveFolderInstructionsDir(companyId, folder.id);
        const resolvedRoot = path.resolve(rootPath);
        if (resolvedRoot !== expectedRoot && !resolvedRoot.startsWith(expectedRoot + path.sep)) {
          misalignedInstructionsRoots.push({
            agentId: agent.id,
            agentName: agent.name,
            folderId: folder.id,
            folderName: folder.name,
            configuredRoot: resolvedRoot,
            expectedRoot,
          });
        }
      }
    }

    const issueCount =
      brokenFolderReferences.length +
      brokenFolderChains.length +
      folderCycles.length +
      missingFolderInstructions.length +
      conflictingExternalFolderInstructions.length +
      misalignedInstructionsRoots.length;

    return {
      totalAgents: allAgents.length,
      agentsInFolders: agentsInFolders.length,
      agentsUnassigned: agentsUnassigned.length,
      brokenFolderReferences,
      brokenFolderChains,
      folderCycles,
      missingFolderInstructions,
      conflictingExternalFolderInstructions,
      misalignedInstructionsRoots,
      issueCount,
    };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|]+$/g, "")
      .substring(0, 64);
  }
}

/** Re-export types from @paperclipai/shared for convenience */
export type { MigrationResult, InheritanceValidationResult };

/** Migration operation result — re-exported from @paperclipai/shared */

/**
 * Migrate agents from flat (folder_id = NULL) into role-based folders.
 * Idempotent: agents with existing folderId are skipped.
 */
export async function migrateFlatAgentsByRole(
  db: Db,
  companyId: string,
): Promise<MigrationResult> {
  const migration = new FolderMigrationService(db);
  return migration.migrateByRole(companyId);
}

export const folderMigrationService = (db: Db): FolderMigrationService => new FolderMigrationService(db);
