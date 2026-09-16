import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkFolderSyncStatus } from "../../packages/shared/src/work-folders.js";
import type { APIResponse } from "@playwright/test";
import type { RunnerApi } from "./api.js";

/** Observe the persistence contract selected by the host for this exact run. */
export async function readWarmWorkspaceFile(input: {
  api: Pick<RunnerApi, "get"> & {
    request: {
      get(path: string): Promise<Pick<APIResponse, "ok" | "status" | "text">>;
    };
  };
  run: {
    id: string;
    companyId: string;
    agentId: string;
  };
  issueId: string;
  workspacePath: string;
  filename: string;
}): Promise<{ source: "task-cache" | "host-workspace"; content: string }> {
  const { api, run, issueId, workspacePath, filename } = input;
  assert(
    /^[a-zA-Z0-9-]+\.txt$/.test(filename),
    "Invalid warm fixture filename",
  );
  // Company run listings summarize context. Absence there cannot establish
  // that the run uses the legacy host-workspace contract.
  const fullRun = await api.get<
    typeof run & {
      contextSnapshot: Record<string, unknown> | null;
      status: string;
      startedAt: string | null;
      finishedAt: string | null;
    }
  >(`/api/heartbeat-runs/${encodeURIComponent(run.id)}`);
  assert.equal(fullRun.id, run.id);
  assert.equal(fullRun.companyId, run.companyId);
  assert.equal(fullRun.agentId, run.agentId);
  assert(
    Object.hasOwn(fullRun, "contextSnapshot"),
    "Full run context is required",
  );
  assert(
    fullRun.contextSnapshot === null ||
      (typeof fullRun.contextSnapshot === "object" &&
        !Array.isArray(fullRun.contextSnapshot)),
    "Invalid full run context",
  );
  assert.equal(fullRun.status, "succeeded", "Warm turn must succeed");
  const manifest = fullRun.contextSnapshot?.paperclipWorkFolders;
  if (manifest === undefined || manifest === null) {
    return {
      source: "host-workspace",
      content: await readFile(path.join(workspacePath, filename), "utf8"),
    };
  }

  assert(typeof manifest === "object", "Invalid host work-folder manifest");
  const binding = manifest as Record<string, unknown>;
  assert.equal(binding.version, 1);
  assert.equal(binding.runId, run.id);
  assert.equal(binding.companyId, run.companyId);
  assert.equal(binding.agentId, run.agentId);
  assert.equal(binding.taskId, issueId);
  assert(binding.folders && typeof binding.folders === "object");
  assert(typeof (binding.folders as Record<string, unknown>).task === "string");

  const base = `/api/companies/${encodeURIComponent(run.companyId)}/work-folders/task/${encodeURIComponent(issueId)}`;
  const statuses = await api.get<WorkFolderSyncStatus[]>(`${base}/sync`);
  const saved = statuses.find((status) => status.runId === run.id);
  assert(
    saved && saved.state === "saved" && !saved.active && saved.lastSavedAt,
    "The completed warm turn must have a successful final file save",
  );
  const startedAt = Date.parse(fullRun.startedAt ?? "");
  const finishedAt = Date.parse(fullRun.finishedAt ?? "");
  const finalizedAt = Date.parse(saved.finalCheckpointAt ?? "");
  const savedAt = Date.parse(saved.lastSavedAt);
  assert(
    Number.isFinite(startedAt) &&
      Number.isFinite(finishedAt) &&
      Number.isFinite(finalizedAt) &&
      Number.isFinite(savedAt) &&
      startedAt <= finalizedAt &&
      finalizedAt <= savedAt &&
      savedAt <= finishedAt,
    "Warm turn requires explicit finalization and save timestamps within this run",
  );
  const response = await api.request.get(
    `${base}/content?path=${encodeURIComponent(filename)}`,
  );
  assert(
    response.ok(),
    `Warm task file download returned ${response.status()}`,
  );
  return { source: "task-cache", content: await response.text() };
}

/** Stable warm processes or an explicitly recorded run-capability rotation. */
export function nativeWarmProcessFailures(
  runs: readonly {
    id: string;
    companyId: string;
    agentId: string;
    nativeSessionId?: string | null;
    runnerInstanceId?: string | null;
    processPid?: number | null;
    processStartedAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }[],
  eventGroups: readonly {
    runId: string;
    events: readonly {
      eventType?: string;
      stream?: string | null;
      payload?: Record<string, unknown> | null;
    }[];
  }[],
): string[] {
  const failures: string[] = [];
  for (const [index, run] of runs.entries()) {
    if (
      !Number.isSafeInteger(run.processPid) ||
      run.processPid! <= 0 ||
      !Number.isFinite(Date.parse(run.processStartedAt ?? ""))
    ) {
      failures.push(`missing native process identity for warm run ${run.id}`);
      continue;
    }
    const group = eventGroups.find((group) => group.runId === run.id);
    if (!group) {
      failures.push(`missing native process events for warm run ${run.id}`);
      continue;
    }
    const rotations = group.events.filter(
      (event) => event.eventType === "native.session.process_rotation",
    );
    const previous = runs[index - 1];
    const sameProcess =
      !previous ||
      (previous.processPid === run.processPid &&
        previous.processStartedAt === run.processStartedAt);
    if (sameProcess) {
      if (rotations.length)
        failures.push(
          `unexpected native process rotation for warm run ${run.id}`,
        );
      continue;
    }
    const event = rotations[0];
    const payload = event?.payload;
    const started = Date.parse(run.startedAt ?? "");
    const finished = Date.parse(run.finishedAt ?? "");
    const processStarted = Date.parse(run.processStartedAt!);
    if (
      rotations.length !== 1 ||
      event?.stream !== "system" ||
      payload?.reason !== "run_scoped_github_capability" ||
      payload.previousRunId !== previous.id ||
      payload.runId !== run.id ||
      payload.companyId !== run.companyId ||
      payload.agentId !== run.agentId ||
      payload.nativeSessionId !== run.nativeSessionId ||
      payload.runnerInstanceId !== run.runnerInstanceId ||
      !Number.isFinite(started) ||
      !Number.isFinite(finished) ||
      processStarted < started ||
      processStarted > finished ||
      processStarted <= Date.parse(previous.processStartedAt ?? "")
    ) {
      failures.push(
        `native warm process changed without a matching run-scoped credential rotation for ${run.id}`,
      );
    }
  }
  return failures;
}
