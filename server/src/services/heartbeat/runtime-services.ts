import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { parseObject } from "../../adapters/utils.js";
import { assertLowTrustRuntimeServicesAllowed } from "../low-trust-runtime-containment.js";
import {
  buildWorkspaceReadyComment, buildWorkspaceReadyMetadata, buildWorkspaceReadyPresentation,
  ensureRuntimeServicesForRun, persistAdapterManagedRuntimeServices,
  type RealizedExecutionWorkspace, type RuntimeServiceRef,
} from "../workspace-runtime.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

type WorkspaceReadyCommentWriter = {
  addComment: (
    issueId: string,
    body: string,
    actor: { agentId?: string; userId?: string; runId?: string | null },
    options?: {
      presentation?: ReturnType<typeof buildWorkspaceReadyPresentation>;
      metadata?: ReturnType<typeof buildWorkspaceReadyMetadata>;
    },
  ) => Promise<unknown>;
};

export function postWorkspaceReadyComment(input: {
  issuesSvc: WorkspaceReadyCommentWriter;
  issueId: string;
  agentId: string;
  runId: string;
  workspace: RealizedExecutionWorkspace;
  runtimeServices: RuntimeServiceRef[];
}) {
  const workspaceReadyInput = {
    workspace: input.workspace,
    runtimeServices: input.runtimeServices,
  };
  return input.issuesSvc.addComment(
    input.issueId,
    buildWorkspaceReadyComment(workspaceReadyInput),
    { agentId: input.agentId, runId: input.runId },
    {
      presentation: buildWorkspaceReadyPresentation(workspaceReadyInput),
      metadata: buildWorkspaceReadyMetadata(workspaceReadyInput),
    },
  );
}

type RuntimeInput = Parameters<typeof ensureRuntimeServicesForRun>[0];
interface RuntimeServiceContext {
  run: { id: string };
  agent: RuntimeInput["agent"] & { id: string; adapterType: string };
  issueId: string | null;
  issueRef: (NonNullable<RuntimeInput["issue"]> & { executionWorkspaceId: string | null }) | null;
  executionWorkspace: RealizedExecutionWorkspace;
  context: Record<string, unknown>;
  issuesSvc: WorkspaceReadyCommentWriter;
  onLog: NonNullable<RuntimeInput["onLog"]>;
}

/** Service processes and leases stay in workspace-runtime; the executor releases them. */
export function prepareHeartbeatRuntimeServiceIntents(input: {
  hostExecutionWorkspaceConfig: Record<string, unknown>;
  context: Record<string, unknown>;
  trustPreset: Parameters<typeof assertLowTrustRuntimeServicesAllowed>[0]["resolution"];
}) {
  const { hostExecutionWorkspaceConfig, context, trustPreset } = input;
  const runtimeServiceIntents = (() => {
    const runtimeConfig = parseObject(
      hostExecutionWorkspaceConfig.workspaceRuntime,
    );
    return Array.isArray(runtimeConfig.services)
      ? runtimeConfig.services.filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null,
        )
      : [];
  })();
  assertLowTrustRuntimeServicesAllowed({
    resolution: trustPreset,
    runtimeServiceCount: runtimeServiceIntents.length,
  });
  if (runtimeServiceIntents.length > 0) {
    context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
  } else {
    delete context.paperclipRuntimeServiceIntents;
  }
}

export async function startHeartbeatRuntimeServices(db: Db, input: RuntimeServiceContext & {
  persistedExecutionWorkspace: { id: string } | null;
  hostExecutionWorkspaceConfig: Record<string, unknown>;
  skipHostProvision?: boolean;
  adapterEnv: RuntimeInput["adapterEnv"];
  workspaceOperationRecorder: RuntimeInput["recorder"];
}) {
  const { run, agent, issueId, issueRef, executionWorkspace, context, issuesSvc, onLog,
    persistedExecutionWorkspace, hostExecutionWorkspaceConfig, adapterEnv, workspaceOperationRecorder } = input;
  const runtimeServices = await ensureRuntimeServicesForRun({
    db,
    runId: run.id,
    agent: {
      id: agent.id,
      name: agent.name,
      companyId: agent.companyId,
    },
    issue: issueRef,
    workspace: executionWorkspace,
    executionWorkspaceId:
      persistedExecutionWorkspace?.id ??
      issueRef?.executionWorkspaceId ??
      null,
    config: hostExecutionWorkspaceConfig,
    skipHostProvision: input.skipHostProvision,
    adapterEnv,
    onLog,
    recorder: workspaceOperationRecorder,
  });
  if (runtimeServices.length > 0) {
    context.paperclipRuntimeServices = runtimeServices;
    context.paperclipRuntimePrimaryUrl =
      runtimeServices.find((service) => readNonEmptyString(service.url))
        ?.url ?? null;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
  }
  if (
    issueId &&
    (executionWorkspace.created ||
      runtimeServices.some((service) => !service.reused))
  ) {
    try {
      await postWorkspaceReadyComment({
        issuesSvc,
        issueId,
        agentId: agent.id,
        runId: run.id,
        workspace: executionWorkspace,
        runtimeServices,
      });
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return runtimeServices;
}

export async function recordHeartbeatAdapterRuntimeServices(db: Db, input: RuntimeServiceContext & {
  adapterResult: Pick<AdapterExecutionResult, "runtimeServices">;
  runtimeServices: RuntimeServiceRef[];
}) {
  const { run, agent, issueId, issueRef, executionWorkspace, context, issuesSvc, onLog,
    adapterResult, runtimeServices } = input;
  const adapterManagedRuntimeServices = adapterResult.runtimeServices
    ? await persistAdapterManagedRuntimeServices({
        db,
        adapterType: agent.adapterType,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        reports: adapterResult.runtimeServices,
      })
    : [];
  if (adapterManagedRuntimeServices.length > 0) {
    const combinedRuntimeServices = [
      ...runtimeServices,
      ...adapterManagedRuntimeServices,
    ];
    context.paperclipRuntimeServices = combinedRuntimeServices;
    context.paperclipRuntimePrimaryUrl =
      combinedRuntimeServices.find((service) =>
        readNonEmptyString(service.url),
      )?.url ?? null;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
    if (issueId) {
      try {
        await postWorkspaceReadyComment({
          issuesSvc,
          issueId,
          agentId: agent.id,
          runId: run.id,
          workspace: executionWorkspace,
          runtimeServices: adapterManagedRuntimeServices,
        });
      } catch (err) {
        await onLog(
          "stderr",
          `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}
