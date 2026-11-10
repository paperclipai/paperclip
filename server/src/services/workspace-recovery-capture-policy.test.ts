import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, executionWorkspaces, issueRecoveryActions } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION } from "./remote-workspace-snapshot-archive.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { reconcileRetainedWorkspaces, recoverRetainedWorkspace, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { acceptedRemoteExport, action, connectionString, db, useWorkspaceRecoveryFixture } from "./__tests__/workspace-recovery-fixture.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

const adminText = /sandbox|environment|administrator|board member|owner must|inspect the run/i;

describe("saves exhausted under an older workspace capture policy", () => {
  useWorkspaceRecoveryFixture(targets);
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", connectionString);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "63".repeat(32));
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  /**
   * The staging shape (PAP-3808, Nov 10): the run's save was refused with
   * `remote_workspace_archive_unsafe_symlink` because a headless Chromium
   * profile in the workspace linked its SingletonSocket by absolute path into
   * /tmp. Automatic recovery then spent its whole budget on the same refusal,
   * recorded as `export_interrupted` with cause `provider_error`, and handed
   * the hold to the board. This is the exact evidence that release saved.
   */
  async function exhaustedCaptureHold(policyVersion?: number) {
    const f = await acceptedRemoteExport("retained");
    const outside = path.join(path.dirname(f.remote), "sandbox-tmp");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "SingletonSocket"), "SYNTHETIC_SANDBOX_ONLY\n");
    await mkdir(path.join(f.remote, "node_modules", "tool"), { recursive: true });
    await mkdir(path.join(f.remote, "node_modules", ".bin"));
    await writeFile(path.join(f.remote, "node_modules", "tool", "cli.js"), "cli\n");
    await symlink("../tool/cli.js", path.join(f.remote, "node_modules", ".bin", "tool"));
    await mkdir(path.join(f.remote, ".review-chrome"));
    await symlink(path.join(outside, "SingletonSocket"), path.join(f.remote, ".review-chrome", "SingletonSocket"));
    await symlink("../sandbox-tmp/SingletonSocket", path.join(f.remote, "escape"));
    const prior = await action(f.actionId);
    const current = readSystemRecovery(prior.evidence)!;
    const firstFailureAt = Date.now() - 60 * 60_000;
    const nextAction = "Automatic recovery of saved work stopped after 6 attempts (last failure: export_interrupted, cause: provider_error). "
      + "Retry to try again; the agent will not repeat its work.";
    const { capturePolicyVersion: _omitted, ...saved } = current as typeof current & { capturePolicyVersion?: number };
    await db.update(issueRecoveryActions).set({ ownerType: "board", nextAction, evidence: { ...prior.evidence,
      systemRecovery: { ...saved, ...(policyVersion === undefined ? {} : { capturePolicyVersion: policyVersion }),
        revision: 18, phase: "preserve_files", state: "exhausted", attempts: 6, retriesUsed: 5,
        attemptId: randomUUID(), firstFailureAt, deadlineAt: firstFailureAt + 30 * 60_000, nextAttemptAt: null,
        failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "9".repeat(64),
          cause: { code: null, label: "provider_error", status: null } } },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "restoring_files",
        attempt: 6, attemptLimit: 6, retryable: true, message: nextAction, requestIds: [] } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    return f;
  }

  it("retries once under the new policy and saves the files without a person", async () => {
    const f = await exhaustedCaptureHold();

    // The recovery worker discovers the hold and wakes for it.
    expect(await nextWorkspaceRecoveryAt(db)).toBeLessThanOrEqual(Date.now());
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).toContain(f.actionId);
    const onRecovered = vi.fn(async () => undefined);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true) ?? []);

    const settled = await action(f.actionId);
    const state = readSystemRecovery(settled.evidence)!;
    expect(state).toMatchObject({ state: "complete", capturePolicyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(state.preservationOperationIds.length).toBeGreaterThan(0);
    expect(readWorkspaceRecovery(settled.evidence)?.status).toBe("recovered");
    expect(settled.evidence.capturePolicyRecovery).toMatchObject({ schema: "paperclip.capture-policy-recovery.v1",
      policyVersion: REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION });
    expect(settled.ownerType).toBe("system");
    expect(String(settled.nextAction)).not.toMatch(adminText);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    const authority = readRemoteWorkspaceAuthority((await db.select().from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, f.workspaceId)))[0]!.metadata)!;
    expect(authority).toMatchObject({ dirty: false });
    expect(authority.snapshotId).not.toBeNull();
    // The source workspace is untouched; nothing followed the outside links.
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");

    const rearmed = await db.select().from(activityLog).where(eq(activityLog.action, "issue.workspace_recovery_rearmed"));
    expect(rearmed).toEqual([expect.objectContaining({ actorType: "system", entityId: f.issueId, runId: f.runId,
      details: expect.objectContaining({ reason: "capture_policy_changed" }) })]);
  }, 60_000);

  it("does not re-arm a save that the current policy already exhausted", async () => {
    const f = await exhaustedCaptureHold(REMOTE_WORKSPACE_CAPTURE_POLICY_VERSION);
    expect((await retainedWorkspaceCandidates(db, undefined, false, true)).map(row => row.action.id)).not.toContain(f.actionId);
    const next = await nextWorkspaceRecoveryAt(db);
    expect(next === null || next > Date.now()).toBe(true);
    await recoverRetainedWorkspace(f.input);
    const held = await action(f.actionId);
    expect(readSystemRecovery(held.evidence)).toMatchObject({ state: "exhausted", failure: { code: "export_interrupted" } });
    expect(held.evidence.capturePolicyRecovery).toBeUndefined();
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
  }, 60_000);
});
