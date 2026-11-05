import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import { parseCodexTurnDiff } from "../vendor/paperclip-runner/index.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

type WorkspaceDiffPayload = {
  schema: "paperclip.workspace.diff.v1";
  changeSetId: string;
  revision: number;
  source: "runner_verified";
  complete: true;
  files: ReturnType<typeof parseCodexTurnDiff>;
  totals: { files: number; additions: number | null; deletions: number | null };
  patchArtifactRef: null;
};

export type WorkspaceDiffReprojectionSkipReason = {
  reason:
    | "trace_unavailable"
    | "trace_expired"
    | "trace_incomplete"
    | "malformed_frame"
    | "missing_turn_id"
    | "malformed_diff"
    | "already_recorded";
  turnId?: string;
  changeSetId?: string;
  frameId?: number;
};

export interface WorkspaceDiffTraceProjection {
  turns: Array<{ turnId: string; payload: WorkspaceDiffPayload }>;
  skipReasons: WorkspaceDiffReprojectionSkipReason[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableTurnId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : null;
}

/** Selects the last valid complete Codex diff snapshot for each turn. */
export function projectCodexWorkspaceDiffsFromTrace(
  entries: Record<string, unknown>[],
): WorkspaceDiffTraceProjection {
  const revisions = new Map<string, number>();
  const turns = new Map<string, { turnId: string; payload: WorkspaceDiffPayload }>();
  const skipReasons: WorkspaceDiffReprojectionSkipReason[] = [];

  for (const entry of entries) {
    if (entry.kind !== "frame" || entry.direction !== "provider_to_client") continue;
    const frameId = Number.isSafeInteger(entry.frameId) ? Number(entry.frameId) : undefined;
    let message: Record<string, unknown>;
    try {
      if (typeof entry.rawBase64 !== "string") throw new Error("missing frame bytes");
      message = record(JSON.parse(Buffer.from(entry.rawBase64, "base64").toString("utf8")));
    } catch {
      skipReasons.push({ reason: "malformed_frame", ...(frameId ? { frameId } : {}) });
      continue;
    }
    if (message.method !== "turn/diff/updated") continue;
    const params = record(message.params);
    const turnId = stableTurnId(params.turnId);
    if (turnId === null) {
      skipReasons.push({ reason: "missing_turn_id", ...(frameId ? { frameId } : {}) });
      continue;
    }
    const patch = typeof params.diff === "string" ? params.diff : "";
    const files = parseCodexTurnDiff(patch);
    if (patch.trim().length > 0 && files.length === 0) {
      skipReasons.push({ reason: "malformed_diff", turnId, ...(frameId ? { frameId } : {}) });
      continue;
    }
    const revision = (revisions.get(turnId) ?? 0) + 1;
    revisions.set(turnId, revision);
    const unknown = files.some((file) => file.additions === null || file.deletions === null);
    turns.set(turnId, {
      turnId,
      payload: {
        schema: "paperclip.workspace.diff.v1",
        changeSetId: `${turnId}:workspace`,
        revision,
        source: "runner_verified",
        complete: true,
        files,
        totals: {
          files: files.length,
          additions: unknown ? null : files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
          deletions: unknown ? null : files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        },
        patchArtifactRef: null,
      },
    });
  }

  return { turns: [...turns.values()], skipReasons };
}

export async function persistReprojectedWorkspaceDiffs(
  db: Db,
  input: {
    traceId: string;
    runId: string;
    companyId: string;
    agentId: string;
    projection: WorkspaceDiffTraceProjection;
  },
) {
  const existing = await db
    .select({ payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, input.runId),
      inArray(heartbeatRunEvents.eventType, ["workspace.change.updated", "workspace.diff.recorded"]),
    ));
  const recordedChangeSets = new Set(
    existing.flatMap((row) => {
      const payload = record(row.payload);
      return row.payload &&
        payload.complete === true &&
        typeof payload.changeSetId === "string"
        ? [payload.changeSetId]
        : [];
    }),
  );
  const skipReasons = [...input.projection.skipReasons];
  let created = 0;

  for (const [index, candidate] of input.projection.turns.entries()) {
    if (recordedChangeSets.has(candidate.payload.changeSetId)) {
      skipReasons.push({
        reason: "already_recorded",
        turnId: candidate.turnId,
        changeSetId: candidate.payload.changeSetId,
      });
      continue;
    }
    const result = await appendHeartbeatRunEvent(db, {
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      eventType: "workspace.diff.recorded",
      payload: candidate.payload,
      nativeSource: {
        sourceInstanceId: `provider-trace-reproject:${input.traceId}`,
        sourceEventId: `provider-trace-reproject:${input.traceId}:${candidate.payload.changeSetId}`,
        sourceSeq: index + 1,
        protocolSchemaVersion: 1,
        canonicalPayload: candidate.payload,
      },
    });
    if (result.disposition === "committed") created += 1;
    else {
      skipReasons.push({
        reason: "already_recorded",
        turnId: candidate.turnId,
        changeSetId: candidate.payload.changeSetId,
      });
    }
  }

  return {
    created,
    skipped: skipReasons.length,
    skipReasons,
  };
}
