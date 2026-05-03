import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { workspacePreparationService } from "../services/workspace-preparation.js";

describe("WorkspacePreparationService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    // Create a fresh temp directory for each test to avoid leakage
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-"));
  });

  afterEach(async () => {
    // Recursive cleanup of tempRoot
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("detects existing workspace and skips creation", async () => {
    const companyId = "company-1";
    const agentId = "agent-1";
    const runId = "run-1";
    
    const existingCwd = path.join(tempRoot, "existing-ws");
    await fs.mkdir(existingCwd, { recursive: true });

    const result = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: existingCwd,
    });

    expect(result.wasCreated).toBe(false);
    expect(result.sentinelVerified).toBe(true);
    expect(result.workspacePath).toBe(existingCwd);
  });

  it("creates workspace directory when cwd is null", async () => {
    const companyId = "Company Name"; // Test sanitization
    const agentId = "Agent Name";     // Test sanitization
    const runId = "run-123";
    
    const result = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: null,
    });

    expect(result.wasCreated).toBe(true);
    expect(result.sentinelVerified).toBe(true);
    
    // Verify path pattern: {instanceRoot}/workspaces/{company_id}/{agent_id}/{run_id}
    // "Company Name" -> "company-name"
    const expectedPath = path.join(tempRoot, "workspaces", "company-name", "agent-name", "run-123");
    expect(result.workspacePath).toBe(expectedPath);
    
    const stats = await fs.stat(result.workspacePath);
    expect(stats.isDirectory()).toBe(true);
  });

  it("creates the requested fallback workspace path when it is inside the workspace root", async () => {
    const fallbackCwd = path.join(tempRoot, "workspaces", "agent-1");

    const result = await workspacePreparationService.prepareWorkspace({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      instanceRoot: tempRoot,
      executionWorkspaceCwd: fallbackCwd,
    });

    expect(result.wasCreated).toBe(true);
    expect(result.sentinelVerified).toBe(true);
    expect(result.workspacePath).toBe(fallbackCwd);

    const stats = await fs.stat(fallbackCwd);
    expect(stats.isDirectory()).toBe(true);
  });

  it("does not auto-create missing external project workspace paths", async () => {
    const missingProjectCwd = path.join(tempRoot, "data", "test-workspace");

    const result = await workspacePreparationService.prepareWorkspace({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      instanceRoot: tempRoot,
      executionWorkspaceCwd: missingProjectCwd,
    });

    const expectedManagedPath = path.join(tempRoot, "workspaces", "company-1", "agent-1", "run-1");
    expect(result.wasCreated).toBe(true);
    expect(result.sentinelVerified).toBe(true);
    expect(result.workspacePath).toBe(expectedManagedPath);

    await expect(fs.stat(missingProjectCwd)).rejects.toThrow();
    const stats = await fs.stat(expectedManagedPath);
    expect(stats.isDirectory()).toBe(true);
  });

  it("validates writability via sentinel file", async () => {
    const companyId = "c1";
    const agentId = "a1";
    const runId = "r1";
    
    const result = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: null,
    });

    expect(result.sentinelVerified).toBe(true);
    
    // Verify sentinel is gone
    const sentinelPath = path.join(result.workspacePath, ".paperclip-writable");
    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });

  it("handles sentinel cleanup failure gracefully", async () => {
    const companyId = "c1";
    const agentId = "a1";
    const runId = "r1";
    
    const result = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: null,
    });

    // To simulate cleanup failure, we'd need to change permissions of the file
    // between write and delete. Since verifyWritability is private and atomic,
    // we can't easily hook in. However, we can test if the logic handles
    // errors in the internal try-catch.
    
    // We'll mock fs.rm for this specific test
    const originalRm = fs.rm;
    (fs.rm as any) = async (p: string, opts: any) => {
      if (p.includes(".paperclip-writable")) {
        throw new Error("Simulated cleanup failure");
      }
      return originalRm(p, opts);
    };

    const resultCleanupFail = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: null,
    });

    expect(resultCleanupFail.sentinelVerified).toBe(true);
    expect(resultCleanupFail.errors).toContain("Sentinel cleanup failed: Simulated cleanup failure");
    
    // Restore fs.rm
    (fs.rm as any) = originalRm;
  });

  it("refuses to create workspace outside the instance root", async () => {
    // This tests the guard: if (!expectedPath.startsWith(path.resolve(instanceRoot, "workspaces")))
    // To trigger this, we'd need a case where the path resolution escapes.
    // Since we use path.resolve(instanceRoot, "workspaces", ...), it's hard to escape
    // unless instanceRoot itself is weird.
    
    // We can test a case where we pass an instanceRoot that doesn't align 
    // but that's unlikely. Let's try a ".." in the ID to see if it escapes.
    const companyId = ".."; 
    const agentId = "a1";
    const runId = "r1";
    
    const result = await workspacePreparationService.prepareWorkspace({
      companyId,
      agentId,
      runId,
      instanceRoot: tempRoot,
      executionWorkspaceCwd: null,
    });
    
    // sanitizeSlugPart should have turned ".." into "--" or empty
    // so it shouldn't escape. Let's verify the sanitization works.
    expect(result.workspacePath).not.toContain("..");
  });
});
