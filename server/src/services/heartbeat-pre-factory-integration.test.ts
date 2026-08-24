import { randomUUID } from "node:crypto";
import { execFile as execFileCallback, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildProjectMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  companySkills,
  companySkillTestRuns,
  companySkillVersions,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issues,
  projects,
  projectWorkspaces,
  routineRevisions,
  routineRuns,
  routines,
  toolMcpGateways,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "../__tests__/helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../adapters/index.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const adapterType = "codex_local";
const workspaceAdapterType = "heartbeat_workspace_coverage";
const execFile = promisify(execFileCallback);

async function waitForRun(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId, { unsafeFullResultJson: true });
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId, { unsafeFullResultJson: true });
}

describePostgres("heartbeat pre-factory integration coverage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let paperclipHome: string;
  let previousHome: string | undefined;
  let executionCount = 0;
  let executionDelayMs = 0;
  let removeWorktreeGitMetadata = false;
  const capturedConfigs: Record<string, unknown>[] = [];
  const capturedContexts: Record<string, unknown>[] = [];
  const capturedRunIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-pre-factory-");
    db = createDb(database.connectionString);
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-pre-factory-home-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = paperclipHome;
    const execute = async (context: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      executionCount += 1;
      capturedConfigs.push(context.config);
      capturedContexts.push(context.context);
      capturedRunIds.push(context.runId);
        if (removeWorktreeGitMetadata) {
          const workspace = context.context.paperclipWorkspace as { cwd?: string } | undefined;
          if (workspace?.cwd) await fs.rm(path.join(workspace.cwd, ".git"), { force: true });
        }
        await context.onEvent?.({ eventType: "tool.started", payload: { toolName: " shell " } });
        await context.onEvent?.({ eventType: "fallback_tool_event", payload: {} });
        await context.onEvent?.({ eventType: "assistant.delta", payload: { text: " assistant update " } });
        await context.onEvent?.({ eventType: "message_delta", message: "message update", payload: {} });
        await context.onEvent?.({ eventType: ".", message: "", payload: {} });
        if (executionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
        }
        if (context.agent.name === "Provider Quota Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "provider_quota",
            errorFamily: "provider_quota" as const,
            retryNotBefore: "2026-08-02T00:00:00.000Z",
            errorMessage: "quota exhausted",
          };
        }
        if (context.agent.name === "Custom Failure Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "custom_failure",
            errorMessage: "ordinary failure",
          };
        }
        if (context.agent.name === "Interaction Failure Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "adapter_failed",
            errorMessage: "ordinary failure",
          };
        }
        if (context.agent.name === "Error Only Agent") {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: "error_only", errorMessage: null };
        }
        if (context.agent.name === "Summary Only Agent") {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: null, errorMessage: "summary only" };
        }
        if (context.agent.name === "Max Turn Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "adapter_failed",
            errorMessage: "Maximum turns reached",
            resultJson: { stopReason: "max_turns_exhausted" },
          };
        }
        if (context.agent.name === "Empty Result Agent") {
          return { exitCode: 0, signal: null, timedOut: false };
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "coverage-session",
          sessionDisplayId: "coverage-session",
          usage: executionCount === 8
            ? undefined
            : executionCount === 9
              ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
              : {
                  inputTokens: executionCount * 10,
                  cachedInputTokens: executionCount * 2,
                  outputTokens: executionCount * 3,
                },
          usageBasis: "session_cumulative",
          provider: "coverage",
          model: "coverage-model",
          billingType: (["api", "subscription", "subscription_overage", "credits", "fixed"] as const)[
            (executionCount - 1) % 5
          ],
          costUsd: 1.23,
          resultJson: { summary: `run ${executionCount}` },
        };
    };
    const testEnvironment = async () => ({
      adapterType,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    registerServerAdapter({
      type: adapterType,
      execute,
      testEnvironment,
    });
    registerServerAdapter({
      type: workspaceAdapterType,
      execute,
      testEnvironment: async () => ({
        adapterType: workspaceAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    unregisterServerAdapter(adapterType);
    unregisterServerAdapter(workspaceAdapterType);
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(paperclipHome, { recursive: true, force: true });
    await database.cleanup();
  });

  it("resolves mentioned skills, snapshots config, and deltas cumulative session usage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-mentioned-skill-"));
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Mentioned skill\n", "utf8");
    await execFile("git", ["init", skillDir]);

    await db.insert(companies).values({
      id: companyId,
      name: "Coverage Company",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Coverage Project",
      status: "active",
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other Coverage Project",
      status: "active",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Managed primary",
      cwd: skillDir,
      repoUrl: null,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {
        model: "coverage-model",
        env: { OPENAI_API_KEY: "test-api-key" },
        workspaceStrategy: { provisionCommand: "echo provision", teardownCommand: "echo teardown" },
        workspaceRuntime: { command: "echo runtime" },
        desiredState: "manual",
        serviceStates: { api: "running", ignored: "invalid" },
      },
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxSessionRuns: 0,
            maxRawInputTokens: 1,
            maxSessionAgeHours: 0,
          },
        },
      },
      permissions: {},
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/mentioned-skill`,
      slug: "mentioned-skill",
      name: "Mentioned skill",
      markdown: "# Mentioned skill\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Use [/mentioned-skill](${buildSkillMentionHref(skillId, "mentioned-skill")})`,
      description: "Exercise the helper path",
      status: "todo",
      priority: "medium",
      projectId,
      projectWorkspaceId,
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "COV-1",
    });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
      projectId,
      assigneeAgentId: otherAgentId,
      issueNumber: 2,
      identifier: "COV-2",
    });
    const [gatewayProfile] = await db.insert(toolProfiles).values({
      companyId,
      profileKey: "coverage-gateway",
      name: "Coverage gateway",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolMcpGateways).values([
      {
        companyId,
        name: "Wrong issue gateway",
        slug: "wrong-issue-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "issue",
        contextScopeId: randomUUID(),
      },
      {
        companyId,
        name: "Wrong issue field gateway",
        slug: "wrong-issue-field-gateway",
        profileId: gatewayProfile!.id,
        issueId: otherIssueId,
      },
      {
        companyId,
        name: "Applicable gateway",
        slug: "applicable-gateway",
        profileId: gatewayProfile!.id,
      },
      {
        companyId,
        name: "Wrong agent gateway",
        slug: "wrong-agent-gateway",
        profileId: gatewayProfile!.id,
        agentId: otherAgentId,
      },
      {
        companyId,
        name: "Wrong project gateway",
        slug: "wrong-project-gateway",
        profileId: gatewayProfile!.id,
        projectId: otherProjectId,
      },
      {
        companyId,
        name: "Wrong agent scope gateway",
        slug: "wrong-agent-scope-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "agent",
        contextScopeId: randomUUID(),
      },
      {
        companyId,
        name: "Wrong project scope gateway",
        slug: "wrong-project-scope-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "project",
        contextScopeId: randomUUID(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.invoke(agentId, "assignment", {
      issueId,
      wakeReason: "issue_assigned",
    }, "system");
    expect(first).not.toBeNull();
    expect((await waitForRun(heartbeat, first!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(first!.id);

    await db.update(agents).set({
      adapterConfig: {
        env: { OPENAI_API_KEY: "test-api-key" },
        managedMcpOnly: false,
      },
    }).where(eq(agents.id, agentId));

    const secondHeartbeat = heartbeatService(db);
    const second = await secondHeartbeat.invoke(agentId, "on_demand", {
      issueId,
      wakeReason: "issue_commented",
    }, "manual");
    expect(second).not.toBeNull();
    const completed = await waitForRun(secondHeartbeat, second!.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.usageJson).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      rawInputTokens: 20,
      usageSource: "session_delta",
    });
    expect(capturedConfigs.some((config) =>
      JSON.stringify(config).includes(`company/${companyId}/mentioned-skill`))).toBe(true);
    await secondHeartbeat.waitForRunExecutionDrain(second!.id);

    await db
      .update(heartbeatRuns)
      .set({
        sessionIdAfter: "coverage-session",
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      })
      .where(eq(heartbeatRuns.id, first!.id));
    await db
      .update(heartbeatRuns)
      .set({ sessionIdAfter: "coverage-session", createdAt: new Date() })
      .where(eq(heartbeatRuns.id, second!.id));
    await db
      .update(agents)
      .set({
        runtimeConfig: {
          heartbeat: {
            sessionCompaction: {
              enabled: true,
              maxSessionRuns: 0,
              maxRawInputTokens: 0,
              maxSessionAgeHours: 1,
            },
          },
        },
      })
      .where(eq(agents.id, agentId));
    await db
      .update(agentRuntimeState)
      .set({ sessionId: "coverage-session" })
      .where(eq(agentRuntimeState.agentId, agentId));
    const ageContextIndex = capturedContexts.length;
    const agedSessionRun = await secondHeartbeat.invoke(agentId, "on_demand", {
      wakeReason: "manual_age_coverage",
    }, "manual");
    expect(agedSessionRun).not.toBeNull();
    expect((await waitForRun(secondHeartbeat, agedSessionRun!.id))?.status).toBe("succeeded");
    await secondHeartbeat.waitForRunExecutionDrain(agedSessionRun!.id);
    expect(capturedContexts.slice(ageContextIndex)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paperclipSessionRotationReason: expect.stringContaining("session age reached"),
          paperclipSessionHandoffMarkdown: expect.stringContaining("Paperclip session handoff"),
        }),
      ]),
    );

    const payloadWake = await secondHeartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: {},
    });
    expect(payloadWake).not.toBeNull();
    await waitForRun(secondHeartbeat, payloadWake!.id);
    await secondHeartbeat.waitForRunExecutionDrain(payloadWake!.id);

    const acceptedWithoutIssue = await secondHeartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { mutation: "interaction" },
      contextSnapshot: {
        interactionId: randomUUID(),
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });
    expect(acceptedWithoutIssue).not.toBeNull();
    await waitForRun(secondHeartbeat, acceptedWithoutIssue!.id);
    await secondHeartbeat.waitForRunExecutionDrain(acceptedWithoutIssue!.id);

    await fs.rm(skillDir, { recursive: true, force: true });
  }, 30_000);

  it("creates an empty managed primary workspace for a project without a checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const mentionedProjectId = randomUUID();
    const cloneProjectId = randomUUID();
    const populatedManagedProjectId = randomUUID();
    const unreadableManagedProjectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Managed Workspace Company",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Managed project", status: "active" });
    await db.insert(projects).values({
      id: mentionedProjectId,
      companyId,
      name: "Mentioned project",
      status: "active",
    });
    await db.insert(projects).values([
      { id: cloneProjectId, companyId, name: "Clone project", status: "active" },
      { id: populatedManagedProjectId, companyId, name: "Populated managed project", status: "active" },
      { id: unreadableManagedProjectId, companyId, name: "Unreadable managed project", status: "active" },
    ]);
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Managed primary",
      cwd: null,
      repoUrl: null,
      isPrimary: true,
    });
    const referencedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-referenced-workspace-"));
    const missingCwd = path.join(referencedRoot, "missing");
    const unreadableCwd = path.join(referencedRoot, "unreadable");
    const populatedCwd = path.join(referencedRoot, "populated");
    await fs.mkdir(unreadableCwd);
    await fs.chmod(unreadableCwd, 0o000);
    await fs.mkdir(populatedCwd);
    await fs.writeFile(path.join(populatedCwd, "README.md"), "content\n", "utf8");
    const cloneSource = path.join(referencedRoot, "clone-source");
    await fs.mkdir(cloneSource);
    await execFile("git", ["init", cloneSource]);
    const cloneRepoUrl = `file://${cloneSource}`;
    const populatedManagedCwd = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId: populatedManagedProjectId,
      repoName: null,
    });
    await fs.mkdir(populatedManagedCwd, { recursive: true });
    await fs.writeFile(path.join(populatedManagedCwd, "README.md"), "occupied\n", "utf8");
    const unreadableManagedCwd = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId: unreadableManagedProjectId,
      repoName: "missing-unreadable",
    });
    await fs.mkdir(unreadableManagedCwd, { recursive: true });
    await fs.chmod(unreadableManagedCwd, 0o000);
    await db.insert(projectWorkspaces).values([
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Missing",
        cwd: missingCwd,
        isPrimary: true,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Unreadable",
        cwd: unreadableCwd,
        isPrimary: false,
        createdAt: new Date("2026-08-01T00:00:01.000Z"),
      },
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Populated",
        cwd: populatedCwd,
        isPrimary: false,
        createdAt: new Date("2026-08-01T00:00:02.000Z"),
      },
      {
        companyId,
        projectId: cloneProjectId,
        name: "Clone on demand",
        cwd: null,
        repoUrl: cloneRepoUrl,
        isPrimary: true,
      },
      {
        companyId,
        projectId: populatedManagedProjectId,
        name: "Occupied managed path",
        cwd: null,
        repoUrl: "not a valid repository URL",
        isPrimary: true,
      },
      {
        companyId,
        projectId: unreadableManagedProjectId,
        name: "Unreadable managed path",
        cwd: null,
        repoUrl: "file:///definitely/missing-unreadable.git",
        isPrimary: true,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Create managed workspaces",
      description: [
        `Create managed workspace with [reference](${buildProjectMentionHref(mentionedProjectId)})`,
        `[clone](${buildProjectMentionHref(cloneProjectId)})`,
        `[occupied](${buildProjectMentionHref(populatedManagedProjectId)})`,
        `[unreadable](${buildProjectMentionHref(unreadableManagedProjectId)})`,
      ].join(" "),
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "WM-1",
    });

    const heartbeat = heartbeatService(db);
    executionDelayMs = 300;
    const run = await heartbeat.invoke(agentId, "assignment", { issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    const runningDeadline = Date.now() + 5_000;
    while (Date.now() < runningDeadline) {
      if ((await heartbeat.getRun(run!.id))?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const coalesced = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(coalesced?.id).toBe(run!.id);
    expect((await waitForRun(heartbeat, run!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(run!.id);
    executionDelayMs = 300;
    const unscoped = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: "unscoped-coverage", wakeReason: "manual" },
      "manual",
    );
    expect(unscoped).not.toBeNull();
    const unscopedDeadline = Date.now() + 5_000;
    while (Date.now() < unscopedDeadline) {
      if ((await heartbeat.getRun(unscoped!.id))?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const unscopedCoalesced = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: "unscoped-coverage", wakeReason: "manual" },
      "manual",
    );
    expect(unscopedCoalesced?.id).toBe(unscoped!.id);
    expect((await waitForRun(heartbeat, unscoped!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(unscoped!.id);
    executionDelayMs = 0;
    for (let index = 0; index < 6; index += 1) {
      const extra = await heartbeat.invoke(
        agentId,
        "on_demand",
        { taskKey: "billing-coverage", wakeReason: "manual" },
        "manual",
      );
      expect(extra).not.toBeNull();
      expect((await waitForRun(heartbeat, extra!.id))?.status).toBe("succeeded");
      await heartbeat.waitForRunExecutionDrain(extra!.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await fs.chmod(unreadableCwd, 0o700);
    await fs.chmod(unreadableManagedCwd, 0o700).catch(() => undefined);
    await fs.rm(referencedRoot, { recursive: true, force: true });
    executionDelayMs = 0;
  }, 30_000);

  it("applies the bounded max-turn continuation policy after adapter exhaustion", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Max Turn Coverage Company",
      issuePrefix: "MTC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Max Turn Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 999,
            delayMs: 999_999_999,
          },
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "MTC-1",
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "assignment", {
      issueId,
      wakeReason: "issue_assigned",
    }, "system");
    expect(run).not.toBeNull();
    expect((await waitForRun(heartbeat, run!.id))?.status).toBe("failed");
    await heartbeat.waitForRunExecutionDrain(run!.id);

    const retry = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retry).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "max_turns_continuation",
    });
    expect(retry?.scheduledRetryAt?.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1_000);
  }, 20_000);

  it("resolves routine revision and legacy routine ownership during dispatch", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const revisionId = randomUUID();
    const routineRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Routine Coverage Company",
      issuePrefix: "RTC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "company-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Pinned routine",
      assigneeAgentId: agentId,
      responsibleUserId: "current-routine-user",
      env: null,
    });
    await db.insert(routineRevisions).values({
      id: revisionId,
      companyId,
      routineId,
      revisionNumber: 1,
      title: "Pinned routine",
      responsibleUserId: "revision-user",
      snapshot: {
        version: 1,
        routine: {
          id: routineId,
          companyId,
          projectId: null,
          goalId: null,
          parentIssueId: null,
          title: "Pinned routine",
          description: null,
          assigneeAgentId: agentId,
          priority: "medium",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          activityGatePolicy: "always",
          activityGateScope: "company",
          variables: [],
          env: null,
          responsibleUserId: "snapshot-user",
        },
        triggers: [],
      },
    });
    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      source: "manual",
      status: "issue_created",
      routineRevisionId: revisionId,
      responsibleUserId: "routine-run-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execute pinned routine",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: routineRunId,
      issueNumber: 1,
      identifier: "RTC-1",
    });

    const heartbeat = heartbeatService(db);
    const pinned = await heartbeat.invoke(agentId, "assignment", {
      issueId,
      wakeReason: "issue_assigned",
    }, "system");
    expect(pinned).not.toBeNull();
    expect((await waitForRun(heartbeat, pinned!.id))?.responsibleUserId).toBe("revision-user");
    await heartbeat.waitForRunExecutionDrain(pinned!.id);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const legacyRoutineRunId = randomUUID();
    await db.insert(routineRuns).values({
      id: legacyRoutineRunId,
      companyId,
      routineId,
      source: "manual",
      status: "issue_created",
      routineRevisionId: null,
      responsibleUserId: "routine-run-user",
    });
    const legacyIssueId = randomUUID();
    await db.insert(issues).values({
      id: legacyIssueId,
      companyId,
      title: "Execute legacy routine",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: legacyRoutineRunId,
      issueNumber: 2,
      identifier: "RTC-2",
    });
    const legacy = await heartbeat.invoke(agentId, "on_demand", {
      issueId: legacyIssueId,
      wakeReason: "issue_commented",
      commentId: randomUUID(),
    }, "manual");
    expect(legacy).not.toBeNull();
    expect((await waitForRun(heartbeat, legacy!.id))?.responsibleUserId).toBe("routine-run-user");
    await heartbeat.waitForRunExecutionDrain(legacy!.id);
  }, 20_000);

  it("prioritizes queued issue runs before consuming the agent's only slot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const priorities = ["unknown", "low", "medium", "high", "critical"];
    await db.insert(companies).values({
      id: companyId,
      name: "Queue Priority Coverage Company",
      issuePrefix: "QPC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Queue Priority Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const fixtures = priorities.map((priority, index) => ({
      priority,
      issueId: randomUUID(),
      runId: randomUUID(),
      issueNumber: index + 1,
    }));
    await db.insert(issues).values(fixtures.map((fixture) => ({
      id: fixture.issueId,
      companyId,
      title: `${fixture.priority} priority work`,
      status: "todo",
      priority: fixture.priority,
      assigneeAgentId: agentId,
      issueNumber: fixture.issueNumber,
      identifier: `QPC-${fixture.issueNumber}`,
    })));
    await db.insert(heartbeatRuns).values(fixtures.map((fixture) => ({
      id: fixture.runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId: fixture.issueId, wakeReason: "issue_assigned" },
    })));

    executionDelayMs = 200;
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    const critical = fixtures.find((fixture) => fixture.priority === "critical")!;
    expect((await waitForRun(heartbeat, critical.runId, 5_000))?.status).toBe("succeeded");
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    executionDelayMs = 0;
  }, 20_000);

  it("pins the exact skill revision into skill-test runs and completes the test run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const skillId = randomUUID();
    const skillVersionId = randomUUID();
    const skillTestRunId = randomUUID();
    const skillDir = path.join(paperclipHome, `pinned-skill-${skillId}`);

    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Current skill\n", "utf8");
    await fs.writeFile(path.join(skillDir, "references", "guide.md"), "Current guide", "utf8");

    await db.insert(companies).values({
      id: companyId,
      name: "Pinned Skill Test Company",
      issuePrefix: "PST",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Custom Failure Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Exercise a pinned skill revision",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PST-1",
      workMode: "skill_test",
      harnessKind: "skill_test",
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/pinned-skill`,
      slug: "pinned-skill",
      name: "Pinned skill",
      markdown: "# Current skill\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(companySkillVersions).values({
      id: skillVersionId,
      companyId,
      companySkillId: skillId,
      revisionNumber: 7,
      label: "Pinned revision",
      fileInventory: [
        null,
        [],
        { path: "" },
        { path: "SKILL.md", content: "# Pinned skill\n" },
        { path: "references/guide.md", kind: "reference", content: "Pinned guide" },
      ] as never,
    });
    await db.insert(companySkillTestRuns).values({
      id: skillTestRunId,
      companyId,
      skillId,
      inputSnapshot: "Use the pinned revision",
      skillVersionId,
      agentId,
      agentConfigSnapshot: {},
      issueId,
      harnessIssueDescription: "Use the pinned revision",
      status: "queued",
      outputDocumentKey: "output",
    });

    const contextIndex = capturedContexts.length;
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "skill_test_run_created" },
      "system",
    );
    expect(run).not.toBeNull();
    expect((await waitForRun(heartbeat, run!.id))?.status).toBe("failed");
    await heartbeat.waitForRunExecutionDrain(run!.id);

    const pinnedContext = capturedContexts.slice(contextIndex)
      .map((context) => context.paperclipSkillTest)
      .find(Boolean) as Record<string, unknown> | undefined;
    expect(pinnedContext).toMatchObject({
      testRunId: skillTestRunId,
      skillId,
      inputId: null,
      skillVersionId,
      revisionNumber: 7,
      label: "Pinned revision",
      outputDocumentKey: "output",
      fileInventory: [
        { path: "SKILL.md", kind: "other", content: "# Pinned skill\n" },
        { path: "references/guide.md", kind: "reference", content: "Pinned guide" },
      ],
    });
    expect(pinnedContext?.directive).toContain("exact skill revision under test");

    const completedTestRuns = await db
      .select()
      .from(companySkillTestRuns)
      .where(eq(companySkillTestRuns.id, skillTestRunId));
    expect(completedTestRuns).toMatchObject([{ id: skillTestRunId, status: "failed" }]);
  }, 20_000);

  it("fingerprints an unrecoverable final workspace branch inspection", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-finalize-fingerprint-"));
    await execFile("git", ["init", repoRoot]);
    await execFile("git", ["config", "user.email", "coverage@example.test"], { cwd: repoRoot });
    await execFile("git", ["config", "user.name", "Coverage"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "coverage\n", "utf8");
    await execFile("git", ["add", "README.md"], { cwd: repoRoot });
    await execFile("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId, name: "Fingerprint Company", issuePrefix: "FPR", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fingerprint Project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary", cwd: repoRoot, isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Fingerprint Agent", role: "engineer", status: "idle", adapterType,
      adapterConfig: { workspaceStrategy: { type: "git_worktree" } }, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, projectWorkspaceId, title: "Break final branch inspection",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, issueNumber: 1, identifier: "FPR-1",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    removeWorktreeGitMetadata = true;
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {
      issueId, wakeReason: "issue_commented", skipIssueComment: true,
    }, "manual");
    expect(run).not.toBeNull();
    const completed = await waitForRun(heartbeat, run!.id);
    expect(completed?.status).toBe("failed");
    expect(JSON.stringify(completed?.resultJson)).toContain("workspace_finalize_branch_mismatch:v1:sha256:");
    await heartbeat.waitForRunExecutionDrain(run!.id);
    removeWorktreeGitMetadata = false;
    await fs.rm(repoRoot, { recursive: true, force: true });
  }, 30_000);

  it("reaps detached local processes across liveness error variants", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Reaper Company", issuePrefix: "RPR", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reaper Agent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const now = new Date("2026-08-01T00:00:00.000Z");
    const seeded = await db.insert(heartbeatRuns).values([
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processPid: 4242, processLossRetryCount: 1, startedAt: now, updatedAt: new Date(),
      },
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processPid: 4243, processLossRetryCount: 1, startedAt: now,
        updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      },
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processGroupId: 4244, processLossRetryCount: 1, startedAt: now,
        updatedAt: new Date(Date.now() - 2 * 60 * 1000),
      },
    ]).returning();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      const error = new Error("not alive") as NodeJS.ErrnoException;
      error.code = pid === 4242 ? "EPERM" : "EACCES";
      throw error;
    });
    const heartbeat = heartbeatService(db);
    const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 60_000 });
    expect(reaped.runIds).toEqual(expect.arrayContaining([seeded[1]!.id, seeded[2]!.id]));
    expect(reaped.runIds).not.toContain(seeded[0]!.id);
    kill.mockRestore();
  }, 20_000);

  it("classifies quota and interaction-continuation failure recovery", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Recovery Company", issuePrefix: "RCV", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const cases = [
      { name: "Provider Quota Agent", interactionStatus: "accepted" },
      { name: "Custom Failure Agent", interactionStatus: "pending" },
      { name: "Interaction Failure Agent", interactionStatus: "accepted" },
      { name: "Error Only Agent", interactionStatus: "pending" },
      { name: "Summary Only Agent", interactionStatus: "pending" },
    ];
    const heartbeat = heartbeatService(db);
    for (const [index, item] of cases.entries()) {
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(agents).values({
        id: agentId, companyId, name: item.name, role: "engineer", status: "idle",
        adapterType: workspaceAdapterType,
        adapterConfig: {},
        runtimeConfig: item.name === "Custom Failure Agent"
          ? { heartbeat: { maxConcurrentRuns: "Infinity" } }
          : {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId, companyId, title: `${item.name} issue`, status: "in_progress", priority: "medium",
        assigneeAgentId: agentId, issueNumber: index + 1, identifier: `RCV-${index + 1}`,
      });
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "interaction" },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionStatus: item.interactionStatus,
          retryReason: "issue_continuation_needed",
        },
      });
      expect(run).not.toBeNull();
      expect((await waitForRun(heartbeat, run!.id))?.status).toBe("failed");
      await heartbeat.waitForRunExecutionDrain(run!.id);
      if (item.name === "Provider Quota Agent") {
        await expect(heartbeat.scheduleBoundedRetry(run!.id, { delayMs: 60_000 }))
          .resolves.toMatchObject({ outcome: "scheduled" });
      }
    }
  }, 30_000);

  it("covers sparse skill, session-compaction, and workspace fallback contexts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const parentIssueId = randomUUID();
    const issueId = randomUUID();
    const skillTestIssueId = randomUUID();
    const projectId = randomUUID();
    const noLocalCwdProjectId = randomUUID();
    const noLocalCwdWorkspaceId = randomUUID();
    const noLocalCwdIssueId = randomUUID();
    const managedProjectId = randomUUID();
    const managedIssueId = randomUUID();
    const failingManagedProjectId = randomUUID();
    const failingManagedWorkspaceId = randomUUID();
    const failingManagedIssueId = randomUUID();
    const responsibleUserParentIssueId = randomUUID();
    const responsibleUserIssueId = randomUUID();
    const existingSessionCwd = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-session-cwd-"));
    const missingSessionCwd = path.join(existingSessionCwd, "missing");
    const previousWorkspaceSync = process.env.PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC;
    process.env.PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC = "false";

    await db.insert(companies).values({
      id: companyId,
      name: "Sparse Context Company",
      issuePrefix: "SPC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "company-owner",
    });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Workspace-free project", status: "active" },
      { id: noLocalCwdProjectId, companyId, name: "No-local-cwd project", status: "active" },
      { id: managedProjectId, companyId, name: "Managed fallback project", status: "active" },
      { id: failingManagedProjectId, companyId, name: "Broken managed project", status: "active" },
    ]);
    await db.insert(projectWorkspaces).values({
      id: noLocalCwdWorkspaceId,
      companyId,
      projectId: noLocalCwdProjectId,
      name: "Remote-only workspace",
      cwd: null,
      repoUrl: null,
      isPrimary: true,
    });
    await db.insert(projectWorkspaces).values({
      id: failingManagedWorkspaceId,
      companyId,
      projectId: failingManagedProjectId,
      name: "Unavailable managed workspace",
      cwd: null,
      repoUrl: "/definitely/not/a/managed-workspace-repository",
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sparse Context Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxSessionRuns: 1,
            maxRawInputTokens: 0,
            maxSessionAgeHours: 0,
          },
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        title: "Responsible parent",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "parent-owner",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: "SPC-1",
      },
      {
        id: issueId,
        companyId,
        title: "Session workspace issue",
        status: "in_progress",
        priority: "medium",
        parentId: parentIssueId,
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: "SPC-2",
      },
      {
        id: skillTestIssueId,
        companyId,
        title: "Sparse skill test issue",
        status: "in_progress",
        priority: "medium",
        workMode: "skill_test",
        harnessKind: "skill_test",
        projectId,
        assigneeAgentId: agentId,
        assigneeAdapterOverrides: { useProjectWorkspace: false },
        issueNumber: 3,
        identifier: "SPC-3",
      },
      {
        id: noLocalCwdIssueId,
        companyId,
        title: "No local cwd issue",
        status: "in_progress",
        priority: "medium",
        projectId: noLocalCwdProjectId,
        assigneeAgentId: agentId,
        issueNumber: 4,
        identifier: "SPC-4",
      },
      {
        id: managedIssueId,
        companyId,
        title: "Managed workspace issue",
        status: "in_progress",
        priority: "medium",
        projectId: managedProjectId,
        assigneeAgentId: agentId,
        issueNumber: 5,
        identifier: "SPC-5",
      },
      {
        id: failingManagedIssueId,
        companyId,
        title: "Broken managed workspace issue",
        status: "in_progress",
        priority: "medium",
        projectId: failingManagedProjectId,
        projectWorkspaceId: failingManagedWorkspaceId,
        assigneeAgentId: agentId,
        issueNumber: 6,
        identifier: "SPC-6",
      },
      {
        id: responsibleUserParentIssueId,
        companyId,
        title: "Responsible user parent issue",
        status: "in_progress",
        priority: "medium",
        responsibleUserId: "parent-owner",
        issueNumber: 7,
        identifier: "SPC-7",
      },
      {
        id: responsibleUserIssueId,
        companyId,
        title: "Inherited responsible user issue",
        status: "in_progress",
        priority: "medium",
        parentId: responsibleUserParentIssueId,
        assigneeAgentId: agentId,
        issueNumber: 8,
        identifier: "SPC-8",
      },
    ]);
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: workspaceAdapterType,
      taskKey: issueId,
      sessionParamsJson: { sessionId: "empty-session", cwd: existingSessionCwd },
      sessionDisplayId: "empty-session",
    });

    const service = heartbeatService(db);
    const updateTaskSession = async (sessionId: string, cwd: string) => {
      await db.update(agentTaskSessions).set({
        sessionParamsJson: { sessionId, cwd },
        sessionDisplayId: sessionId,
      }).where(eq(agentTaskSessions.taskKey, issueId));
    };
    const runAndDrain = async (targetIssueId: string, context: Record<string, unknown> = {}) => {
      const capturedContextIndex = capturedContexts.length;
      const acceptedPlanContext = { workspaceRefreshReason: "accepted_plan_confirmation", ...context };
      const run = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        payload: { issueId: targetIssueId, ...acceptedPlanContext },
        contextSnapshot: { issueId: targetIssueId, ...acceptedPlanContext },
        requestedByActorType: "user",
        requestedByActorId: "requesting-user",
      });
      expect(run).not.toBeNull();
      const completedRun = await waitForRun(service, run!.id);
      expect(completedRun?.status).toBe("succeeded");
      await service.waitForRunExecutionDrain(run!.id);
      const capturedContextIndexForRun = capturedRunIds
        .slice(capturedContextIndex)
        .findIndex((capturedRunId) => capturedRunId === run!.id);
      const capturedContext = capturedContextIndexForRun >= 0
        ? capturedContexts[capturedContextIndex + capturedContextIndexForRun]
        : undefined;
      return {
        run: completedRun!,
        context: capturedContext as {
          paperclipWorkspace?: { cwd?: string; source?: string; warnings?: string[] };
        },
      };
    };

    try {
      const existingWorkspace = await runAndDrain(issueId, { responsibleUserId: "context-owner" });
      expect(existingWorkspace.context.paperclipWorkspace).toMatchObject({
        cwd: existingSessionCwd,
        source: "task_session",
      });

      const lightSessionId = "run-light-session";
      const lightHistoryRunId = randomUUID();
      await updateTaskSession(lightSessionId, existingSessionCwd);
      await db.insert(heartbeatRuns).values({
        id: lightHistoryRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        sessionIdAfter: lightSessionId,
        resultJson: {},
        contextSnapshot: { issueId },
        responsibleUserId: "parent-owner",
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        updatedAt: new Date("2026-07-01T00:00:00.000Z"),
      });
      await runAndDrain(issueId, { resumeFromRunId: lightHistoryRunId });

      await updateTaskSession("missing-session", missingSessionCwd);
      const missingWorkspace = await runAndDrain(issueId);
      expect(missingWorkspace.run.stdoutExcerpt).toContain("is not available");

      await updateTaskSession("unsafe-session", "/tmp");
      const unsafeWorkspace = await runAndDrain(issueId, { resetSession: false });
      expect(unsafeWorkspace.run.stdoutExcerpt).toContain("rejected as untrusted");

      const projectFallback = await runAndDrain(skillTestIssueId, { resumeFromRunId: randomUUID() });
      expect(projectFallback.run.stdoutExcerpt).toContain(
        "No project workspace directory is currently available",
      );

      const noLocalCwd = await runAndDrain(noLocalCwdIssueId, {
        projectWorkspaceId: randomUUID(),
      });
      expect(noLocalCwd.run.stdoutExcerpt).toContain("Selected project workspace");
      expect(noLocalCwd.context.paperclipWorkspace?.source).toBe("project_primary");

      const managedWorkspace = await runAndDrain(managedIssueId);
      expect(managedWorkspace.context.paperclipWorkspace).toMatchObject({
        cwd: resolveManagedProjectWorkspaceDir({
          companyId,
          projectId: managedProjectId,
          repoName: null,
        }),
        source: "project_primary",
      });

      const failingManagedWorkspace = await runAndDrain(failingManagedIssueId);
      expect(failingManagedWorkspace.run.stdoutExcerpt).toContain("Failed to prepare managed checkout");
      expect(failingManagedWorkspace.run.stdoutExcerpt).toContain("Using fallback workspace");

      const inheritedResponsibleUserRun = await service.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId: responsibleUserIssueId },
        contextSnapshot: { issueId: responsibleUserIssueId },
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      });
      expect(inheritedResponsibleUserRun).not.toBeNull();
      expect((await waitForRun(service, inheritedResponsibleUserRun!.id))?.responsibleUserId).toBe("parent-owner");
      await service.waitForRunExecutionDrain(inheritedResponsibleUserRun!.id);

      const automationUserRun = await service.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "manual_recovery",
        requestedByActorType: "user",
        requestedByActorId: "automation-requester",
      });
      expect(automationUserRun).not.toBeNull();
      expect((await waitForRun(service, automationUserRun!.id))?.responsibleUserId).toBe("automation-requester");
      await service.waitForRunExecutionDrain(automationUserRun!.id);

      const unscopedRun = await service.wakeup(agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "manual",
        payload: { resetSession: false },
        contextSnapshot: { resetSession: false },
        requestedByActorType: "user",
        requestedByActorId: "requesting-user",
      });
      expect(unscopedRun).not.toBeNull();
      expect((await waitForRun(service, unscopedRun!.id))?.status).toBe("succeeded");
      await service.waitForRunExecutionDrain(unscopedRun!.id);

      const heavySessionId = "run-heavy-session";
      await updateTaskSession(heavySessionId, existingSessionCwd);
      await db.insert(heartbeatRuns).values([
        {
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: "manual",
          status: "succeeded",
          sessionIdAfter: heavySessionId,
          resultJson: {},
          contextSnapshot: { issueId },
          responsibleUserId: "parent-owner",
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
        {
          companyId,
          agentId,
          invocationSource: "on_demand",
          triggerDetail: "manual",
          status: "succeeded",
          sessionIdAfter: heavySessionId,
          resultJson: {},
          contextSnapshot: { issueId },
          responsibleUserId: "parent-owner",
          createdAt: new Date("2026-07-01T01:00:00.000Z"),
          updatedAt: new Date("2026-07-01T01:00:00.000Z"),
        },
      ]);
      await runAndDrain(issueId);
    } finally {
      if (previousWorkspaceSync === undefined) delete process.env.PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC;
      else process.env.PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC = previousWorkspaceSync;
      await fs.rm(existingSessionCwd, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects dispatch when no responsible user can be resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ownerless Coverage Company",
      issuePrefix: "OWN",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: null,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ownerless Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(
      heartbeatService(db).wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "ownerless_dispatch",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({ code: "responsible_user_unresolved" }),
    });

    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });
    await expect(heartbeatService(db).resumeQueuedRuns()).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        code: "responsible_user_unresolved",
        runId: queuedRunId,
      }),
    });
    await expect(heartbeatService(db).reportRunActivity(randomUUID())).resolves.toBeNull();
  });

  it("records daily-cap skips for issue-scoped and unscoped dispatches", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Daily Cap Coverage Company",
      issuePrefix: "DCC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "daily-cap-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Daily Cap Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, maxDailyRuns: 0 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Daily cap issue",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "DCC-1",
    });

    const service = heartbeatService(db);
    await expect(service.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      payload: { issueId },
      contextSnapshot: { issueId },
    })).resolves.toBeNull();
    await expect(service.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "manual_daily_cap",
    })).resolves.toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(skipped).toHaveLength(2);
    expect(skipped.every((request) => request.status === "skipped")).toBe(true);
    expect(skipped.map((request) => request.reason)).toEqual([
      "heartbeat.daily_run_limit",
      "heartbeat.daily_run_limit",
    ]);
    expect(skipped.map((request) => request.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId }),
      expect.objectContaining({ heartbeatSkip: expect.objectContaining({ observed: 0, limit: 0 }) }),
    ]));

    const [updatedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(updatedAgent?.lastHeartbeatAt).toBeInstanceOf(Date);
  });

  it("exercises heartbeat public read and runtime-state service paths", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const exhaustedRunId = randomUUID();
    const runningRunId = randomUUID();
    const providerQuotaRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Public Service Coverage Company",
      issuePrefix: "PSC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "public-service-owner",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Public Service Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Public service issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "PSC-1",
    });
    await db.insert(heartbeatRuns).values([
      {
        id: exhaustedRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        responsibleUserId: "public-service-owner",
        contextSnapshot: { issueId },
        resultJson: { summary: "complete" },
        startedAt: new Date("2026-08-17T00:00:00.000Z"),
        finishedAt: new Date("2026-08-17T00:01:00.000Z"),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "running",
        responsibleUserId: "public-service-owner",
        contextSnapshot: { issueId },
        startedAt: new Date("2026-08-17T00:02:00.000Z"),
      },
      {
        id: providerQuotaRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "failed",
        errorCode: "provider_quota",
        responsibleUserId: "public-service-owner",
        contextSnapshot: {},
        resultJson: {},
        startedAt: new Date("2026-08-17T00:03:00.000Z"),
        finishedAt: new Date("2026-08-17T00:04:00.000Z"),
      },
    ]);
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: exhaustedRunId,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Bounded retry exhausted after coverage attempts",
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: workspaceAdapterType,
      taskKey: issueId,
      sessionParamsJson: { mode: "coverage" },
      sessionDisplayId: "public-session",
    });

    const service = heartbeatService(db);
    expect(await service.getRuntimeState(otherAgentId)).toBeNull();
    expect(await service.getRuntimeState(agentId)).toMatchObject({
      agentId,
      sessionDisplayId: "public-session",
      sessionParamsJson: { mode: "coverage" },
    });
    await expect(service.listTaskSessions(otherAgentId)).rejects.toThrow("Agent not found");
    expect(await service.listTaskSessions(agentId)).toHaveLength(1);
    await expect(service.resetRuntimeSession(otherAgentId)).rejects.toThrow("Agent not found");
    expect(await service.resetRuntimeSession(agentId, { taskKey: issueId })).toMatchObject({
      sessionDisplayId: null,
      clearedTaskSessions: 1,
    });
    expect(await service.resetRuntimeSession(agentId)).toMatchObject({
      sessionDisplayId: null,
      sessionParamsJson: null,
    });

    expect(await service.listEvents(exhaustedRunId)).toHaveLength(1);
    expect(await service.listEvents(exhaustedRunId, -1, 5000)).toHaveLength(1);
    expect(await service.getRetryExhaustedReason(exhaustedRunId)).toContain("Bounded retry exhausted");
    expect(await service.getRetryExhaustedReason(runningRunId)).toBeNull();
    await expect(service.readLog(randomUUID())).rejects.toThrow("Heartbeat run not found");
    await expect(service.readLog(exhaustedRunId)).rejects.toThrow("Run log not found");
    await expect(service.waitForRunExecutionDrain(randomUUID())).resolves.toBeUndefined();
    await expect(service.waitForRunExecutionDrain(randomUUID(), { timeoutMs: 1, intervalMs: 1 })).resolves.toBeUndefined();

    expect(await service.list(companyId)).toHaveLength(3);
    expect(await service.list(companyId, agentId, 1, { summary: true })).toHaveLength(1);
    expect(await service.list(companyId, otherAgentId)).toHaveLength(0);
    expect(await service.getRunIssueSummary(exhaustedRunId)).toMatchObject({ id: exhaustedRunId });
    expect(await service.getRunIssueSummary(randomUUID())).toBeNull();
    expect(await service.getActiveRunForAgent(agentId)).toMatchObject({ id: runningRunId });
    expect(await service.getActiveRunForAgent(otherAgentId)).toBeNull();
    expect(await service.getActiveRunIssueSummaryForAgent(agentId)).toMatchObject({ id: runningRunId });
    expect(await service.getActiveRunIssueSummaryForAgent(otherAgentId)).toBeNull();
    await expect(service.scheduleBoundedRetry(randomUUID())).resolves.toEqual({ outcome: "missing_run" });
    await expect(service.scheduleBoundedRetry(providerQuotaRunId, {
      now: new Date("2026-08-17T00:05:00.000Z"),
      random: () => 0.5,
    })).resolves.toMatchObject({ outcome: "scheduled" });

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Drain Timeout Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const emptyResultAgentId = randomUUID();
    const interactionFailureAgentId = randomUUID();
    await db.insert(agents).values([
      {
        id: emptyResultAgentId,
        companyId,
        name: "Empty Result Agent",
        role: "engineer",
        status: "idle",
        adapterType: workspaceAdapterType,
        adapterConfig: {
          workspaceStrategy: {},
          workspaceRuntime: { command: "coverage-runtime" },
          desiredState: "invalid",
        },
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: interactionFailureAgentId,
        companyId,
        name: "Custom Failure Agent",
        role: "engineer",
        status: "idle",
        adapterType: workspaceAdapterType,
        adapterConfig: {
          workspaceStrategy: {},
          workspaceRuntime: {},
          desiredState: "invalid",
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const emptyResultRun = await service.invoke(emptyResultAgentId, "on_demand", {
      taskKey: `empty-result-${randomUUID()}`,
      wakeReason: "manual",
    }, "manual");
    expect(emptyResultRun).not.toBeNull();
    expect((await waitForRun(service, emptyResultRun!.id))?.status).toBe("succeeded");
    await service.waitForRunExecutionDrain(emptyResultRun!.id);

    for (const interactionStatus of ["pending", "accepted"] as const) {
      const interactionRun = await service.invoke(interactionFailureAgentId, "on_demand", {
        taskKey: `interaction-${interactionStatus}-${randomUUID()}`,
        interactionId: randomUUID(),
        interactionStatus,
        mutation: "interaction",
        wakeReason: "issue_commented",
      }, "manual");
      expect(interactionRun).not.toBeNull();
      expect((await waitForRun(service, interactionRun!.id))?.status).toBe("failed");
      await service.waitForRunExecutionDrain(interactionRun!.id);
    }

    executionDelayMs = 200;
    try {
      const liveRun = await service.invoke(otherAgentId, "on_demand", {
        taskKey: `drain-timeout-${randomUUID()}`,
        wakeReason: "manual",
      }, "manual");
      expect(liveRun).not.toBeNull();
      const runningDeadline = Date.now() + 5_000;
      while (Date.now() < runningDeadline && (await service.getRun(liveRun!.id))?.status !== "running") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await service.getRun(liveRun!.id))?.status).toBe("running");
      await expect(service.waitForRunExecutionDrain(liveRun!.id, {
        timeoutMs: 1,
        intervalMs: 1,
      })).rejects.toThrow(`Timed out waiting for heartbeat run ${liveRun!.id} execution to drain`);
      await service.waitForRunExecutionDrain(liveRun!.id);
    } finally {
      executionDelayMs = 0;
    }
  });

  it("cancels agent, company, and project budget-scope work", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companies).values({
      id: companyId,
      name: "Budget Cancellation Coverage Company",
      issuePrefix: "BCC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "budget-owner",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Budget Project",
      status: "active",
    });
    await db.insert(agents).values(agentIds.map((id, index) => ({
      id,
      companyId,
      name: `Budget Coverage Agent ${index}`,
      role: "engineer",
      status: "idle" as const,
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));

    const service = heartbeatService(db);
    expect(await service.cancelInvocationsForAgents(["", ""], "nothing to cancel")).toEqual({
      agentIds: [],
      runsCancelled: 0,
      wakeupsCancelled: 0,
    });

    const seedPending = async (agentId: string, suffix: number, projectScoped = false) => {
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        responsibleUserId: "budget-owner",
        contextSnapshot: projectScoped ? { issueId, projectId } : { issueId },
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        projectId: projectScoped ? projectId : null,
        title: `Budget issue ${suffix}`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: runId,
        issueNumber: suffix,
        identifier: `BCC-${suffix}`,
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupId,
        companyId,
        agentId,
        source: "on_demand",
        triggerDetail: "manual",
        reason: "budget coverage pending",
        payload: projectScoped ? { issueId, projectId } : { issueId },
        status: "deferred_issue_execution",
      });
      return { issueId, runId, wakeupId };
    };

    const agentWork = await seedPending(agentIds[0]!, 1);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentIds[0]!,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "standalone budget coverage pending",
      payload: {},
      status: "queued",
    });
    expect(await service.cancelInvocationsForAgents([agentIds[0]!, agentIds[0]!, ""], "agent pause")).toEqual({
      agentIds: [agentIds[0]],
      runsCancelled: 1,
      wakeupsCancelled: 1,
    });
    expect((await service.getRun(agentWork.runId))?.status).toBe("cancelled");

    const companyWork = await seedPending(agentIds[1]!, 2);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentIds[1]!,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "standalone company budget wake",
      payload: {},
      status: "queued",
    });
    await service.cancelBudgetScopeWork({ companyId, scopeType: "company", scopeId: companyId });
    expect((await service.getRun(companyWork.runId))?.status).toBe("cancelled");

    const projectWork = await seedPending(agentIds[2]!, 3, true);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentIds[2]!,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "standalone project budget wake",
      payload: { projectId },
      status: "queued",
    });
    await service.cancelBudgetScopeWork({ companyId, scopeType: "project", scopeId: projectId });
    expect((await service.getRun(projectWork.runId))?.status).toBe("cancelled");

    const agentBudgetWork = await seedPending(agentIds[0]!, 4);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: agentIds[0]!,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "standalone agent budget wake",
      payload: {},
      status: "queued",
    });
    await service.cancelBudgetScopeWork({ companyId, scopeType: "agent", scopeId: agentIds[0]! });
    expect((await service.getRun(agentBudgetWork.runId))?.status).toBe("cancelled");

    const inMemoryRunId = randomUUID();
    const persistedProcessRunId = randomUUID();
    const directCancelProcessRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      {
        id: inMemoryRunId,
        companyId,
        agentId: agentIds[2]!,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        processPid: 99_999_991,
        responsibleUserId: "budget-owner",
        contextSnapshot: {},
      },
      {
        id: persistedProcessRunId,
        companyId,
        agentId: agentIds[2]!,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        processPid: 99_999_992,
        responsibleUserId: "budget-owner",
        contextSnapshot: {},
      },
      {
        id: directCancelProcessRunId,
        companyId,
        agentId: agentIds[1]!,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "queued",
        processPid: 99_999_993,
        responsibleUserId: "budget-owner",
        contextSnapshot: {},
      },
    ]);
    runningProcesses.set(inMemoryRunId, {
      child: { pid: 99_999_991 } as ChildProcess,
      processGroupId: null,
      graceSec: 1,
    });
    await service.cancelActiveForAgent(agentIds[2]!, "process coverage cancellation");
    expect(runningProcesses.has(inMemoryRunId)).toBe(false);
    expect((await service.getRun(persistedProcessRunId))?.status).toBe("cancelled");
    expect((await service.cancelRun(directCancelProcessRunId))?.status).toBe("cancelled");

    await service.cancelBudgetScopeWork({ companyId, scopeType: "company", scopeId: companyId });

    expect(await service.cancelInvocationsForAgents([agentIds[2]!], "nothing remains")).toEqual({
      agentIds: [agentIds[2]],
      runsCancelled: 0,
      wakeupsCancelled: 0,
    });

    await expect(service.cancelRun(randomUUID())).rejects.toThrow("Heartbeat run not found");
    expect(await service.cancelRun(agentBudgetWork.runId)).toMatchObject({ status: "cancelled" });
  });
});
