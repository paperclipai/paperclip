import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueThreadInteractions,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.ts";
import { routineService } from "../services/routines.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const execFileAsync = promisify(execFile);
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline case workspace tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

describeEmbeddedPostgres("pipeline executionWorkspaceScope: case", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let workspaces!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-case-workspace-");
    db = createDb(tempDb.connectionString);
    svc = pipelineService(db, { heartbeat: noopHeartbeat });
    workspaces = executionWorkspaceService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({ state: "unknown" as const, headRef: null, headSha: null })),
      workspaceReaperCooldownDays: 0,
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(routines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { scope: "case" | null }) {
    const [company] = await db.insert(companies).values({
      name: "Pipeline Co",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const companyId = company!.id;
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const [project] = await db.insert(projects).values({
      companyId,
      name: "Client repo",
      status: "in_progress",
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", allowIssueOverride: true },
    }).returning();
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId: project!.id,
      name: "Primary",
      isPrimary: true,
      sharedWorkspaceKey: `primary-${randomUUID().slice(0, 8)}`,
    });
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Builder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    // Keep a routine around so the agent is a valid routine assignee in this company.
    await routineService(db, { heartbeat: noopHeartbeat }).create(companyId, {
      projectId: null,
      goalId: null,
      parentIssueId: null,
      title: "Seed",
      description: null,
      assigneeAgentId: agent!.id,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed",
    }, {});
    const pipeline = await svc.createPipeline({
      companyId,
      key: `delivery-${randomUUID().slice(0, 8)}`,
      name: "Delivery",
      enforceTransitions: false,
      actor: userActor,
    });
    const stages = await svc.listStages(companyId, pipeline.id);
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    for (const key of ["intake", "in_progress"]) {
      await svc.updateStage({
        companyId,
        pipelineId: pipeline.id,
        stageId: byKey.get(key)!.id,
        patch: {
          config: {
            automation: {
              assigneeAgentId: agent!.id,
              instructionsBody: `Work the ${key} step.`,
              projectId: project!.id,
              ...(options.scope ? { executionWorkspaceScope: options.scope } : {}),
            },
          },
        },
        actor: userActor,
      });
    }
    return { companyId, projectId: project!.id, pipeline, byKey };
  }

  async function latestStageIssue(caseId: string) {
    const [row] = await db
      .select({ issueId: pipelineAutomationExecutions.executionIssueId })
      .from(pipelineAutomationExecutions)
      .where(eq(pipelineAutomationExecutions.caseId, caseId))
      .orderBy(desc(pipelineAutomationExecutions.createdAt))
      .limit(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, row!.issueId!));
    return issue!;
  }

  async function caseRow(caseId: string) {
    const [row] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, caseId));
    return row!;
  }

  /** What the heartbeat does on the first run: realise an isolated workspace and bind the issue to it. */
  async function realiseWorkspace(input: { companyId: string; projectId: string; issueId: string }) {
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId: input.companyId,
      projectId: input.projectId,
      sourceIssueId: input.issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Case worktree",
      status: "active",
      providerType: "git_worktree",
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, input.issueId));
    return workspace!.id;
  }

  async function move(companyId: string, caseId: string, toStageKey: string) {
    const current = await caseRow(caseId);
    const moved = await svc.transitionCase({
      companyId, caseId, toStageKey, expectedVersion: current.version, actor: userActor,
    });
    expect(moved.automationExecution.status).toBe("succeeded");
    return latestStageIssue(caseId);
  }

  it("without the opt-in, every stage task keeps its own workspace and workspace_ref stays empty", async () => {
    const { companyId, projectId, pipeline, byKey } = await seed({ scope: null });
    const [intake] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, byKey.get("intake")!.id));
    expect((intake!.config as { onEnter?: Record<string, unknown> }).onEnter).not.toHaveProperty("executionWorkspaceScope");

    const created = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-1", title: "Ticket", actor: userActor });
    const first = await latestStageIssue(created.case.id);
    await realiseWorkspace({ companyId, projectId, issueId: first.id });
    const second = await move(companyId, created.case.id, "in_progress");

    expect(second.id).not.toBe(first.id);
    expect(second.executionWorkspaceId).toBeNull();
    expect(second.executionWorkspacePreference).toBeNull();
    expect((await caseRow(created.case.id)).workspaceRef).toBeNull();
  });

  it("first stage records its task, later stages and a rework loop reuse the case workspace", async () => {
    const { companyId, projectId, pipeline, byKey } = await seed({ scope: "case" });
    const [intake] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, byKey.get("intake")!.id));
    expect((intake!.config as { onEnter?: Record<string, unknown> }).onEnter).toMatchObject({
      type: "run_routine",
      executionWorkspaceScope: "case",
    });

    // First stage: no case workspace yet, so the task gets its own and the case records it.
    const created = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-2", title: "Ticket", actor: userActor });
    const first = await latestStageIssue(created.case.id);
    expect(first.executionWorkspaceId).toBeNull();
    expect((await caseRow(created.case.id)).workspaceRef).toEqual({ sourceIssueId: first.id });

    const workspaceId = await realiseWorkspace({ companyId, projectId, issueId: first.id });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.id));

    // Second stage: reuses the first task's workspace and records its id.
    const second = await move(companyId, created.case.id, "in_progress");
    expect(second).toMatchObject({
      executionWorkspaceId: workspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    expect((await caseRow(created.case.id)).workspaceRef).toEqual({
      sourceIssueId: first.id,
      executionWorkspaceId: workspaceId,
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, second.id));

    // Rework loop back to the first stage: same workspace again.
    const rework = await move(companyId, created.case.id, "intake");
    expect(rework.id).not.toBe(first.id);
    expect(rework).toMatchObject({ executionWorkspaceId: workspaceId, executionWorkspacePreference: "reuse_existing" });

    const [event] = await db
      .select({ payload: pipelineCaseEvents.payload })
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, created.case.id))
      .orderBy(desc(pipelineCaseEvents.createdAt))
      .limit(1);
    expect(event!.payload).toMatchObject({
      executionWorkspaceScope: "case",
      executionWorkspace: { reused: true, executionWorkspaceId: workspaceId },
    });
  });

  it("an archived case workspace is replaced by the next stage task's own workspace", async () => {
    const { companyId, projectId, pipeline } = await seed({ scope: "case" });
    const created = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-3", title: "Ticket", actor: userActor });
    const first = await latestStageIssue(created.case.id);
    const workspaceId = await realiseWorkspace({ companyId, projectId, issueId: first.id });
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, workspaceId));

    const second = await move(companyId, created.case.id, "in_progress");
    expect(second.executionWorkspaceId).toBeNull();
    expect((await caseRow(created.case.id)).workspaceRef).toEqual({ sourceIssueId: second.id });
  });

  it("a child case gets its own workspace, not the parent's", async () => {
    const { companyId, projectId, pipeline } = await seed({ scope: "case" });
    const parent = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-4", title: "Parent", actor: userActor });
    const parentIssue = await latestStageIssue(parent.case.id);
    const parentWorkspaceId = await realiseWorkspace({ companyId, projectId, issueId: parentIssue.id });
    const parentSecond = await move(companyId, parent.case.id, "in_progress");
    expect(parentSecond.executionWorkspaceId).toBe(parentWorkspaceId);

    const child = await svc.ingestCase({
      companyId, pipelineId: pipeline.id, caseKey: "T-4a", title: "Child", parentCaseId: parent.case.id, actor: userActor,
    });
    const childIssue = await latestStageIssue(child.case.id);
    expect(childIssue.executionWorkspaceId).toBeNull();
    expect((await caseRow(child.case.id)).workspaceRef).toEqual({ sourceIssueId: childIssue.id });
  });

  it("a stage settings save without the scope key keeps the scope; an explicit null clears it", async () => {
    const { companyId, pipeline, byKey } = await seed({ scope: "case" });
    const stageId = byKey.get("intake")!.id;
    const onEnterOf = async () => {
      const [row] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stageId));
      return (row!.config as { onEnter?: Record<string, unknown> }).onEnter;
    };
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));

    // What the settings form sends: automation rebuilt without executionWorkspaceScope.
    await svc.updateStage({
      companyId,
      pipelineId: pipeline.id,
      stageId,
      patch: { config: { automation: { assigneeAgentId: agent!.id, instructionsBody: "Edited instructions." } } },
      actor: userActor,
    });
    expect(await onEnterOf()).toMatchObject({ type: "run_routine", executionWorkspaceScope: "case" });

    await svc.updateStage({
      companyId,
      pipelineId: pipeline.id,
      stageId,
      patch: {
        config: {
          automation: { assigneeAgentId: agent!.id, instructionsBody: "Edited instructions.", executionWorkspaceScope: null },
        },
      },
      actor: userActor,
    });
    expect(await onEnterOf()).not.toHaveProperty("executionWorkspaceScope");
  });

  it("a project-free scoped stage does not reuse the case's project workspace", async () => {
    const { companyId, projectId, pipeline, byKey } = await seed({ scope: "case" });
    const [agent] = await db.select().from(agents).where(eq(agents.companyId, companyId));
    await svc.updateStage({
      companyId,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          automation: { assigneeAgentId: agent!.id, instructionsBody: "No repo here.", executionWorkspaceScope: "case" },
        },
      },
      actor: userActor,
    });

    const created = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-5", title: "Ticket", actor: userActor });
    const first = await latestStageIssue(created.case.id);
    await realiseWorkspace({ companyId, projectId, issueId: first.id });

    const second = await move(companyId, created.case.id, "in_progress");
    expect(second.projectId).toBeNull();
    expect(second.executionWorkspaceId).toBeNull();
    expect(second.executionWorkspacePreference).toBeNull();
    expect((await caseRow(created.case.id)).workspaceRef).toEqual({ sourceIssueId: first.id });
  });

  it("a workspace_ref pointing at a workspace no stage task of the case is bound to is not reused", async () => {
    const { companyId, projectId, pipeline } = await seed({ scope: "case" });
    const other = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-6", title: "Other", actor: userActor });
    const otherIssue = await latestStageIssue(other.case.id);
    const otherWorkspaceId = await realiseWorkspace({ companyId, projectId, issueId: otherIssue.id });

    const created = await svc.ingestCase({ companyId, pipelineId: pipeline.id, caseKey: "T-7", title: "Ticket", actor: userActor });
    await latestStageIssue(created.case.id);
    await svc.patchCaseContent({
      companyId,
      caseId: created.case.id,
      workspaceRef: { sourceIssueId: otherIssue.id, executionWorkspaceId: otherWorkspaceId },
      actor: userActor,
    });

    const second = await move(companyId, created.case.id, "in_progress");
    expect(second.executionWorkspaceId).toBeNull();
    expect(second.executionWorkspacePreference).not.toBe("reuse_existing");
    expect((await caseRow(created.case.id)).workspaceRef).toEqual({ sourceIssueId: second.id });
  });

  describe("terminal-workspace reaper", () => {
    // A worktree whose HEAD is the base: delivered by ancestry, so only the guards decide.
    async function seedDeliveredCaseWorkspace(input: {
      caseTerminal: boolean;
      recordWorkspaceId: boolean;
      openBoundIssue?: boolean;
      /** The case's first task was bound to this already existing workspace. */
      refIssueReusedWorkspace?: boolean;
      /** A stage of the pipeline opts in to the case scope (default true). */
      optedIn?: boolean;
      /** The case's tasks are its own stage tasks (automation links); default true. */
      linkStageTasks?: boolean;
    }) {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-case-workspace-"));
      tempDirs.add(repoRoot);
      await runGit(repoRoot, ["init"]);
      await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
      await runGit(repoRoot, ["config", "user.email", "test@paperclip.local"]);
      await fs.writeFile(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
      await runGit(repoRoot, ["add", "README.md"]);
      await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
      await runGit(repoRoot, ["branch", "-M", "main"]);
      const worktreePath = path.join(path.dirname(repoRoot), `paperclip-case-wt-${randomUUID()}`);
      tempDirs.add(worktreePath);
      const branchName = `case-${randomUUID().slice(0, 8)}`;
      await runGit(repoRoot, ["branch", branchName]);
      await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);

      const { companyId, projectId, pipeline } = await seed({ scope: input.optedIn === false ? null : "case" });
      const [workspace] = await db.insert(executionWorkspaces).values({
        companyId,
        projectId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Case worktree",
        status: "active",
        cwd: worktreePath,
        providerRef: worktreePath,
        providerType: "git_worktree",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        baseRef: "main",
        branchName,
      }).returning();
      const [sourceIssue] = await db.insert(issues).values({
        companyId,
        projectId,
        title: "First stage task",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspace!.id,
      }).returning();
      await db.update(executionWorkspaces).set({ sourceIssueId: sourceIssue!.id }).where(eq(executionWorkspaces.id, workspace!.id));
      const openBoundIssueId = input.openBoundIssue
        ? await db.insert(issues).values({
          companyId,
          projectId,
          title: "Later stage task",
          status: "todo",
          priority: "medium",
          executionWorkspaceId: workspace!.id,
          executionWorkspacePreference: "reuse_existing",
        }).returning().then((rows) => rows[0]!.id)
        : null;
      const refIssueId = input.refIssueReusedWorkspace
        ? await db.insert(issues).values({
          companyId,
          projectId,
          title: "Case task on an existing workspace",
          status: "done",
          priority: "medium",
          executionWorkspaceId: workspace!.id,
          executionWorkspacePreference: "reuse_existing",
        }).returning().then((rows) => rows[0]!.id)
        : sourceIssue!.id;
      const created = await svc.ingestCase({
        companyId,
        pipelineId: pipeline.id,
        stageKey: "review",
        caseKey: `R-${randomUUID().slice(0, 6)}`,
        title: "Ticket",
        workspaceRef: input.recordWorkspaceId
          ? { sourceIssueId: refIssueId, executionWorkspaceId: workspace!.id }
          : { sourceIssueId: refIssueId },
        actor: userActor,
      });
      if (input.linkStageTasks !== false) {
        // What a stage automation records for each stage task it creates.
        for (const issueId of [refIssueId, openBoundIssueId].filter((id): id is string => id !== null)) {
          await db.insert(pipelineCaseIssueLinks).values({
            companyId,
            caseId: created.case.id,
            issueId,
            role: "automation",
            automationAttemptId: randomUUID(),
          });
        }
      }
      if (input.caseTerminal) {
        await db.update(pipelineCases).set({ terminalKind: "done", terminalAt: new Date() }).where(eq(pipelineCases.id, created.case.id));
      }
      return { workspaceId: workspace!.id, caseId: created.case.id, companyId, refIssueId };
    }

    async function statusOf(workspaceId: string) {
      const [row] = await db.select({ status: executionWorkspaces.status }).from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      return row!.status;
    }

    it("keeps a workspace an open case holds, by id or by its source issue", async () => {
      const { workspaceId: byId } = await seedDeliveredCaseWorkspace({ caseTerminal: false, recordWorkspaceId: true });
      const { workspaceId: bySourceIssue } = await seedDeliveredCaseWorkspace({ caseTerminal: false, recordWorkspaceId: false });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 0, skippedNonTerminalTree: 2 });
      expect(await statusOf(byId)).toBe("active");
      expect(await statusOf(bySourceIssue)).toBe("active");
    }, 30_000);

    it("keeps a workspace an open case's source issue was bound to, before the id is recorded", async () => {
      const { workspaceId } = await seedDeliveredCaseWorkspace({
        caseTerminal: false,
        recordWorkspaceId: false,
        refIssueReusedWorkspace: true,
      });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await statusOf(workspaceId)).toBe("active");
    }, 30_000);

    it("keeps it while a terminal case still has an open task bound to it", async () => {
      const { workspaceId } = await seedDeliveredCaseWorkspace({ caseTerminal: true, recordWorkspaceId: true, openBoundIssue: true });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 0, skippedNonTerminalTree: 1 });
      expect(await statusOf(workspaceId)).toBe("active");
    }, 30_000);

    it("reclaims it once the case is terminal and no bound task is open", async () => {
      const { workspaceId } = await seedDeliveredCaseWorkspace({ caseTerminal: true, recordWorkspaceId: true });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 1, skippedNonTerminalTree: 0 });
      expect(await statusOf(workspaceId)).toBe("archived");
    }, 30_000);

    it("a workspace_ref set through the case update API does not hold a workspace without an opted-in stage", async () => {
      const { workspaceId, caseId, companyId, refIssueId } = await seedDeliveredCaseWorkspace({
        caseTerminal: false,
        recordWorkspaceId: false,
        optedIn: false,
      });
      await svc.patchCaseContent({
        companyId,
        caseId,
        workspaceRef: { sourceIssueId: refIssueId, executionWorkspaceId: workspaceId },
        actor: userActor,
      });
      expect((await caseRow(caseId)).workspaceRef).toEqual({ sourceIssueId: refIssueId, executionWorkspaceId: workspaceId });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 1, skippedNonTerminalTree: 0 });
      expect(await statusOf(workspaceId)).toBe("archived");
    }, 30_000);

    it("an opted-in case does not hold a workspace none of its stage tasks is bound to", async () => {
      const { workspaceId } = await seedDeliveredCaseWorkspace({
        caseTerminal: false,
        recordWorkspaceId: true,
        linkStageTasks: false,
      });

      const sweep = await workspaces.sweepTerminalWorkspaces();

      expect(sweep).toMatchObject({ archived: 1, skippedNonTerminalTree: 0 });
      expect(await statusOf(workspaceId)).toBe("archived");
    }, 30_000);
  });
});
