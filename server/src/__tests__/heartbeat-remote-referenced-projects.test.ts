import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isConfinedRemoteStagingDriver,
  isMultiProjectWorkspaceSyncRemoteEnabled,
  MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS,
  MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS,
  MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV,
  resolveAdditionalRunWorkspaces,
  type ResolveAdditionalRunWorkspacesOptions,
  type ResolvedAdditionalWorkspace,
} from "../services/heartbeat.ts";
import type { AuthorizationActor, AuthorizationDecision } from "../services/authorization.ts";

// These tests exercise the remote gate in `resolveAdditionalRunWorkspaces` with fully injected
// dependencies (no database). The function reads mentions through `issues.findMentionedProjectIds`,
// hydrates candidates through `projects.listByIds`, authorizes each through `access.decide`, and
// resolves an admitted project to a workspace through `resolveProjectWorkspace`. Each dependency is
// a stub here, so a test asserts the exact gate behavior for a sandbox target, an SSH target, and
// the remote kill switch.

const buildActor = (companyId: string): AuthorizationActor => ({
  type: "agent",
  agentId: randomUUID(),
  companyId,
  source: "agent_key",
});

const decision = (allowed: boolean): AuthorizationDecision => ({
  allowed,
  action: "project:read",
  reason: allowed ? "allow_company_agent" : "deny_company_boundary",
  explanation: "test decision",
});

// A `projects.listByIds` stub that returns one minimal record per requested id, in request order.
// The referenced-project record only needs an `id` here; the workspace resolution is stubbed, so no
// other field is read. The cast keeps the stub minimal without restating the full project row shape.
const listByIdsStub: ResolveAdditionalRunWorkspacesOptions["projects"] = {
  listByIds: async (_companyId, ids) =>
    ids.map(
      (id) =>
        ({ id, name: `Project ${id}`, status: "in_progress" }) as Awaited<
          ReturnType<ResolveAdditionalRunWorkspacesOptions["projects"]["listByIds"]>
        >[number],
    ),
};

// A `findMentionedProjectIds` stub that returns a fixed mention set for any issue.
const mentionsStub = (
  mentionedProjectIds: string[],
): ResolveAdditionalRunWorkspacesOptions["issues"] => ({
  findMentionedProjectIds: async () => mentionedProjectIds,
});

// Records every `project:read` authorization call and answers via the supplied resolver.
const recordingAccess = (
  resolve: (projectId: string) => AuthorizationDecision,
): { decidedProjectIds: string[]; access: ResolveAdditionalRunWorkspacesOptions["access"] } => {
  const decidedProjectIds: string[] = [];
  const access: ResolveAdditionalRunWorkspacesOptions["access"] = {
    decide: async (input) => {
      const resource = input.resource;
      const projectId = resource.type === "project" ? (resource.projectId ?? "") : "";
      decidedProjectIds.push(projectId);
      return resolve(projectId);
    },
  };
  return { decidedProjectIds, access };
};

// Records every workspace that resolution stages and returns a read-only workspace stub for it.
const recordingResolveProjectWorkspace = (): {
  stagedProjectIds: string[];
  resolveProjectWorkspace: ResolveAdditionalRunWorkspacesOptions["resolveProjectWorkspace"];
} => {
  const stagedProjectIds: string[] = [];
  const resolveProjectWorkspace: ResolveAdditionalRunWorkspacesOptions["resolveProjectWorkspace"] =
    async (project) => {
      stagedProjectIds.push(project.projectId);
      return {
        cwd: `/tmp/referenced/${project.projectId}`,
        projectId: project.projectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      } satisfies ResolvedAdditionalWorkspace;
    };
  return { stagedProjectIds, resolveProjectWorkspace };
};

const baseOpts = (
  companyId: string,
  overrides: Partial<ResolveAdditionalRunWorkspacesOptions> &
    Pick<ResolveAdditionalRunWorkspacesOptions, "issues" | "access" | "resolveProjectWorkspace">,
): ResolveAdditionalRunWorkspacesOptions => ({
  enabled: true,
  companyId,
  actor: buildActor(companyId),
  projects: listByIdsStub,
  ...overrides,
});

describe("remote referenced-project kill switch", () => {
  it("is ON by default and disabled only by an explicit false env value", () => {
    // Default ON: an unset value resolves the remote path live (go-live default).
    expect(isMultiProjectWorkspaceSyncRemoteEnabled({})).toBe(true);
    // The targeted kill switch: an explicit false value (the rollback path) disables it.
    expect(
      isMultiProjectWorkspaceSyncRemoteEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]: "" }),
    ).toBe(false);
    expect(
      isMultiProjectWorkspaceSyncRemoteEnabled({
        [MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]: "false",
      }),
    ).toBe(false);
    expect(
      isMultiProjectWorkspaceSyncRemoteEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]: "0" }),
    ).toBe(false);
    expect(
      isMultiProjectWorkspaceSyncRemoteEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]: "off" }),
    ).toBe(false);
    // Any other value keeps the remote path on.
    expect(
      isMultiProjectWorkspaceSyncRemoteEnabled({ [MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]: "true" }),
    ).toBe(true);
  });

  it("classifies only the sandbox driver as a confined remote staging transport", () => {
    // Only the sandbox driver confines each staged referenced tree, so only it opens the gate.
    expect(isConfinedRemoteStagingDriver("sandbox")).toBe(true);
    // The SSH and plugin drivers keep dropping referenced projects.
    expect(isConfinedRemoteStagingDriver("ssh")).toBe(false);
    expect(isConfinedRemoteStagingDriver("plugin")).toBe(false);
    expect(isConfinedRemoteStagingDriver("local")).toBe(false);
    expect(isConfinedRemoteStagingDriver(null)).toBe(false);
    expect(isConfinedRemoteStagingDriver(undefined)).toBe(false);
  });
});

describe("resolveAdditionalRunWorkspaces remote gate", () => {
  it("resolves and authorizes referenced workspaces on a sandbox target with the remote flag on", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();
    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const { stagedProjectIds, resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    const result = await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: true,
        issues: mentionsStub([mentionedProjectId]),
        access,
        resolveProjectWorkspace,
      }),
    );

    // The run authorized the referenced project against the run actor and staged its workspace.
    expect(decidedProjectIds).toEqual([mentionedProjectId]);
    expect(stagedProjectIds).toEqual([mentionedProjectId]);
    expect(result.additionalWorkspaces.map((workspace) => workspace.projectId)).toEqual([
      mentionedProjectId,
    ]);
    expect(result.failures).toEqual([]);
  });

  it("fails closed on a sandbox target when the remote flag is off (no authorization, no staging)", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();
    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const { stagedProjectIds, resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    const result = await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: false,
        issues: mentionsStub([mentionedProjectId]),
        access,
        resolveProjectWorkspace,
      }),
    );

    // Fail closed: no authorization decision and no workspace staging ran.
    expect(decidedProjectIds).toEqual([]);
    expect(stagedProjectIds).toEqual([]);
    expect(result.additionalWorkspaces).toEqual([]);
    // The whole referenced set is still counted as a staging-layer drop.
    expect(result.failures).toEqual([{ projectId: mentionedProjectId, reason: "staging" }]);
  });

  it("drops referenced projects on an SSH target whether the remote flag is on or off", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();

    for (const remoteReferencedSyncEnabled of [true, false]) {
      const { decidedProjectIds, access } = recordingAccess(() => decision(true));
      const { stagedProjectIds, resolveProjectWorkspace } = recordingResolveProjectWorkspace();

      const result = await resolveAdditionalRunWorkspaces(
        issueId,
        anchorProjectId,
        baseOpts(companyId, {
          executionTargetIsRemote: true,
          // The SSH transport does not confine its staging path, so it stays out of scope.
          targetStagesConfined: false,
          remoteReferencedSyncEnabled,
          issues: mentionsStub([mentionedProjectId]),
          access,
          resolveProjectWorkspace,
        }),
      );

      expect(decidedProjectIds).toEqual([]);
      expect(stagedProjectIds).toEqual([]);
      expect(result.additionalWorkspaces).toEqual([]);
      expect(result.failures).toEqual([{ projectId: mentionedProjectId, reason: "staging" }]);
    }
  });

  it("drops a referenced project the run agent cannot read on a sandbox target", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const readableProjectId = randomUUID();
    const unreadableProjectId = randomUUID();
    // Deny project:read for the unreadable project; allow it for the readable one.
    const { decidedProjectIds, access } = recordingAccess((projectId) =>
      decision(projectId === readableProjectId),
    );
    const { stagedProjectIds, resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    const result = await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: true,
        issues: mentionsStub([readableProjectId, unreadableProjectId]),
        access,
        resolveProjectWorkspace,
      }),
    );

    // Both projects were authorized against the run actor, but only the readable one was staged.
    expect(decidedProjectIds).toEqual([readableProjectId, unreadableProjectId]);
    expect(stagedProjectIds).toEqual([readableProjectId]);
    expect(result.additionalWorkspaces.map((workspace) => workspace.projectId)).toEqual([
      readableProjectId,
    ]);
    // The denied project is a first-class authorization failure.
    expect(result.failures).toEqual([{ projectId: unreadableProjectId, reason: "authorization" }]);
  });

  it("never authorizes the anchor project on a sandbox target", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    const mentionedProjectId = randomUUID();
    const { decidedProjectIds, access } = recordingAccess(() => decision(true));
    const { resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: true,
        // The mention set includes the anchor itself; the anchor must never be re-authorized.
        issues: mentionsStub([anchorProjectId, mentionedProjectId]),
        access,
        resolveProjectWorkspace,
      }),
    );

    // The anchor exemption drops the anchor from the mention set before the per-project check, so
    // only the non-anchor referenced project is authorized.
    expect(decidedProjectIds).toEqual([mentionedProjectId]);
    expect(decidedProjectIds).not.toContain(anchorProjectId);
  });

  it("holds the admitted-project cap on a sandbox target", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    // One more mention than the admitted cap.
    const mentionedProjectIds = Array.from(
      { length: MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS + 1 },
      () => randomUUID(),
    );
    const { access } = recordingAccess(() => decision(true));
    const { stagedProjectIds, resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    const result = await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: true,
        issues: mentionsStub(mentionedProjectIds),
        access,
        resolveProjectWorkspace,
      }),
    );

    // The cap bounds how many additional projects a sandbox run materializes.
    expect(stagedProjectIds).toHaveLength(MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS);
    expect(result.additionalWorkspaces).toHaveLength(MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS);
    // The one project past the cap is a first-class resolution failure.
    expect(result.failures).toEqual([
      { projectId: mentionedProjectIds[MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS], reason: "resolution" },
    ]);
  });

  it("holds the candidate-evaluation cap on a sandbox target", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const anchorProjectId = randomUUID();
    // Flood the run with denied mentions past the evaluation cap. Every candidate is denied, so the
    // admitted cap is never reached; the evaluation cap must still bound the authorization fan-out.
    const mentionedProjectIds = Array.from(
      { length: MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS + 5 },
      () => randomUUID(),
    );
    const { decidedProjectIds, access } = recordingAccess(() => decision(false));
    const { resolveProjectWorkspace } = recordingResolveProjectWorkspace();

    const result = await resolveAdditionalRunWorkspaces(
      issueId,
      anchorProjectId,
      baseOpts(companyId, {
        executionTargetIsRemote: true,
        targetStagesConfined: true,
        remoteReferencedSyncEnabled: true,
        issues: mentionsStub(mentionedProjectIds),
        access,
        resolveProjectWorkspace,
      }),
    );

    // The evaluation cap bounds authorization decisions even under a denied-mention flood.
    expect(decidedProjectIds).toHaveLength(MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS);
    expect(result.additionalWorkspaces).toEqual([]);
  });
});
