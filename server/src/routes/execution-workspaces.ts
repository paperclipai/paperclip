import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { issues, projects, projectWorkspaces } from "@paperclipai/db";
import {
  findWorkspaceCommandDefinition,
  matchWorkspaceRuntimeServiceToCommand,
  reconcileExecutionWorkspaceBranchSchema,
  updateExecutionWorkspaceSchema,
  workspaceOverviewQuerySchema,
  workspaceRuntimeControlTargetSchema,
} from "@paperclipai/shared";
import type { WorkspaceRuntimeDesiredState, WorkspaceRuntimeServiceStateMap } from "@paperclipai/shared";
import {
  baseWorkspaceDeclaresInstanceConfig,
  resolveCanonicalWorktreeSeedSource,
  type CanonicalWorktreeSeedSource,
} from "@paperclipai/shared/worktree-seed-source";
import { resolvePaperclipConfigPath } from "../paths.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  executionWorkspaceService,
  heartbeatService,
  logActivity,
  workspaceOperationService,
  workspaceRuntimeLeaseService,
  LEASED_WORKSPACE_RUNTIME_ACTIONS,
  type WorkspaceRuntimeLeaseClaim,
} from "../services/index.js";
import { mergeExecutionWorkspaceConfig, readExecutionWorkspaceConfig } from "../services/execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { readProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectExecutionWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageExecutionWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { appendWithCap } from "../adapters/utils.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { runExclusiveWorkspaceRuntimeControl } from "../services/workspace-operations.js";
import { resolveManagedWorkspaceInstanceId } from "../services/managed-workspace-identity.js";
import { isVerifiedWorktreeSeedManifest } from "../worktree-seed-manifest.js";
import {
  issueWorkspaceLoginHandoff,
  workspaceLoginHandoffFailureStatus,
} from "../services/workspace-login-handoff-issuer.js";
import { conflict, unprocessable } from "../errors.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;

function isReadableFile(filePath: string) {
  try {
    accessSync(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The control plane's own instance config, named as the seed source only when the base
 * project workspace is a plain checkout carrying no instance config of its own. A base
 * workspace that has one stays authoritative, so an operator's mismatched source is
 * still rejected.
 */
function resolveFallbackSeedSourceConfigPath(baseWorkspaceCwd: string): string | null {
  return baseWorkspaceDeclaresInstanceConfig(baseWorkspaceCwd) ? null : resolvePaperclipConfigPath();
}

export function executionWorkspaceRoutes(db: Db, opts: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const access = accessService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const runtimeLeases = workspaceRuntimeLeaseService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const environmentRuntime = environmentRuntimeService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });

  async function assertExecutionWorkspaceReadAllowed(req: Request, res: Response, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Execution workspaces are outside this actor's authorization boundary" });
    return false;
  }

  async function assertRuntimeManageAllowed(req: Request, res: Response, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "runtime:manage",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Runtime service control is outside this actor's authorization boundary" });
    return false;
  }

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertExecutionWorkspaceReadAllowed(req, res, companyId))) return;
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

  router.get("/companies/:companyId/workspace-overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertExecutionWorkspaceReadAllowed(req, res, companyId))) return;

    const parsed = workspaceOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        error: "Invalid workspace overview query",
        details: parsed.error.flatten(),
      });
      return;
    }

    const overview = await svc.listOverview(companyId, parsed.data);
    res.json(overview);
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!workspace) return;
    if (!(await assertExecutionWorkspaceReadAllowed(req, res, workspace.companyId))) return;
    res.json(workspace);
  });

  router.get("/execution-workspaces/:id/close-readiness", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!workspace) return;
    if (!(await assertExecutionWorkspaceReadAllowed(req, res, workspace.companyId))) return;
    const readiness = await svc.getCloseReadiness(id);
    if (!readiness) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    res.json(readiness);
  });

  /**
   * Mint a single-use workspace login handoff for the calling board user.
   *
   * Board-only: the ticket carries a user identity, so an agent key — which has
   * no user to sign in — must never be able to mint one. Nothing in the request
   * body influences what the ticket is bound to; only the landing path is taken
   * from the caller, and it is reduced to a same-origin path before signing.
   */
  router.post("/execution-workspaces/:id/login-handoff", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const workspace = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!workspace) return;
    // Opening a workspace board is a runtime-control-grade action: it hands the
    // caller an authenticated session inside the cloned instance.
    if (!(await assertRuntimeManageAllowed(req, res, workspace.companyId))) return;

    const requestedNext = typeof (req.body as { next?: unknown } | null)?.next === "string"
      ? (req.body as { next: string }).next
      : null;
    const result = await issueWorkspaceLoginHandoff({
      db,
      companyId: workspace.companyId,
      executionWorkspace: { id: workspace.id, cwd: workspace.cwd },
      actor: {
        userId: req.actor.userId ?? null,
        userEmail: req.actor.userEmail ?? null,
        source: req.actor.source ?? null,
      },
      next: requestedNext,
    });

    if (!result.ok) {
      logger.warn(
        {
          executionWorkspaceId: workspace.id,
          reason: result.failure.reason,
          detail: "detail" in result.failure ? result.failure.detail : null,
        },
        "workspace login handoff was not issued",
      );
      res.status(workspaceLoginHandoffFailureStatus(result.failure)).json({
        error: "workspace_login_handoff_unavailable",
        // The UI turns this into the labeled snapshot-local credential fallback
        // or a repair prompt, so the machine reason has to survive the boundary.
        reason: result.failure.reason,
        mode: "credentials",
        ...("detail" in result.failure ? { detail: result.failure.detail } : {}),
        ...("readiness" in result.failure ? { readiness: result.failure.readiness } : {}),
      });
      return;
    }

    await logActivity(db, {
      companyId: workspace.companyId,
      // Auditing issuance is a requirement of the handoff design: the nonce ties
      // this record to the guest's own accept/reject record. The ticket itself is
      // never recorded.
      action: "workspace_login_handoff_issued",
      entityType: "execution_workspace",
      entityId: workspace.id,
      actorType: "user",
      actorId: result.issuance.userId,
      details: {
        nonce: result.issuance.nonce,
        instanceId: result.issuance.instanceId,
        origin: result.issuance.origin,
        expiresAt: result.issuance.expiresAt,
      },
    }).catch((error) => {
      logger.warn({ err: error, executionWorkspaceId: workspace.id }, "failed to audit workspace login handoff");
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      url: result.issuance.url,
      expiresAt: result.issuance.expiresAt,
      mode: "handoff",
    });
  });

  router.get("/execution-workspaces/:id/workspace-operations", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!workspace) return;
    if (!(await assertExecutionWorkspaceReadAllowed(req, res, workspace.companyId))) return;
    const operations = await workspaceOperationsSvc.listForExecutionWorkspace(id);
    res.json(operations);
  });

  async function handleExecutionWorkspaceRuntimeCommand(req: Request, res: Response) {
    const id = req.params.id as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "repair" && action !== "run") {
      res.status(404).json({ error: "Workspace command action not found" });
      return;
    }

    const existing = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!existing) return;
    if (!(await assertRuntimeManageAllowed(req, res, existing.companyId))) return;

    const authorization = await assertCanManageExecutionWorkspaceRuntimeServices(db, req, {
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
              eq(projectWorkspaces.projectId, existing.projectId),
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
    const repairRestartsRuntimeServices = action === "repair" && configuredServices.length > 0;
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

    let repairSeedSource: CanonicalWorktreeSeedSource | null = null;
    let repairPreviousAttemptId: string | null = null;
    let repairCliArgs: string[] | null = null;
    if (action === "repair") {
      const manifestPath = path.join(workspaceCwd, ".paperclip", "seed-manifest.json");
      let manifest: {
        attemptId?: unknown;
        source?: { configPath?: unknown; instanceId?: unknown };
        targetInstanceId?: unknown;
      };
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        throw unprocessable("Workspace seed manifest is malformed; repair source identity cannot be trusted.", {
          code: "workspace_repair_precondition_failed",
          reason: "seed_manifest_malformed",
          repairPhase: "precondition_validation",
        });
      }

      try {
        if (!projectWorkspace?.cwd) {
          throw new Error("Workspace repair requires a registered base project workspace.");
        }
        const expectedTargetInstanceId = resolveManagedWorkspaceInstanceId(workspaceCwd);
        if (!expectedTargetInstanceId) {
          throw new Error("Workspace repair cannot resolve the registered target instance.");
        }
        repairSeedSource = resolveCanonicalWorktreeSeedSource({
          registeredBaseWorkspaceCwd: projectWorkspace.cwd,
          explicitSourceConfigPath: resolveFallbackSeedSourceConfigPath(projectWorkspace.cwd),
          targetConfigPath: path.join(workspaceCwd, ".paperclip", "config.json"),
          expectedTargetInstanceId,
          manifestSource: manifest.source,
          manifestTargetInstanceId: manifest.targetInstanceId,
        });
        repairPreviousAttemptId = typeof manifest.attemptId === "string" ? manifest.attemptId : null;

        const baseWorkspaceCwd = repairSeedSource.baseWorkspaceCwd;
        if (!baseWorkspaceCwd) {
          throw new Error("Workspace repair source is not bound to a registered base project workspace.");
        }
        const cliRunner = path.join(baseWorkspaceCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
        const cliEntry = path.join(baseWorkspaceCwd, "cli", "src", "index.ts");
        const cliDist = path.join(baseWorkspaceCwd, "cli", "dist", "index.js");
        repairCliArgs = isReadableFile(cliRunner) && isReadableFile(cliEntry)
          ? [cliRunner, cliEntry]
          : isReadableFile(cliDist)
            ? [cliDist]
            : null;
        if (!repairCliArgs) {
          throw new Error("Workspace repair cannot find a runnable Paperclip CLI in the base workspace.");
        }
      } catch (error) {
        throw unprocessable(
          error instanceof Error ? error.message : "Workspace repair source validation failed.",
          {
            code: "workspace_repair_precondition_failed",
            reason: "source_registration_invalid",
            repairPhase: "precondition_validation",
          },
        );
      }
    }

    // This check can reconcile a stale operation row, so repair source validation must
    // precede it. Invalid manifest diagnostics must fail before any operation or service
    // mutation, not merely before the reseed child process is spawned.
    await workspaceOperationsSvc.assertRuntimeControlAvailable({
      executionWorkspaceId: existing.id,
      action,
    });

    const actor = getActorInfo(req);
    const recorder = workspaceOperationsSvc.createRecorder({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
    });
    let runtimeServiceCount = existing.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    /**
     * Bring runtime rows, local listeners and the recorded desired state back to a consistent
     * stopped shape after a start failed part-way. Best-effort by design: the operation is
     * still failed (terminal) even if teardown itself cannot complete, and every step is
     * something a normal managed `stop` would do, so authorization is unchanged.
     */
    let failedStartReconciled = false;
    async function reconcileFailedRuntimeStart(cause: unknown) {
      if (failedStartReconciled) return;
      failedStartReconciled = true;
      try {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId: existing!.id,
          workspaceCwd: workspaceCwd!,
          runtimeServiceId: selectedRuntimeServiceId,
        });
      } catch (teardownError) {
        logger.warn(
          {
            executionWorkspaceId: existing!.id,
            err: teardownError,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
          "failed to tear down runtime services after a failed managed start",
        );
      }

      try {
        const failedDesiredState = buildWorkspaceRuntimeDesiredStatePatch({
          config: { workspaceRuntime: effectiveRuntimeConfig },
          currentDesiredState: existing!.config?.desiredState ?? null,
          currentServiceStates: existing!.config?.serviceStates ?? null,
          action: "stop",
          serviceIndex: selectedServiceIndex,
        });
        await svc.update(existing!.id, {
          metadata: mergeExecutionWorkspaceConfig(existing!.metadata as Record<string, unknown> | null, {
            desiredState: failedDesiredState.desiredState,
            serviceStates: failedDesiredState.serviceStates,
          }),
        });
      } catch (patchError) {
        logger.warn(
          { executionWorkspaceId: existing!.id, err: patchError },
          "failed to record the stopped desired state after a failed managed start",
        );
      }
    }

    const recordRuntimeControlOperation = () => recorder.recordOperation({
      phase: action === "stop"
        ? "workspace_teardown"
        : action === "repair"
          ? "workspace_repair"
          : "workspace_provision",
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
      run: async (reportProgress) => {
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
              metadata: existing.metadata as Record<string, unknown> | null,
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
          if (stream === "stdout") stdout = appendWithCap(stdout, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
          else stderr = appendWithCap(stderr, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
        };

        if (action === "repair") {
          type RepairPhase =
            | "managed_stop"
            | "precondition_validation"
            | "target_backup"
            | "full_reseed"
            | "managed_restart"
            | "readiness_validation";
          const repairDiagnostics: Array<{
            phase: RepairPhase;
            status: "started" | "succeeded" | "failed";
            at: string;
          }> = [];
          let repairPhase: RepairPhase = "managed_stop";
          const repairPreconditionError = (
            status: 409 | 422,
            reason:
              | "seed_manifest_malformed"
              | "seed_manifest_instance_mismatch"
              | "source_instance_unavailable"
              | "paperclip_cli_unavailable",
            message: string,
          ) => {
            const details = {
              code: "workspace_repair_precondition_failed",
              reason,
              repairPhase,
            };
            return status === 409
              ? conflict(message, details)
              : unprocessable(message, details);
          };
          const reportRepairPhase = async (
            phase: RepairPhase,
            status: "started" | "succeeded" | "failed",
          ) => {
            repairPhase = phase;
            repairDiagnostics.push({ phase, status, at: new Date().toISOString() });
            if (repairDiagnostics.length > 32) repairDiagnostics.splice(0, repairDiagnostics.length - 32);
            await reportProgress({
              metadata: {
                repairPhase,
                repairDiagnostics: [...repairDiagnostics],
                databaseOnly: true,
                worktreePreserved: true,
              },
              system: `Workspace repair ${phase}: ${status}.\n`,
            });
          };

          try {
            await reportRepairPhase("managed_stop", "started");
            await stopRuntimeServicesForExecutionWorkspace({
              db,
              executionWorkspaceId: existing.id,
              workspaceCwd,
            });
            await reportRepairPhase("managed_stop", "succeeded");
            if (!repairSeedSource?.baseWorkspaceCwd || !repairCliArgs) {
              throw new Error("Workspace repair source preflight did not complete.");
            }
            const manifestPath = path.join(workspaceCwd, ".paperclip", "seed-manifest.json");
            const sourceConfigPath = repairSeedSource.configPath;
            const baseWorkspaceCwd = repairSeedSource.baseWorkspaceCwd;

            await reportRepairPhase("target_backup", "started");
            const child = spawn(process.execPath, [
              ...repairCliArgs,
              "worktree",
              "reseed",
              "--from-config",
              sourceConfigPath,
              "--to",
              workspaceCwd,
              "--seed-mode",
              "full",
              "--yes",
              "--backup-target",
            ], {
              cwd: baseWorkspaceCwd,
              env: {
                ...process.env,
                PAPERCLIP_SEED_EXPECTED_COMPANY_ID: existing.companyId,
                PAPERCLIP_WORKSPACE_BASE_CWD: baseWorkspaceCwd,
                PAPERCLIP_PROJECT_WORKSPACE_ID: existing.projectWorkspaceId ?? "",
              },
              stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout?.on("data", (chunk: Buffer) => {
              void onLog("stdout", chunk.toString("utf8"));
            });
            child.stderr?.on("data", (chunk: Buffer) => {
              void onLog("stderr", chunk.toString("utf8"));
            });
            let repairCommandTimedOut = false;
            let repairCommandForceTimeout: NodeJS.Timeout | null = null;
            const repairCommandTimeout = setTimeout(() => {
              repairCommandTimedOut = true;
              child.kill("SIGTERM");
              repairCommandForceTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
              repairCommandForceTimeout.unref?.();
            }, 20 * 60_000);
            repairCommandTimeout.unref?.();

            let reseedObserved = false;
            const manifestPoll = setInterval(() => {
              if (reseedObserved || !existsSync(manifestPath)) return;
              try {
                const current = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                  attemptId?: unknown;
                  state?: unknown;
                };
                if (
                  typeof current.attemptId === "string"
                  && current.attemptId !== repairPreviousAttemptId
                  && (current.state === "pending" || current.state === "running" || current.state === "failed")
                ) {
                  reseedObserved = true;
                }
              } catch {
                // The atomic manifest writer makes this unlikely; the terminal
                // read below remains authoritative.
              }
            }, 100);
            manifestPoll.unref?.();
            const exitCode = await new Promise<number>((resolve, reject) => {
              child.once("error", reject);
              child.once("exit", (code) => resolve(code ?? 1));
            }).finally(() => {
              clearInterval(manifestPoll);
              clearTimeout(repairCommandTimeout);
              if (repairCommandForceTimeout) clearTimeout(repairCommandForceTimeout);
            });
            if (reseedObserved) {
              await reportRepairPhase("target_backup", "succeeded");
              await reportRepairPhase("full_reseed", "started");
            }
            if (exitCode !== 0) {
              let seedFailurePhase: string | null = null;
              try {
                const failedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                  phase?: unknown;
                  state?: unknown;
                };
                seedFailurePhase = failedManifest.state === "failed" && typeof failedManifest.phase === "string"
                  ? failedManifest.phase
                  : null;
              } catch {
                // The outer repair phase remains exact when no seed phase was persisted.
              }
              await reportProgress({
                metadata: { seedFailurePhase },
                system: seedFailurePhase ? `Workspace seed failed during ${seedFailurePhase}.\n` : null,
              });
              throw new Error(
                repairCommandTimedOut
                  ? `Workspace database repair command timed out during ${repairPhase}.`
                  : `Workspace database repair command failed during ${repairPhase}.`,
              );
            }
            if (!reseedObserved) {
              await reportRepairPhase("target_backup", "succeeded");
              await reportRepairPhase("full_reseed", "started");
            }

            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
            if (!isVerifiedWorktreeSeedManifest(manifest)) {
              throw new Error("Workspace reseed returned without a verified terminal manifest.");
            }
            const expectedInstanceId = resolveManagedWorkspaceInstanceId(workspaceCwd);
            if (manifest.targetInstanceId !== expectedInstanceId) {
              throw repairPreconditionError(
                422,
                "seed_manifest_instance_mismatch",
                "Verified seed manifest belongs to a different workspace instance.",
              );
            }
            resolveCanonicalWorktreeSeedSource({
              registeredBaseWorkspaceCwd: baseWorkspaceCwd,
              explicitSourceConfigPath: resolveFallbackSeedSourceConfigPath(baseWorkspaceCwd),
              targetConfigPath: path.join(workspaceCwd, ".paperclip", "config.json"),
              expectedTargetInstanceId: repairSeedSource.targetInstanceId,
              manifestSource: manifest.source as { configPath?: unknown; instanceId?: unknown } | undefined,
              manifestTargetInstanceId: manifest.targetInstanceId,
            });
            await reportRepairPhase("full_reseed", "succeeded");

            await reportRepairPhase("managed_restart", "started");
            let startedServices: Awaited<ReturnType<typeof startRuntimeServicesForWorkspaceControl>> = [];
            if (repairRestartsRuntimeServices) {
              const availableWorkspace = await ensureWorkspaceAvailable();
              if (!availableWorkspace) {
                throw new Error("Execution workspace needs a local path before Paperclip can restart it.");
              }
              startedServices = await startRuntimeServicesForWorkspaceControl({
                db,
                actor: {
                  id: actor.agentId ?? null,
                  name: actor.actorType === "user" ? "Board" : "Agent",
                  companyId: existing.companyId,
                },
                issue: existing.sourceIssueId
                  ? { id: existing.sourceIssueId, identifier: null, title: existing.name }
                  : null,
                workspace: availableWorkspace,
                executionWorkspaceId: existing.id,
                config: {
                  workspaceRuntime: effectiveRuntimeConfig,
                  runtimeProvisionCommand:
                    existing.config?.runtimeProvisionCommand
                    ?? projectPolicy?.workspaceStrategy?.runtimeProvisionCommand
                    ?? null,
                },
                adapterEnv: {},
                onLog,
                recorder,
              });
            }
            runtimeServiceCount = startedServices.length;
            await reportRepairPhase("managed_restart", "succeeded");

            await reportRepairPhase("readiness_validation", "started");
            if (
              repairRestartsRuntimeServices
              && (
                startedServices.length === 0
                || startedServices.some((service) => service.status !== "running" || service.healthStatus !== "healthy")
              )
            ) {
              throw new Error("Managed restart did not produce healthy runtime services.");
            }
            await reportRepairPhase("readiness_validation", "succeeded");
          } catch (error) {
            await reportRepairPhase(repairPhase, "failed");
            throw error;
          }
        } else if (action === "stop" || action === "restart") {
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
          let startedServices;
          try {
            startedServices = await startRuntimeServicesForWorkspaceControl({
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
              config: {
                workspaceRuntime: effectiveRuntimeConfig,
                runtimeProvisionCommand:
                  existing.config?.runtimeProvisionCommand
                  ?? projectPolicy?.workspaceStrategy?.runtimeProvisionCommand
                  ?? null,
              },
              adapterEnv: {},
              onLog,
              recorder,
              serviceIndex: selectedServiceIndex,
              runtimeServiceId: selectedRuntimeServiceId,
            });
          } catch (error) {
            // A failed start must leave the workspace stopped and retryable rather than
            // "desired running" with a half-started listener: tear down residue and record
            // the stopped desired state before the operation is marked failed.
            await reconcileFailedRuntimeStart(error);
            throw error;
          }
          runtimeServiceCount = startedServices.length;
        } else if (action !== "repair") {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (existing.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: WorkspaceRuntimeDesiredState =
          existing.config?.desiredState
          ?? ((existing.runtimeServices ?? []).some((service) =>
            service.status === "provisioning" || service.status === "starting" || service.status === "running"
          )
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: WorkspaceRuntimeDesiredState;
          serviceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: existing.config?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: effectiveRuntimeConfig },
              currentDesiredState,
              currentServiceStates: existing.config?.serviceStates ?? null,
              action: action === "repair"
                ? repairRestartsRuntimeServices ? "start" : "stop"
                : action,
              serviceIndex: selectedServiceIndex,
            });
        const metadata = mergeExecutionWorkspaceConfig(existing.metadata as Record<string, unknown> | null, {
          desiredState: nextRuntimeState.desiredState,
          serviceStates: nextRuntimeState.serviceStates,
        });
        await svc.update(existing.id, { metadata });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped execution workspace runtime services.\n"
              : action === "restart"
                ? "Restarted execution workspace runtime services.\n"
                : action === "repair"
                  ? repairRestartsRuntimeServices
                    ? "Repaired the isolated workspace database and restarted healthy runtime services.\n"
                    : "Repaired the isolated workspace database; no managed runtime services were configured to restart.\n"
                  : "Started execution workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
            runtimeRestarted: action === "repair" ? repairRestartsRuntimeServices : undefined,
          },
        };
      },
    });

    const { operation, leaseClaim } = await runExclusiveWorkspaceRuntimeControl({
      executionWorkspaceId: existing.id,
      action,
      run: async () => {
        // Claim the durable exclusivity lease before anything mutates the workspace or
        // its runtime services. A competing issue/run throws 409 here, leaving no
        // workspace operation row and no runtime-service change behind.
        let leaseClaimResult: WorkspaceRuntimeLeaseClaim | null = null;
        if (LEASED_WORKSPACE_RUNTIME_ACTIONS.includes(action)) {
          leaseClaimResult = await runtimeLeases.claim({
            companyId: existing.companyId,
            executionWorkspaceId: existing.id,
            action,
            owner: authorization,
          });
        }
        // Re-check inside the claim: recovery of stranded operations plus a refusal if one
        // is genuinely still live. The same assertion ran before the lease was taken, but a
        // row can be stranded in that window, and only the recovering path may proceed.
        await workspaceOperationsSvc.assertRuntimeControlAvailable({
          executionWorkspaceId: existing.id,
          action,
        });
        try {
          return {
            operation: await recordRuntimeControlOperation(),
            leaseClaim: leaseClaimResult,
          };
        } catch (error) {
          // The operation is already terminal here. This also catches the recorder's own time
          // budget expiring on a start that never settles, which is the one failure the inner
          // handler cannot see — reconcile there too so no listener or desired state is left over.
          if (action === "start" || action === "restart" || action === "repair") {
            await reconcileFailedRuntimeStart(error);
          }
          throw error;
        }
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
      agentApiKeyId: actor.agentApiKeyId,
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
        runtimeLease: leaseClaim
          ? {
              outcome: leaseClaim.outcome,
              ownerKey: leaseClaim.ownerKey,
              reclaimedFrom: leaseClaim.reclaimedFrom,
            }
          : null,
      },
    });

    res.json({
      workspace,
      operation,
    });
  }

  router.post("/execution-workspaces/:id/runtime-services/:action", validate(workspaceRuntimeControlTargetSchema), handleExecutionWorkspaceRuntimeCommand);
  router.post("/execution-workspaces/:id/runtime-commands/:action", validate(workspaceRuntimeControlTargetSchema), handleExecutionWorkspaceRuntimeCommand);

  router.post("/execution-workspaces/:id/reconcile-branch", validate(reconcileExecutionWorkspaceBranchSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!existing) return;
    assertBoard(req);
    if (!(await assertRuntimeManageAllowed(req, res, existing.companyId))) return;

    const actor = getActorInfo(req);
    const result = await svc.reconcileExecutionWorkspaceBranch(id, {
      mode: req.body.mode,
      reason: req.body.reason ?? null,
      actor: {
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
      },
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: existing.id,
      details: {
        mode: req.body.mode,
        reason: req.body.reason ?? null,
        fromBranch: result.inspection.fromBranch,
        toBranch: result.inspection.toBranch,
        fromSha: result.inspection.fromSha,
        toSha: result.inspection.toSha,
        ancestryVerdict: result.inspection.ancestryVerdict,
        fingerprint: result.inspection.fingerprint,
        sourceIssueId: existing.sourceIssueId,
        auditCommentId: result.auditCommentId,
        recoveryActionId: result.recoveryAction?.id ?? null,
        rescueRef: result.rescueRef,
        sourceIssueStatus: result.restoredSourceIssue?.status ?? null,
        actor: {
          type: actor.actorType,
          id: actor.actorId,
          source: actor.actorSource,
        },
      },
    });

    if (
      result.restoredSourceIssue &&
      (result.restoredSourceIssue.status === "todo" || result.restoredSourceIssue.status === "in_review") &&
      result.sourceIssueStatusChanged &&
      result.restoredSourceIssue.assigneeAgentId
    ) {
      void heartbeat.wakeup(result.restoredSourceIssue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_recovery_action_restored",
        payload: {
          issueId: result.restoredSourceIssue.id,
          recoveryActionId: result.recoveryAction?.id ?? null,
          executionWorkspaceId: existing.id,
          rescueRef: result.rescueRef?.branchName ?? null,
          mutation: "execution_workspace_quarantine_restore",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: result.restoredSourceIssue.id,
          taskId: result.restoredSourceIssue.id,
          wakeReason: "issue_recovery_action_restored",
          source: "execution_workspace.quarantine_restore",
          recoveryActionId: result.recoveryAction?.id ?? null,
          executionWorkspaceId: existing.id,
          rescueRef: result.rescueRef?.branchName ?? null,
        },
      }).catch((err) =>
        logger.warn(
          { err, issueId: result.restoredSourceIssue?.id, agentId: result.restoredSourceIssue?.assigneeAgentId },
          "failed to wake agent after execution workspace quarantine restore",
        ));
    }

    res.json(result);
  });

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Execution workspace not found");
    if (!existing) return;
    if (!(await assertRuntimeManageAllowed(req, res, existing.companyId))) return;
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

      const closedAt = new Date();
      // Archive under the per-workspace lifecycle lock. The service takes the same
      // lock as a reopen, raises the lifecycle generation, and clears the
      // reopen-pending flag. The lock stops a concurrent reopen from publishing an
      // active row between the status re-check and this archive write, so the
      // destruction fence below never deletes a worktree that a reopen rebuilt.
      const archiveResult = await svc.archiveWorkspaceUnderLifecycleLock({
        id,
        patch,
        closedAt,
      });
      if (!archiveResult) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      if (archiveResult.outcome === "reopen_pending") {
        // A reopen published this workspace as active while its source issue is
        // still terminal. A caller will consume the rebuilt worktree. Refuse the
        // archive and return before any lease teardown, runtime-service stop, or
        // artifact cleanup, so the archive control never removes the rebuilt
        // worktree during the reopen consumption window.
        res.status(409).json({
          error: "Execution workspace was reopened and cannot be archived right now",
        });
        return;
      }
      workspace = archiveResult.workspace;
      const capturedGeneration = archiveResult.capturedGeneration;

      // Closing the workspace ends the lane, so the runtime-control lease is released
      // outright rather than waiting for owner-eligibility or TTL recovery.
      await runtimeLeases.release({ executionWorkspaceId: existing.id, force: true });

      if (existing.mode === "shared_workspace") {
        await db
          .update(issues)
          .set({
            executionWorkspaceId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.companyId, existing.companyId),
              eq(issues.executionWorkspaceId, existing.id),
            ),
          );
      }

      try {
        const projectWorkspace = existing.projectWorkspaceId
          ? await db
              .select({
                cwd: projectWorkspaces.cwd,
                cleanupCommand: projectWorkspaces.cleanupCommand,
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
        const projectPolicy = existing.projectId
          ? await db
              .select({
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
          : null;
        // Destroy under the lifecycle lock. If a resume reopened the workspace in
        // the meantime, the fence skips destruction and keeps the reopened row.
        // The reusable sandbox lease teardown runs inside this fence too. A reopen
        // that races the archive rebuilds the worktree and keeps its leases, so
        // the fence must skip both the worktree teardown and the lease teardown at
        // the same generation. If the lease teardown ran before the fence, an
        // overlapping reopen would lose its reusable leases while the fence still
        // preserved its rebuilt worktree.
        const fenced = await svc.fenceClosedWorkspaceDestruction({
          workspaceId: id,
          capturedGeneration,
          destroy: async () => {
            await environmentRuntime.destroyReusableSandboxLeases({
              companyId: existing.companyId,
              executionWorkspaceId: existing.id,
              failureReason: "execution_workspace_closed",
            });
            await stopRuntimeServicesForExecutionWorkspace({
              db,
              executionWorkspaceId: existing.id,
              workspaceCwd: existing.cwd,
            });
            return cleanupExecutionWorkspaceArtifacts({
              workspace: existing,
              projectWorkspace,
              teardownCommand: configForCleanup?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
              cleanupCommand: configForCleanup?.cleanupCommand ?? null,
              recorder: workspaceOperationsSvc.createRecorder({
                companyId: existing.companyId,
                executionWorkspaceId: existing.id,
              }),
            });
          },
        });
        if (fenced.skippedReopened) {
          // A resume reopened the workspace. Return the current (active) row.
          workspace = (await svc.getById(id)) ?? workspace;
        } else {
          const cleanupResult = fenced.result;
          cleanupWarnings = cleanupResult.warnings;
          if (cleanupResult.warnings.length > 0 || !cleanupResult.cleaned) {
            // Record the cleanup outcome under the lifecycle lock at the captured
            // generation. If a resume reopened the workspace after the destruction
            // fence returned, the guarded write skips the row, so a stale patch
            // never overwrites the rebuilt worktree's active state.
            const applied = await svc.applyClosedWorkspaceCleanupOutcome({
              id,
              closedAt,
              capturedGeneration,
              cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
              markCleanupFailed: !cleanupResult.cleaned,
            });
            if (applied) {
              workspace = applied;
            } else {
              // A resume reopened the workspace. Return the current (active) row.
              workspace = (await svc.getById(id)) ?? workspace;
            }
          }
        }
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        // Mark cleanup_failed only while the row is still closed at the captured
        // generation. If a resume reopened the workspace after the cleanup threw,
        // the row is active again and, after a fresh archive, carries a higher
        // generation. The generation-fenced write skips the row in both cases, so
        // a stale cleanup_failed write never overwrites the newer active lifecycle
        // state, and never buries a newer archive under the first archive's
        // failure.
        const marked = await svc.applyClosedWorkspaceCleanupOutcome({
          id,
          closedAt,
          capturedGeneration,
          cleanupReason: failureReason,
          markCleanupFailed: true,
        });
        if (marked) workspace = marked;
        res.status(500).json({
          error: `Failed to archive execution workspace: ${failureReason}`,
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
      agentApiKeyId: actor.agentApiKeyId,
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
