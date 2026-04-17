import { and, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import {
  findWorkspaceCommandDefinition,
  matchWorkspaceRuntimeServiceToCommand,
  pullRequestResultRequestSchema,
  updateExecutionWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
  type ExecutionWorkspace,
  type ExecutionWorkspacePullRequestRecord,
  type ExecutionWorkspaceStatus,
  type PullRequestPolicy,
  type PullRequestRecordStatus,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import {
  applyPullRequestResult,
  buildPullRequestRequestRecord,
  mergePullRequestRecordIntoMetadata,
  pullRequestRequestResponse,
  readPullRequestRecord,
} from "../services/execution-workspaces.js";
import { mergeExecutionWorkspaceConfig, readExecutionWorkspaceConfig } from "../services/execution-workspaces.js";
import {
  parseProjectExecutionWorkspacePolicy,
  pullRequestPolicyBlocksArchive,
  pullRequestPolicyRequestsAutoOpen,
} from "../services/execution-workspace-policy.js";
import {
  cancelArchiveTimeout,
  onPullRequestRequested,
} from "../services/execution-workspace-timeout.js";
import { runArchiveSideEffects } from "../services/execution-workspace-archive.js";
import { readProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  ensurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectExecutionWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageExecutionWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";

export function executionWorkspaceRoutes(db: Db) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const filters = {
      projectId: req.query.projectId as string | undefined,
      projectWorkspaceId: req.query.projectWorkspaceId as string | undefined,
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
    };
    const workspaces = req.query.summary === "true"
      ? await svc.listSummaries(companyId, filters)
      : await svc.list(companyId, filters);
    res.json(workspaces);
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    res.json(workspace);
  });

  router.get("/execution-workspaces/:id/close-readiness", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    const readiness = await svc.getCloseReadiness(id);
    if (!readiness) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    res.json(readiness);
  });

  router.get("/execution-workspaces/:id/workspace-operations", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    const operations = await workspaceOperationsSvc.listForExecutionWorkspace(id);
    res.json(operations);
  });

  async function handleExecutionWorkspaceRuntimeCommand(req: Request, res: Response) {
    const id = req.params.id as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      res.status(404).json({ error: "Workspace command action not found" });
      return;
    }

    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    await assertCanManageExecutionWorkspaceRuntimeServices(db, req, {
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
      sourceIssueId: existing.sourceIssueId,
    });

    const workspaceCwd = existing.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Execution workspace needs a local path before Paperclip can run workspace commands" });
      return;
    }

    const projectWorkspace = existing.projectWorkspaceId
      ? await db
          .select({
            id: projectWorkspaces.id,
            cwd: projectWorkspaces.cwd,
            repoUrl: projectWorkspaces.repoUrl,
            repoRef: projectWorkspaces.repoRef,
            defaultRef: projectWorkspaces.defaultRef,
            metadata: projectWorkspaces.metadata,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, existing.projectWorkspaceId),
              eq(projectWorkspaces.companyId, existing.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const projectWorkspaceRuntime = readProjectWorkspaceRuntimeConfig(
      (projectWorkspace?.metadata as Record<string, unknown> | null) ?? null,
    )?.workspaceRuntime ?? null;
    const projectPolicy = existing.projectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, existing.projectId),
              eq(projects.companyId, existing.companyId),
            ),
          )
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const effectiveRuntimeConfig = existing.config?.workspaceRuntime ?? projectWorkspaceRuntime ?? null;
    const target = req.body as { workspaceCommandId?: string | null; runtimeServiceId?: string | null; serviceIndex?: number | null };
    const configuredServices = effectiveRuntimeConfig
      ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: effectiveRuntimeConfig })
      : [];
    const workspaceCommand = effectiveRuntimeConfig
      ? findWorkspaceCommandDefinition(effectiveRuntimeConfig, target.workspaceCommandId ?? null)
      : null;
    if (target.workspaceCommandId && !workspaceCommand) {
      res.status(404).json({ error: "Workspace command not found for this execution workspace" });
      return;
    }
    if (target.runtimeServiceId && !(existing.runtimeServices ?? []).some((service) => service.id === target.runtimeServiceId)) {
      res.status(404).json({ error: "Runtime service not found for this execution workspace" });
      return;
    }
    const matchedRuntimeService =
      workspaceCommand?.kind === "service" && !target.runtimeServiceId
        ? matchWorkspaceRuntimeServiceToCommand(workspaceCommand, existing.runtimeServices ?? [])
        : null;
    const selectedRuntimeServiceId = target.runtimeServiceId ?? matchedRuntimeService?.id ?? null;
    const selectedServiceIndex =
      workspaceCommand?.kind === "service"
        ? workspaceCommand.serviceIndex
        : target.serviceIndex ?? null;
    if (
      selectedServiceIndex !== undefined
      && selectedServiceIndex !== null
      && (selectedServiceIndex < 0 || selectedServiceIndex >= configuredServices.length)
    ) {
      res.status(422).json({ error: "Selected runtime service is not defined in this execution workspace runtime config" });
      return;
    }
    if (workspaceCommand?.kind === "job" && action !== "run") {
      res.status(422).json({ error: `Workspace job "${workspaceCommand.name}" can only be run` });
      return;
    }
    if (workspaceCommand?.kind === "service" && action === "run") {
      res.status(422).json({ error: `Workspace service "${workspaceCommand.name}" should be started or restarted, not run` });
      return;
    }
    if (action === "run" && !workspaceCommand) {
      res.status(422).json({ error: "Select a workspace job to run" });
      return;
    }

    if ((action === "start" || action === "restart") && !effectiveRuntimeConfig) {
      res.status(422).json({ error: "Execution workspace has no workspace command configuration or inherited project workspace default" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperationsSvc.createRecorder({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
    });
    let runtimeServiceCount = existing.runtimeServices?.length ?? 0;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: workspaceCommand?.command ?? `workspace command ${action}`,
      cwd: existing.cwd,
      metadata: {
        action,
        executionWorkspaceId: existing.id,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
      run: async () => {
        const ensureWorkspaceAvailable = async () =>
          await ensurePersistedExecutionWorkspaceAvailable({
            base: {
              baseCwd: projectWorkspace?.cwd ?? workspaceCwd,
              source: existing.mode === "shared_workspace" ? "project_primary" : "task_session",
              projectId: existing.projectId,
              workspaceId: existing.projectWorkspaceId,
              repoUrl: existing.repoUrl,
              repoRef: existing.baseRef,
            },
            workspace: {
              mode: existing.mode,
              strategyType: existing.strategyType,
              cwd: existing.cwd,
              providerRef: existing.providerRef,
              projectId: existing.projectId,
              projectWorkspaceId: existing.projectWorkspaceId,
              repoUrl: existing.repoUrl,
              baseRef: existing.baseRef,
              branchName: existing.branchName,
              config: {
                ...existing.config,
                provisionCommand:
                  existing.config?.provisionCommand
                  ?? projectPolicy?.workspaceStrategy?.provisionCommand
                  ?? null,
              },
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            agent: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            recorder,
          });

        if (action === "run") {
          if (!workspaceCommand || workspaceCommand.kind !== "job") {
            throw new Error("Workspace job selection is required");
          }
          const availableWorkspace = await ensureWorkspaceAvailable();
          if (!availableWorkspace) {
            throw new Error("Execution workspace needs a local path before Paperclip can run workspace commands");
          }
          return await runWorkspaceJobForControl({
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            workspace: availableWorkspace,
            command: workspaceCommand.rawConfig,
            adapterEnv: {},
            recorder,
            metadata: {
              action,
              executionWorkspaceId: existing.id,
              workspaceCommandId: workspaceCommand.id,
            },
          }).then((nestedOperation) => ({
            status: "succeeded" as const,
            exitCode: 0,
            metadata: {
              nestedOperationId: nestedOperation?.id ?? null,
              runtimeServiceCount,
            },
          }));
        }

        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout.push(chunk);
          else stderr.push(chunk);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForExecutionWorkspace({
            db,
            executionWorkspaceId: existing.id,
            workspaceCwd,
            runtimeServiceId: selectedRuntimeServiceId,
          });
        }

        if (action === "start" || action === "restart") {
          const availableWorkspace = await ensureWorkspaceAvailable();
          if (!availableWorkspace) {
            throw new Error("Execution workspace needs a local path before Paperclip can manage local runtime services");
          }
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            workspace: availableWorkspace,
            executionWorkspaceId: existing.id,
            config: { workspaceRuntime: effectiveRuntimeConfig },
            adapterEnv: {},
            onLog,
            serviceIndex: selectedServiceIndex,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (existing.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: "running" | "stopped" =
          existing.config?.desiredState
          ?? ((existing.runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running")
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: "running" | "stopped";
          serviceStates: Record<string, "running" | "stopped"> | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: existing.config?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: effectiveRuntimeConfig },
              currentDesiredState,
              currentServiceStates: existing.config?.serviceStates ?? null,
              action,
              serviceIndex: selectedServiceIndex,
            });
        const metadata = mergeExecutionWorkspaceConfig(existing.metadata as Record<string, unknown> | null, {
          desiredState: nextRuntimeState.desiredState,
          serviceStates: nextRuntimeState.serviceStates,
        });
        await svc.update(existing.id, { metadata });

        return {
          status: "succeeded",
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          system:
            action === "stop"
              ? "Stopped execution workspace runtime services.\n"
              : action === "restart"
                ? "Restarted execution workspace runtime services.\n"
                : "Started execution workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
          },
        };
      },
    });

    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `execution_workspace.runtime_${action}`,
      entityType: "execution_workspace",
      entityId: existing.id,
      details: {
        runtimeServiceCount,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
    });

    res.json({
      workspace,
      operation,
    });
  }

  router.post("/execution-workspaces/:id/runtime-services/:action", validate(workspaceRuntimeControlTargetSchema), handleExecutionWorkspaceRuntimeCommand);
  router.post("/execution-workspaces/:id/runtime-commands/:action", validate(workspaceRuntimeControlTargetSchema), handleExecutionWorkspaceRuntimeCommand);

  async function loadEffectivePullRequestPolicy(workspace: ExecutionWorkspace): Promise<PullRequestPolicy | null> {
    if (!workspace.projectId) return null;
    const projectPolicy = await db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
      .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy));
    return projectPolicy?.pullRequestPolicy ?? null;
  }

  async function persistPullRequestRecord(
    workspace: ExecutionWorkspace,
    record: ExecutionWorkspacePullRequestRecord | null,
    extraPatch: Record<string, unknown> = {},
  ) {
    const mergedMetadata = mergePullRequestRecordIntoMetadata(workspace.metadata, record);
    const updated = await svc.update(workspace.id, {
      ...extraPatch,
      metadata: mergedMetadata,
    });
    return updated ?? workspace;
  }

  async function emitPullRequestEvent(
    req: Request,
    workspace: ExecutionWorkspace,
    action:
      | "pull_request_requested"
      | "pull_request_resolved"
      | "pull_request_timed_out",
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: workspace.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `execution_workspace.${action}`,
      entityType: "execution_workspace",
      entityId: workspace.id,
      details,
    });
  }

  router.post("/execution-workspaces/:id/pull-request/request", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) throw notFound("Execution workspace not found");
    assertCompanyAccess(req, workspace.companyId);

    const existingRecord = readPullRequestRecord(workspace.metadata);
    if (existingRecord) {
      const response = pullRequestRequestResponse(workspace, existingRecord);
      res.status(200).json({ workspace, pullRequest: existingRecord, request: response });
      return;
    }

    const policy = await loadEffectivePullRequestPolicy(workspace);
    if (!policy || !pullRequestPolicyRequestsAutoOpen(policy)) {
      throw conflict(
        "Project pullRequestPolicy must enable autoOpen or requireResultBeforeArchive before a PR can be requested",
      );
    }
    if (!workspace.branchName) throw conflict("Execution workspace has no branchName to push");
    if (!workspace.baseRef) throw conflict("Execution workspace has no baseRef to target");
    if (workspace.status === "archived" && !existingRecord) {
      throw unprocessable(
        "Cannot replay a pull-request request for a workspace that archived before the feature was enabled",
      );
    }

    const built = buildPullRequestRequestRecord(policy, null);
    const statusPatch = built.mode === "blocking" && workspace.status !== "archived"
      ? { status: "in_review" as const }
      : {};
    const nextWorkspace = await persistPullRequestRecord(workspace, built.record, statusPatch);
    const response = pullRequestRequestResponse(nextWorkspace, built.record);
    onPullRequestRequested({
      db,
      companyId: nextWorkspace.companyId,
      workspaceId: nextWorkspace.id,
      record: built.record,
    });
    await emitPullRequestEvent(req, nextWorkspace, "pull_request_requested", {
      workspaceId: nextWorkspace.id,
      projectId: nextWorkspace.projectId,
      mode: built.mode,
      requestedAt: built.requestedAt,
      sourceIssueId: nextWorkspace.sourceIssueId,
      branchName: nextWorkspace.branchName,
      baseRef: nextWorkspace.baseRef,
      repoUrl: nextWorkspace.repoUrl,
      providerRef: nextWorkspace.providerRef,
      policy,
      record: built.record,
    });
    res.status(200).json({ workspace: nextWorkspace, pullRequest: built.record, request: response });
  });

  router.post(
    "/execution-workspaces/:id/pull-request/result",
    validate(pullRequestResultRequestSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const initial = await svc.getById(id);
      if (!initial) throw notFound("Execution workspace not found");
      assertCompanyAccess(req, initial.companyId);

      // Acquire the workspace row lock before reading the record so a
      // concurrent archive-timeout finalization does not clobber us
      // (or vice versa). On a late result after the timeout fired, the
      // locked re-read will surface the resolved terminal record and
      // this route returns 409 instead of a 200 that would silently
      // overwrite a server-driven close.
      type Outcome =
        | { kind: "missing" }
        | { kind: "no_record" }
        | { kind: "conflict"; record: ExecutionWorkspacePullRequestRecord }
        | {
            kind: "ok";
            record: ExecutionWorkspacePullRequestRecord;
            workspaceStatus: ExecutionWorkspaceStatus;
            previousStatus: PullRequestRecordStatus;
          };
      const locked = await svc.updateWithRowLock<Outcome>(
        initial.id,
        initial.companyId,
        async (current) => {
          const existingRecord = readPullRequestRecord(current.metadata);
          if (!existingRecord) {
            return { patch: null, result: { kind: "no_record" } };
          }
          if (
            existingRecord.status === "merged" ||
            existingRecord.status === "failed" ||
            existingRecord.status === "skipped"
          ) {
            return { patch: null, result: { kind: "conflict", record: existingRecord } };
          }
          const transitioned = applyPullRequestResult(existingRecord, current.status, req.body);
          const nextMetadata = mergePullRequestRecordIntoMetadata(current.metadata, transitioned.record);
          const now = new Date();
          const patch: Partial<typeof executionWorkspaces.$inferInsert> = {
            metadata: nextMetadata as Record<string, unknown> | null,
          };
          if (transitioned.workspaceStatus !== current.status) {
            patch.status = transitioned.workspaceStatus;
            if (transitioned.workspaceStatus === "archived") {
              patch.closedAt = now;
              patch.cleanupReason = null;
            }
          }
          return {
            patch,
            result: {
              kind: "ok" as const,
              record: transitioned.record,
              workspaceStatus: transitioned.workspaceStatus,
              previousStatus: transitioned.previousStatus,
            },
          };
        },
      );

      if (!locked.workspace) {
        throw notFound("Execution workspace not found");
      }
      const outcome = locked.result;
      if (!outcome || outcome.kind === "missing") {
        throw notFound("Execution workspace not found");
      }
      if (outcome.kind === "no_record") {
        throw conflict("No pending pull-request record on this execution workspace");
      }
      if (outcome.kind === "conflict") {
        // Terminal: the scheduler or another caller already resolved
        // this record. Return 409 with the current record so the
        // consumer can log the outcome without overwriting it.
        res.status(409).json({
          error: `Pull-request record is already ${outcome.record.status}`,
          pullRequest: outcome.record,
        });
        return;
      }

      // The transition committed. Cancel any scheduled archive timeout
      // — if the consumer's result landed first, the scheduler should
      // not fire later and emit a contradictory timed_out event.
      cancelArchiveTimeout(initial.id);

      const transitionedWorkspace = locked.workspace;
      await emitPullRequestEvent(req, transitionedWorkspace, "pull_request_resolved", {
        workspaceId: transitionedWorkspace.id,
        projectId: transitionedWorkspace.projectId,
        mode: outcome.record.mode,
        source: "consumer_result",
        previousStatus: outcome.previousStatus,
        nextStatus: outcome.record.status,
        workspaceStatus: outcome.workspaceStatus,
        record: outcome.record,
        resolvedAt: outcome.record.resolvedAt,
      });

      // Blocking mode terminal-to-archived transition: run the same
      // cleanup side effects that PATCH archive would have run if the
      // workspace had closed synchronously in fire-and-forget mode.
      let finalWorkspace = transitionedWorkspace;
      if (outcome.workspaceStatus === "archived" && initial.status !== "archived") {
        const sideEffects = await runArchiveSideEffects({
          db,
          workspace: transitionedWorkspace,
        });
        if (sideEffects.status !== "archived" || sideEffects.cleanupReason !== null) {
          finalWorkspace =
            (await svc.update(initial.id, {
              status: sideEffects.status,
              closedAt: sideEffects.closedAt,
              cleanupReason: sideEffects.cleanupReason,
            })) ?? finalWorkspace;
        }
      }

      res.status(200).json({
        workspaceId: finalWorkspace.id,
        pullRequest: outcome.record,
        workspaceStatus: finalWorkspace.status,
      });
    },
  );

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectExecutionWorkspaceCommandPaths({
        config: req.body.config,
        metadata: req.body.metadata,
      }),
    );
    const patch: Record<string, unknown> = {
      ...(req.body.name === undefined ? {} : { name: req.body.name }),
      ...(req.body.cwd === undefined ? {} : { cwd: req.body.cwd }),
      ...(req.body.repoUrl === undefined ? {} : { repoUrl: req.body.repoUrl }),
      ...(req.body.baseRef === undefined ? {} : { baseRef: req.body.baseRef }),
      ...(req.body.branchName === undefined ? {} : { branchName: req.body.branchName }),
      ...(req.body.providerRef === undefined ? {} : { providerRef: req.body.providerRef }),
      ...(req.body.status === undefined ? {} : { status: req.body.status }),
      ...(req.body.cleanupReason === undefined ? {} : { cleanupReason: req.body.cleanupReason }),
      ...(req.body.cleanupEligibleAt !== undefined
        ? { cleanupEligibleAt: req.body.cleanupEligibleAt ? new Date(req.body.cleanupEligibleAt) : null }
        : {}),
    };
    if (req.body.metadata !== undefined || req.body.config !== undefined) {
      const requestedMetadata = req.body.metadata === undefined
        ? (existing.metadata as Record<string, unknown> | null)
        : (req.body.metadata as Record<string, unknown> | null);
      patch.metadata = req.body.config === undefined
        ? requestedMetadata
        : mergeExecutionWorkspaceConfig(requestedMetadata, req.body.config ?? null);
    }
    let workspace = existing;
    let cleanupWarnings: string[] = [];
    const configForCleanup = readExecutionWorkspaceConfig(
      ((patch.metadata as Record<string, unknown> | null | undefined) ?? (existing.metadata as Record<string, unknown> | null)) ?? null,
    );

    if (req.body.status === "archived" && existing.status !== "archived") {
      const readiness = await svc.getCloseReadiness(existing.id);
      if (!readiness) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }

      if (readiness.state === "blocked") {
        res.status(409).json({
          error: readiness.blockingReasons[0] ?? "Execution workspace cannot be closed right now",
          closeReadiness: readiness,
        });
        return;
      }

      const existingPullRequestRecord = readPullRequestRecord(
        ((patch.metadata as Record<string, unknown> | null | undefined) ?? (existing.metadata as Record<string, unknown> | null)) ?? null,
      );

      // Blocking mode with an in-flight non-terminal record: archive is deferred.
      // Short-circuit before loading the policy: we already know the record
      // was stamped with the policy at request time, and the 409 response
      // carries enough information for the caller to proceed.
      if (existingPullRequestRecord?.mode === "blocking" &&
          (existingPullRequestRecord.status === "requested" ||
           existingPullRequestRecord.status === "opened")) {
        res.status(409).json({
          error:
            `Pull-request record is still ${existingPullRequestRecord.status}. ` +
            "POST /execution-workspaces/:id/pull-request/result to resolve it before archiving.",
          pullRequest: existingPullRequestRecord,
        });
        return;
      }

      const pullRequestPolicy = existingPullRequestRecord
        ? null
        : await loadEffectivePullRequestPolicy(existing);
      const wantsAutoInvoke =
        pullRequestPolicy !== null &&
        pullRequestPolicyRequestsAutoOpen(pullRequestPolicy) &&
        Boolean(existing.branchName) &&
        Boolean(existing.baseRef);

      // Auto-invoke path: policy wants a request and no record exists yet.
      if (wantsAutoInvoke && pullRequestPolicy) {
        const built = buildPullRequestRequestRecord(pullRequestPolicy, null);
        const blocking = pullRequestPolicyBlocksArchive(pullRequestPolicy);
        const nextMetadata = mergePullRequestRecordIntoMetadata(
          (patch.metadata as Record<string, unknown> | null | undefined) ?? existing.metadata ?? null,
          built.record,
        );
        if (blocking) {
          const parked = await svc.update(id, { ...patch, metadata: nextMetadata, status: "in_review" });
          if (!parked) {
            res.status(404).json({ error: "Execution workspace not found" });
            return;
          }
          onPullRequestRequested({
            db,
            companyId: parked.companyId,
            workspaceId: parked.id,
            record: built.record,
          });
          await emitPullRequestEvent(req, parked, "pull_request_requested", {
            workspaceId: parked.id,
            projectId: parked.projectId,
            mode: "blocking",
            requestedAt: built.requestedAt,
            sourceIssueId: parked.sourceIssueId,
            branchName: parked.branchName,
            baseRef: parked.baseRef,
            repoUrl: parked.repoUrl,
            providerRef: parked.providerRef,
            policy: pullRequestPolicy,
            record: built.record,
          });
          res.status(202).json({
            workspace: parked,
            pullRequest: built.record,
            message:
              "Workspace parked in in_review pending pull-request result. POST /pull-request/result to proceed.",
          });
          return;
        }
        // fire-and-forget: stamp the record on the patch metadata, then let
        // the normal archive flow proceed below.
        patch.metadata = nextMetadata;
        // Deferred emission: we still need to log the request before moving on.
        const parkedForEvent = { ...existing, metadata: nextMetadata } as ExecutionWorkspace;
        onPullRequestRequested({
          db,
          companyId: parkedForEvent.companyId,
          workspaceId: parkedForEvent.id,
          record: built.record,
        });
        await emitPullRequestEvent(req, parkedForEvent, "pull_request_requested", {
          workspaceId: parkedForEvent.id,
          projectId: parkedForEvent.projectId,
          mode: "fire_and_forget",
          requestedAt: built.requestedAt,
          sourceIssueId: parkedForEvent.sourceIssueId,
          branchName: parkedForEvent.branchName,
          baseRef: parkedForEvent.baseRef,
          repoUrl: parkedForEvent.repoUrl,
          providerRef: parkedForEvent.providerRef,
          policy: pullRequestPolicy,
          record: built.record,
        });
      }

      const closedAt = new Date();
      const archivedWorkspace = await svc.update(id, {
        ...patch,
        status: "archived",
        closedAt,
        cleanupReason: null,
      });
      if (!archivedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = archivedWorkspace;

      const sideEffects = await runArchiveSideEffects({
        db,
        workspace: existing,
        closedAt,
      });
      cleanupWarnings = sideEffects.cleanupWarnings;
      if (sideEffects.status !== "archived" || sideEffects.cleanupReason !== null) {
        workspace = (await svc.update(id, {
          status: sideEffects.status,
          closedAt: sideEffects.closedAt,
          cleanupReason: sideEffects.cleanupReason,
        })) ?? workspace;
      }
      if (sideEffects.error) {
        res.status(500).json({
          error: `Failed to archive execution workspace: ${sideEffects.error}`,
        });
        return;
      }
    } else {
      const updatedWorkspace = await svc.update(id, patch);
      if (!updatedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = updatedWorkspace;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.updated",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      },
    });
    res.json(workspace);
  });

  return router;
}
