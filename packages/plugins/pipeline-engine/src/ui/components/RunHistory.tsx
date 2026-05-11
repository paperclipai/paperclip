import { useState } from "react";
import { usePluginData, usePluginAction, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { RunReplayCanvas } from "./RunReplayCanvas.js";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import type { PipelineRun, PipelineStage, PipelineDefinition, PipelineRunStatus } from "../../types.js";

interface GetRunResult {
  run: PipelineRun;
  stages: PipelineStage[];
  pipeline: PipelineDefinition;
}

interface ListRunsResult {
  runs: PipelineRun[];
}

const RUN_STATUS_COLORS: Record<PipelineRunStatus, string> = {
  running: "#3b82f6",
  paused: "#f59e0b",
  completed: "#22c55e",
  failed: "#ef4444",
  escalated: "#f97316",
  cancelled: "#6b7280",
};

function RunStatusBadge({ status }: { status: PipelineRunStatus }) {
  const color = RUN_STATUS_COLORS[status] ?? "#6b7280";
  return (
    <span
      style={{
        background: color + "22",
        color,
        border: `1px solid ${color}44`,
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 700,
        padding: "2px 7px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        display: "inline-block",
      }}
    >
      {status}
    </span>
  );
}

function RunDetailPanel({
  runId,
  companyId,
  onClose,
}: {
  runId: string;
  companyId: string | null;
  onClose: () => void;
}) {
  const { data, loading, error } = usePluginData<GetRunResult>(DATA_KEYS.GET_RUN, {
    companyId,
    runId,
  });
  const cancelRun = usePluginAction(ACTION_KEYS.CANCEL_RUN);
  const [cancelling, setCancelling] = useState(false);

  if (loading) {
    return (
      <div style={{ padding: 24, color: "#9ca3af", textAlign: "center" }}>
        Loading run details...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: "#ef4444", textAlign: "center" }}>
        Error: {error.message}
      </div>
    );
  }

  if (!data) return null;

  const { run, stages, pipeline } = data;
  const canCancel = run.status === "running" || run.status === "paused";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: 520, border: "1px solid #374151", borderRadius: 8, overflow: "hidden", background: "#0f172a" }}>
      {/* Panel header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #374151",
          background: "#111827",
          flexShrink: 0,
        }}
      >
        <RunStatusBadge status={run.status} />
        <code style={{ color: "#9ca3af", fontSize: 11 }}>{run.pipelineName} v{run.pipelineVersion}</code>
        <div style={{ flex: 1 }} />
        {canCancel && (
          <button
            style={{
              background: "#7f1d1d",
              border: "1px solid #991b1b",
              borderRadius: 5,
              color: "#fca5a5",
              fontSize: 11,
              fontWeight: 600,
              padding: "4px 10px",
              cursor: "pointer",
              opacity: cancelling ? 0.6 : 1,
            }}
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await cancelRun({ companyId, runId: run.id });
              } finally {
                setCancelling(false);
              }
            }}
          >
            {cancelling ? "Cancelling…" : "Cancel Run"}
          </button>
        )}
        <button
          style={{
            background: "none",
            border: "none",
            color: "#9ca3af",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: "0 4px",
          }}
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {/* Replay canvas */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <RunReplayCanvas
          run={run}
          pipeline={pipeline}
          initialStages={stages}
          companyId={companyId}
        />
      </div>
    </div>
  );
}

export function PipelineRunsTab() {
  const { companyId, entityId } = useHostContext();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const { data, loading, error } = usePluginData<ListRunsResult>(DATA_KEYS.LIST_RUNS, {
    companyId,
    issueId: entityId,
  });

  if (loading) {
    return (
      <div style={{ padding: 32, color: "#9ca3af", textAlign: "center", background: "#111827" }}>
        Loading pipeline runs...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 32, color: "#ef4444", textAlign: "center", background: "#111827" }}>
        Error loading runs: {error.message}
      </div>
    );
  }

  const runs = data?.runs ?? [];

  if (runs.length === 0) {
    return (
      <div style={{ padding: 32, color: "#9ca3af", textAlign: "center", background: "#111827", fontSize: 13 }}>
        No pipeline runs for this issue.
      </div>
    );
  }

  return (
    <div style={{ background: "#111827", color: "#f9fafb", padding: "16px 0" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {runs.map((run) => (
          <div key={run.id} style={{ borderBottom: "1px solid #1f2937" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 16px",
                cursor: "pointer",
              }}
              onClick={() =>
                setExpandedRunId((prev) => (prev === run.id ? null : run.id))
              }
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "#1f2937"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <RunStatusBadge status={run.status} />
              <span style={{ color: "#f9fafb", fontSize: 13, fontWeight: 600 }}>
                {run.pipelineName}
              </span>
              <span style={{ color: "#9ca3af", fontSize: 11 }}>v{run.pipelineVersion}</span>
              <span style={{ color: "#6b7280", fontSize: 11, marginLeft: "auto" }}>
                {new Date(run.createdAt).toLocaleString()}
              </span>
              <span style={{ color: "#9ca3af", fontSize: 12 }}>
                {expandedRunId === run.id ? "▲" : "▼"}
              </span>
            </div>

            {expandedRunId === run.id && (
              <div style={{ padding: "0 16px 16px" }}>
                <RunDetailPanel
                  runId={run.id}
                  companyId={companyId}
                  onClose={() => setExpandedRunId(null)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
