import { createHash } from "node:crypto";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { adapterExecutionTargetEnablesSandboxDuplexBridge } from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { AgentDirectoryReuseInvalidatedError, isAgentDirectoryCopy } from "../agent-directory-working-copies.js";
import { collectStoppedInstructionCopyWithRetries, instructionWorkingCopyGuidance, type agentInstructionWorkingCopyService } from "../agent-instruction-working-copies.js";
import { claimWarmNativeInstructionCopy, nativeSessionWorkspaceScope, reserveWarmNativeInstructionDirectory } from "../native-runtime/index.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import type { HeartbeatRuntimeSelectionInput } from "./runtime-selection.js";
import type { createHeartbeatLifecycle } from "./run-lifecycle.js";
import type { EffectiveRunSessionConfigMetadata } from "./workspaces.js";

type Copies = ReturnType<typeof agentInstructionWorkingCopyService>;
type Selection = HeartbeatRuntimeSelectionInput;
type AppendRunEvent = ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A failed cleanup is deferred once per run; it cannot replace the run result. */
export function createHeartbeatInstructionCopyRelease(
  instructionCleanupRun: Selection["run"],
  instructionCopies: Pick<Copies, "release">,
  appendRunEvent: AppendRunEvent,
) {
  let instructionCleanupDeferred = false;
  const releaseInstructionCopy = async () => {
    // Cleanup is retried from the durable working-copy receipt by the
    // recovery sweep. It must not replace the provider result (or prevent
    // lease release), and a timeout must not be repeated in outer teardown.
    if (instructionCleanupDeferred) return;
    try {
      await instructionCopies.release(instructionCleanupRun.companyId, instructionCleanupRun.id);
    } catch (err) {
      instructionCleanupDeferred = true;
      logger.warn({ err, runId: instructionCleanupRun.id }, "Agent file cleanup deferred; run outcome preserved");
      await appendRunEvent(instructionCleanupRun, {
        eventType: "instruction_cleanup",
        stream: "system",
        level: "warn",
        message: "Agent file cleanup was deferred. The run outcome and file-save receipt are unchanged.",
        payload: { state: "deferred" },
      }).catch((eventError) => {
        logger.warn({ err: eventError, runId: instructionCleanupRun.id }, "Failed to record deferred agent file cleanup");
      });
    }
  };
  return releaseInstructionCopy;
}

interface InstructionWorkingCopyInput {
  observabilityCompatibilityKey?: string;
  db: Db;
  instructionCopies: Copies;
  // The executor replaces its run row before preparation. Callbacks must see it.
  readRun: () => Selection["run"];
  agent: Selection["agent"];
  context: Selection["task"]["context"];
  session: {
    taskSession: { lastRunId: string | null } | null;
    taskSessionForRun: Selection["session"]["taskSessionForRun"];
    sessionConfigMetadata: EffectiveRunSessionConfigMetadata;
  };
  workspace: Pick<Selection["workspace"], "executionTarget" | "executionWorkspace" | "persistedExecutionWorkspace">;
  appendRunEvent: AppendRunEvent;
}

/** Per-run copy, receipt, and warm ownership; the executor orders final releases. */
export function createHeartbeatInstructionWorkingCopy(input: InstructionWorkingCopyInput) {
  const { db, instructionCopies, readRun, agent, context, appendRunEvent } = input;
  const { taskSession, taskSessionForRun, sessionConfigMetadata } = input.session;
  const { executionTarget, executionWorkspace, persistedExecutionWorkspace } = input.workspace;
  let releaseWarmInstructionPreparation: (() => Promise<void>) | null = null;
  let nativeInstructionReservation: Awaited<ReturnType<typeof reserveWarmNativeInstructionDirectory>> = null;
  let instructionCopy: Awaited<ReturnType<typeof instructionCopies.prepare>> = null;
  let instructionSave: Record<string, unknown> | null = null;
  const instructionPreparationKey = createHash("sha256").update(JSON.stringify({
    adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, runtimeConfig: agent.runtimeConfig, sessionConfigMetadata,
    duplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(executionTarget),
    workspace: nativeSessionWorkspaceScope({
      binding: { runId: readRun().id, executionWorkspaceId: persistedExecutionWorkspace?.id ?? readRun().id },
      workspace: executionWorkspace,
    }), cwd: executionWorkspace.cwd,
  })).digest("hex");
  const recordInstructionSave = async (saved: NonNullable<Awaited<ReturnType<typeof instructionCopies.get>>>) => {
    const receipt = parseObject(saved.receipt);
    const storageWarning = readNonEmptyString(receipt.storageWarning);
    const state = saved.errorCode === "AGENT_FILES_CHECKPOINT_UNSTABLE" ? "pending_collection"
      : saved.state === "warm_saved" ? readNonEmptyString(receipt.checkpointState) ?? "saved" : saved.state;
    instructionSave = { state, entryFile: saved.entryFile,
      ...(isAgentDirectoryCopy(saved) ? { contract: "agent_files", appliedCandidateHash: saved.candidateHash, checkpointStats: receipt.checkpointStats }
        : { revisionId: parseObject(receipt.revision).id ?? null }), storageWarning, errorCode: saved.errorCode, errorMessage: saved.errorMessage };
    await appendRunEvent(readRun(), { eventType: "instruction_save", stream: "system",
      level: !saved.errorCode && !storageWarning && ["saved", "unchanged", "resolved"].includes(state) ? "info" : "warn",
      message: storageWarning ?? (state === "saved" ? "Agent files saved."
        : state === "unchanged" ? "Instruction working copy is unchanged."
          : saved.errorMessage ?? "Instruction edits were not saved."), payload: instructionSave });
  };
  const collectStoppedInstructions = async () => {
    if (!instructionCopy) return;
    const saved = await collectStoppedInstructionCopyWithRetries(() => instructionCopies.collectStopped({
      companyId: agent.companyId, runId: readRun().id, target: executionTarget,
    }));
    if (!saved) return;
    if (saved.state !== "superseded") await recordInstructionSave(saved);
  };
  const nativeInstructionWorkingCopy = () => instructionCopy ? {
    ...(isAgentDirectoryCopy(instructionCopy) ? { runId: readRun().id, preparationKey: instructionPreparationKey } : {}),
    root: instructionCopy.executionRoot,
    ...(instructionCopy.receipt?.warm === true ? { checkpointWarm: async () => {
      const saved = await instructionCopies.checkpointWarm({ companyId: agent.companyId, runId: readRun().id, target: executionTarget });
      if (saved) await recordInstructionSave(saved);
      return saved?.state === "warm_saved" && saved.errorCode === null;
    } } : {}),
    hasChanges: () => instructionCopies.hasChanges({ companyId: agent.companyId, runId: readRun().id, target: executionTarget }),
    collectStopped: collectStoppedInstructions,
    retirementFailed: async () => { await instructionCopies.reportRetirementUnconfirmed(agent.companyId, readRun().id); },
  } : undefined;

  async function prepare({ runtimeConfig, nativeRuntimeResolution, hasInstructionFilesystem }: {
    runtimeConfig: Record<string, unknown>;
    nativeRuntimeResolution: Selection["nativeRuntimeResolution"];
    hasInstructionFilesystem: boolean;
  }) {
    if (hasInstructionFilesystem) {
      try {
        // Missing contract fields on a restored session mean the deployed
        // legacy format. New sessions opt into whole-directory persistence.
        const priorFileRun = taskSession?.lastRunId
          ? await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.id, taskSession.lastRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).then(rows => rows[0])
          : null;
        const savedFileInput = parseObject(parseObject(readRun().runnerProfileJson).nativeExecutionInput);
        const priorFileInput = Object.keys(savedFileInput).length ? savedFileInput : parseObject(parseObject(priorFileRun?.profile).nativeExecutionInput);
        const priorWorkingCopy = parseObject(parseObject(parseObject(priorFileInput.runtimeContext).instructions).workingCopy);
        const warmFiles = nativeRuntimeResolution.kind === "native" && (nativeRuntimeResolution.profile.backend === "codex_app_server" ||
          (nativeRuntimeResolution.profile.backend === "acpx_runtime" && parseObject(agent.adapterConfig).acpxAgent === "cursor")) &&
          (executionTarget?.kind === "remote" && executionTarget.transport === "sandbox"
            ? executionTarget.runnerLifecyclePolicy?.mode === "warm"
            : parseObject(agent.adapterConfig).lifecycleMode === "warm");
        if (warmFiles && taskSessionForRun?.lastRunId) {
          nativeInstructionReservation = await reserveWarmNativeInstructionDirectory({ companyId: agent.companyId, agentId: agent.id,
            previousRunId: taskSessionForRun.lastRunId, runId: readRun().id, target: executionTarget,
            observabilityCompatibilityKey: input.observabilityCompatibilityKey,
            canReuse: () => instructionCopies.canReuseWarm(agent.companyId, agent.id, taskSessionForRun!.lastRunId!),
          });
        }
        if (!warmFiles && nativeRuntimeResolution.kind === "native" && priorWorkingCopy.kind === "agent_files" && taskSession) {
          releaseWarmInstructionPreparation = await claimWarmNativeInstructionCopy({
            observabilityCompatibilityKey: input.observabilityCompatibilityKey,
            priorExecution: parseNativeExecutionInput(priorFileInput), companyId: agent.companyId, agentId: agent.id,
            executionWorkspaceId: persistedExecutionWorkspace?.id ?? readRun().id, workspace: executionWorkspace,
            environmentId: executionTarget?.environmentId ?? null, runId: readRun().id, preparationKey: instructionPreparationKey, forceRetirement: !taskSessionForRun,
            adopt: async previousRunId => {
              instructionCopy = await instructionCopies.adopt({ companyId: agent.companyId, agentId: agent.id,
                runId: readRun().id, previousRunId, target: executionTarget, cwd: executionWorkspace.cwd, allowRetirementHandoff: true });
              return nativeInstructionWorkingCopy() ?? null;
            },
          });
          // A collection-only handoff was retired. Re-enter normal
          // preparation instead of composing a root already collected.
          if (!releaseWarmInstructionPreparation) instructionCopy = null;
        }
        const prepareInstructions = (reuseRunId?: string) => instructionCopies.prepare({
          companyId: agent.companyId, agentId: agent.id, runId: readRun().id,
          target: executionTarget, cwd: executionWorkspace.cwd,
          legacy: Object.keys(priorFileInput).length > 0 && priorWorkingCopy.kind !== "agent_files",
          warm: warmFiles, reuseRunId,
          onWarmHandoff: copy => {
            instructionCopy = copy;
            nativeInstructionReservation?.adopt(copy.executionRoot, collectStoppedInstructions);
          },
        });
        try {
          instructionCopy ??= await prepareInstructions(nativeInstructionReservation?.reuseRunId);
        } catch (error) {
          if (!(error instanceof AgentDirectoryReuseInvalidatedError)) throw error;
          // prepare has released its canonical lock. Retirement can now
          // collect under that same lock before a fresh restore starts.
          await nativeInstructionReservation?.release();
          nativeInstructionReservation = null;
          instructionCopy = await prepareInstructions();
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 403) throw error;
        // Missing write identity must not break a background run's read-only
        // prompt. It must also never imply that ordinary file edits will save.
        await appendRunEvent(readRun(), { eventType: "instruction_save", stream: "system", level: "warn",
          message: "Persistent instruction editing is unavailable. Use an authenticated user with instruction edit access and a managed instruction bundle.",
          payload: { state: "unavailable", code: "INSTRUCTION_COPY_UNAVAILABLE" } });
        const guidance = "No editable agent instruction working copy is registered for this turn. Use authenticated agent file tools for persistent edits; do not edit a private copy named in an earlier turn or claim its changes will persist.";
        for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownCompact"]) {
          context[key] = [readNonEmptyString(context[key]), guidance].filter(Boolean).join("\n\n");
        }
      }
      if (instructionCopy) {
        const storageWarning = readNonEmptyString(instructionCopy.receipt?.storageWarning);
        if (storageWarning) {
          instructionSave = { state: "prepared", contract: "agent_files", storageWarning };
          // This is an advisory on the run, never an agent pause, execution
          // failure, or scheduling gate. Keep it visible while work runs.
          await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ instructionSave })}::jsonb` }).where(eq(heartbeatRuns.id, readRun().id));
          await appendRunEvent(readRun(), { eventType: "instruction_save", stream: "system", level: "warn",
            message: storageWarning, payload: instructionSave });
        }
        runtimeConfig = { ...runtimeConfig, instructionsFilePath: path.join(instructionCopy.localRoot, instructionCopy.entryFile) };
        if (isAgentDirectoryCopy(instructionCopy)) {
          const workspace = parseObject(context.paperclipWorkspace);
          context.paperclipWorkspace = { ...workspace, agentHome: instructionCopy.executionRoot,
            // Keep the pre-existing permission root stable for ACP session
            // identity. The per-run copy is already under the company root.
            agentHomeForPermissions: workspace.agentHome,
          };
        }
        const guidance = instructionWorkingCopyGuidance(instructionCopy);
        for (const key of ["paperclipTaskMarkdown", "paperclipTaskMarkdownCompact"]) {
          context[key] = [readNonEmptyString(context[key]), guidance].filter(Boolean).join("\n\n");
        }
      }
    }
    return runtimeConfig;
  }

  return {
    prepare,
    collectStoppedInstructions,
    nativeInstructionWorkingCopy,
    get instructionCopy() { return instructionCopy; },
    getInstructionSave: () => instructionSave,
    // These getters remain usable after partial acquisition failures.
    get nativeInstructionReservation() { return nativeInstructionReservation; },
    get releaseWarmInstructionPreparation() { return releaseWarmInstructionPreparation; },
  };
}
