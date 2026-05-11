import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
} from "@xyflow/react";
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { StageNode, type StageNodeData } from "./StageNode.js";
import { STREAM_CHANNELS } from "../constants.js";
import type { PipelineDefinition, PipelineRun, PipelineStage, StageStatus } from "../../types.js";

const NODE_TYPES = { stage: StageNode };

interface RunProgressEvent {
  runId: string;
  stageId: string;
  status: StageStatus;
  error?: string | null;
}

interface RunReplayCanvasProps {
  run: PipelineRun;
  pipeline: PipelineDefinition;
  initialStages: PipelineStage[];
  companyId: string | null;
}

export function RunReplayCanvas({ run, pipeline, initialStages, companyId }: RunReplayCanvasProps) {
  const { events: streamEvents } = usePluginStream<RunProgressEvent>(STREAM_CHANNELS.RUN_PROGRESS, {
    companyId: companyId ?? undefined,
  });

  // Merge initial stages with stream updates
  const liveStages = useMemo(() => {
    const statusMap = new Map<string, StageStatus>(
      initialStages.map((s) => [s.stageId, s.status]),
    );
    for (const ev of streamEvents) {
      if (ev.runId === run.id) {
        statusMap.set(ev.stageId, ev.status);
      }
    }
    return statusMap;
  }, [initialStages, streamEvents, run.id]);

  const initialNodes = useMemo(() =>
    pipeline.stages.map((stage) => ({
      id: stage.id,
      type: "stage" as const,
      position: pipeline.positions?.[stage.id] ?? { x: 0, y: 0 },
      data: {
        stage,
        status: liveStages.get(stage.id) ?? "pending",
      } as unknown as StageNodeData,
      draggable: false,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const initialEdges = useMemo(
    () =>
      (pipeline.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.label,
        style: { stroke: e.type === "error" ? "#ef4444" : "#4b5563", strokeWidth: 2 },
        animated: false,
      })),
    [pipeline.edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes as unknown as Node[]);
  const [edges, , onEdgesChange] = useEdgesState(initialEdges);

  // Update node statuses when stream events arrive
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const newStatus = liveStages.get(n.id);
        if (!newStatus) return n;
        const current = (n.data as unknown as StageNodeData).status;
        if (current === newStatus) return n;
        return {
          ...n,
          data: { ...(n.data as object), status: newStatus } as unknown as StageNodeData,
        } as unknown as Node;
      }),
    );
  }, [liveStages, setNodes]);

  const runStatusColor: Record<string, string> = {
    running: "#3b82f6",
    paused: "#f59e0b",
    completed: "#22c55e",
    failed: "#ef4444",
    escalated: "#f97316",
    cancelled: "#6b7280",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Run status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid #374151",
          background: "#111827",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#9ca3af", fontSize: 12 }}>Run:</span>
        <code style={{ color: "#f9fafb", fontSize: 11 }}>{run.id}</code>
        <div
          style={{
            background: (runStatusColor[run.status] ?? "#6b7280") + "22",
            color: runStatusColor[run.status] ?? "#6b7280",
            border: `1px solid ${runStatusColor[run.status] ?? "#6b7280"}44`,
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 8px",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {run.status}
        </div>
        <span style={{ color: "#9ca3af", fontSize: 11, marginLeft: "auto" }}>
          {new Date(run.createdAt).toLocaleString()}
        </span>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          fitView
          style={{ background: "#0f172a" }}
        >
          <Background color="#1f2937" gap={20} size={1} />
          <Controls style={{ background: "#1f2937", border: "1px solid #374151" }} />
        </ReactFlow>
      </div>

      {/* Stage legend */}
      <div
        style={{
          display: "flex",
          gap: 16,
          padding: "8px 16px",
          borderTop: "1px solid #374151",
          background: "#111827",
          flexShrink: 0,
        }}
      >
        {(["pending", "running", "completed", "failed", "skipped"] as StageStatus[]).map((s) => (
          <div key={s} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  s === "running" ? "#3b82f6"
                  : s === "completed" ? "#22c55e"
                  : s === "failed" ? "#ef4444"
                  : "#6b7280",
              }}
            />
            <span style={{ color: "#9ca3af", fontSize: 10, textTransform: "capitalize" }}>{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
