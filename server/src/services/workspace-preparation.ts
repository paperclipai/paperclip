import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { parseObject, asString } from "../adapters/utils.js";

export type WorkspacePreparationResult = {
  workspacePath: string;          // The resolved and verified directory path
  wasCreated: boolean;            // Whether this execution created a new directory
  sentinelVerified: boolean;      // Whether the writability sentinel check passed
  errors?: string[];              // Non-fatal warnings (e.g., sentinel cleanup failed)
  fatalError?: string;            // If the directory is unusable, a human-readable error
};

class WorkspacePreparationService {
  /**
   * Sanitizes a path segment to be alphanumeric + dash/underscore, lowercase.
   */
    private sanitizeSlugPart(part: string | null | undefined): string {
      const normalized = part ?? "";
      return normalized
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+|-+$/g, "");
    }

  /**
   * Prepares the execution workspace directory.
   * Detects existing directories, creates them if missing, and validates writability.
   */
  async prepareWorkspace(params: {
    companyId: string;
    agentId: string;
    runId: string;
    instanceRoot: string;
    executionWorkspaceCwd: string | null;
  }): Promise<WorkspacePreparationResult> {
    const { companyId, agentId, runId, instanceRoot, executionWorkspaceCwd } = params;

    const safeCompanyId = this.sanitizeSlugPart(companyId);
    const safeAgentId = this.sanitizeSlugPart(agentId);
    const safeRunId = runId; // runId (ULID/UUID) is already safe

    const expectedPath = path.resolve(
      instanceRoot,
      "workspaces",
      safeCompanyId,
      safeAgentId,
      safeRunId,
    );

    // 1. Detection (WSPC-01)
    if (executionWorkspaceCwd) {
      try {
        const stats = await fs.stat(executionWorkspaceCwd);
        if (stats.isDirectory()) {
          // Already exists. Check for drift.
          if (executionWorkspaceCwd !== expectedPath) {
            // Logged as warning in heartbeat.ts if needed, but here we just mark as not created.
          }
          return this.verifyWritability(executionWorkspaceCwd);
        }
      } catch (e) {
        // Not found or inaccessible, proceed to creation logic
      }
    }

    // 2. Path Resolution & Creation (WSPC-02)
    try {
      // Guard against creating workspace inside project workspace tree (security/overlap)
      // This check is simplified: we ensure the path doesn't overlap with a common 
      // project root if we had one passed in. Since we only have instanceRoot, 
      // we ensure the workspace is indeed under the instanceRoot/workspaces tree.
      if (!expectedPath.startsWith(path.resolve(instanceRoot, "workspaces"))) {
        return {
          workspacePath: expectedPath,
          wasCreated: false,
          sentinelVerified: false,
          fatalError: "Computed workspace path is outside the allowed instance workspace root.",
        };
      }

      await fs.mkdir(expectedPath, { recursive: true });
      const result = await this.verifyWritability(expectedPath);
      return {
        ...result,
        wasCreated: true,
      };
    } catch (error: any) {
      if (error.code === "EEXIST") {
        // Handle race condition where mkdir failed but it's actually a directory
        try {
          const stats = await fs.stat(expectedPath);
          if (stats.isDirectory()) {
            return this.verifyWritability(expectedPath);
          }
        } catch {
          // ignore
        }
      }
      
      return {
        workspacePath: expectedPath,
        wasCreated: false,
        sentinelVerified: false,
        fatalError: `Failed to create workspace directory: ${error.message}`,
      };
    }
  }

  private async verifyWritability(workspacePath: string): Promise<WorkspacePreparationResult> {
    const sentinelPath = path.join(workspacePath, ".paperclip-writable");
    const errors: string[] = [];

    try {
      // 3. Permission Validation (WSPC-03)
      await fs.writeFile(sentinelPath, "verified", { mode: 0o644 });
      
      // Clean up
      try {
        await fs.rm(sentinelPath, { force: true });
      } catch (cleanupError: any) {
        errors.push(`Sentinel cleanup failed: ${cleanupError.message}`);
      }

      return {
        workspacePath,
        wasCreated: false,
        sentinelVerified: true,
        errors,
      };
    } catch (error: any) {
      return {
        workspacePath,
        wasCreated: false,
        sentinelVerified: false,
        fatalError: `Workspace writability verification failed: ${error.message}`,
      };
    }
  }
}

export const workspacePreparationService = new WorkspacePreparationService();
