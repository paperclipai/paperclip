import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StageDefinition, StageStatus } from "../../types.js";

export interface StageNodeData {
  stage: StageDefinition;
  status?: StageStatus;
  subtitle?: string;
  decisionValues?: string[];
  onSelect?: (id: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  stage: "#3b82f6",
  fan_out: "#06b6d4",
  fan_in: "#8b5cf6",
  "sub-pipeline": "#22c55e",
};

const TYPE_BADGES: Record<string, string> = {
  stage: "STG",
  fan_out: "FAN",
  fan_in: "FIN",
  "sub-pipeline": "SUB",
};

function getBorderStyle(status: StageStatus | undefined): string {
  switch (status) {
    case "running":
      return "2px solid #3b82f6";
    case "completed":
      return "2px solid #22c55e";
    case "failed":
      return "2px solid #ef4444";
    case "skipped":
      return "2px dashed #6b7280";
    default:
      return "1px solid #374151";
  }
}

export function StageNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as StageNodeData;
  const { stage, status, subtitle, decisionValues, onSelect } = nodeData;
  const instructions = "instructions" in stage ? stage.instructions : undefined;
  const hasDecisionHandles = decisionValues && decisionValues.length > 0;
  const typeColor = TYPE_COLORS[stage.type] ?? "#6b7280";
  const badge = TYPE_BADGES[stage.type] ?? "???";
  const border = getBorderStyle(status);

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect?.(id); }}
      style={{
        background: "#1f2937",
        border: selected ? "2px solid #6366f1" : border,
        borderRadius: 8,
        width: 200,
        minHeight: 90,
        position: "relative",
        cursor: "pointer",
        boxShadow: selected ? "0 0 0 2px #6366f140" : "none",
        overflow: "hidden",
      }}
    >
      {/* Left color strip */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: typeColor,
          borderRadius: "8px 0 0 8px",
        }}
      />

      {/* Badge top-right */}
      <div
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          background: typeColor + "33",
          color: typeColor,
          border: `1px solid ${typeColor}66`,
          borderRadius: 4,
          fontSize: 9,
          fontWeight: 700,
          padding: "1px 4px",
          letterSpacing: "0.05em",
        }}
      >
        {badge}
      </div>

      {/* Content */}
      <div style={{ padding: "10px 32px 10px 14px", minHeight: 90, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
        <div style={{ color: "#f9fafb", fontSize: 13, fontWeight: 600, wordBreak: "break-word", lineHeight: 1.3 }}>
          {stage.id}
        </div>
        {"agent_role" in stage && stage.agent_role && (
          <div style={{ color: "#9ca3af", fontSize: 11 }}>{stage.agent_role}</div>
        )}
        {"pipeline" in stage && stage.pipeline && (
          <div style={{ color: "#9ca3af", fontSize: 11 }}>→ {stage.pipeline}</div>
        )}
        {subtitle && (
          <div style={{ color: "#9ca3af", fontSize: 10, fontStyle: "italic" }}>{subtitle}</div>
        )}
        {status && status !== "pending" && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              color:
                status === "completed"
                  ? "#22c55e"
                  : status === "failed"
                  ? "#ef4444"
                  : status === "running"
                  ? "#3b82f6"
                  : "#9ca3af",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {status}
          </div>
        )}
        {instructions && (
          <div style={{
            color: "#6b7280",
            fontSize: 10,
            lineHeight: 1.3,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}>
            {instructions}
          </div>
        )}
      </div>

      {/* ReactFlow handles */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "#374151", border: "2px solid #6b7280", width: 10, height: 10 }}
      />
      {hasDecisionHandles ? (
        decisionValues.map((value, idx) => (
          <Handle
            key={value}
            type="source"
            position={Position.Bottom}
            id={value}
            style={{
              left: `${((idx + 1) / (decisionValues.length + 1)) * 100}%`,
              background: "#374151",
              border: "2px solid #6b7280",
              width: 10,
              height: 10,
            }}
          />
        ))
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: "#374151", border: "2px solid #6b7280", width: 10, height: 10 }}
        />
      )}

      {hasDecisionHandles && (
        <div style={{
          position: "absolute",
          bottom: -18,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "space-around",
          pointerEvents: "none",
        }}>
          {decisionValues.map((value) => (
            <span key={value} style={{ fontSize: 8, color: "#6b7280" }}>{value}</span>
          ))}
        </div>
      )}
    </div>
  );
}
