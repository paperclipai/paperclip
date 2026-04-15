import { useMemo } from "react";
import type { Agent } from "@paperclipai/shared";
import {
  ReactFlow,
  Background,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate } from "@/lib/router";

// ---- types -----------------------------------------------------------------

type AgentNodeStatus = "green" | "amber" | "red" | "gray";

type AgentNodeData = {
  label: string;
  sublabel: string;
  status: AgentNodeStatus;
  agentId: string | null;
  agentUrlKey: string | null;
  isCenter?: boolean;
};

type AgentFlowNode = Node<AgentNodeData, "agent">;

// ---- styles ----------------------------------------------------------------

type StatusStyle = { border: string; dot: string; text: string; bg: string };

const STATUS_STYLES: Record<AgentNodeStatus, StatusStyle> = {
  green: { border: "#10b981", dot: "#10b981", text: "#10b981", bg: "rgba(16,185,129,0.08)" },
  amber: { border: "#f59e0b", dot: "#f59e0b", text: "#f59e0b", bg: "rgba(245,158,11,0.08)" },
  red: { border: "#ef4444", dot: "#ef4444", text: "#ef4444", bg: "rgba(239,68,68,0.08)" },
  gray: { border: "#6b7280", dot: "#6b7280", text: "#9ca3af", bg: "rgba(107,114,128,0.06)" },
};

const CENTER_STYLE: StatusStyle = {
  border: "#3b82f6",
  dot: "#3b82f6",
  text: "#60a5fa",
  bg: "rgba(59,130,246,0.08)",
};

const HANDLE_STYLE = { width: 6, height: 6, opacity: 0 };

// ---- custom node -----------------------------------------------------------

function AgentFlowNodeComponent({ data }: NodeProps<AgentFlowNode>) {
  const s = data.isCenter ? CENTER_STYLE : STATUS_STYLES[data.status];

  return (
    <div
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 6,
        padding: "5px 10px",
        minWidth: 90,
        textAlign: "center",
        userSelect: "none",
        cursor: data.agentId ? "pointer" : "default",
      }}
    >
      <Handle id="l-out" type="source" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="r-out" type="source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="b-out" type="source" position={Position.Bottom} style={HANDLE_STYLE} />
      <Handle id="l-in" type="target" position={Position.Left} style={HANDLE_STYLE} />
      <Handle id="r-in" type="target" position={Position.Right} style={HANDLE_STYLE} />
      <Handle id="t-in" type="target" position={Position.Top} style={HANDLE_STYLE} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: s.dot,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: s.text, lineHeight: "1.3" }}>
          {data.label}
        </span>
      </div>
      <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1, lineHeight: "1.3" }}>
        {data.sublabel}
      </div>
    </div>
  );
}

const nodeTypes = { agent: AgentFlowNodeComponent } as const;

// ---- helpers ---------------------------------------------------------------

function agentNodeStatus(lastHeartbeatAt: Date | null, nowMs: number): AgentNodeStatus {
  if (!lastHeartbeatAt) return "gray";
  const diffMs = nowMs - new Date(lastHeartbeatAt).getTime();
  if (diffMs < 60 * 60 * 1000) return "green";
  if (diffMs < 3 * 60 * 60 * 1000) return "amber";
  return "red";
}

function agentSublabel(status: AgentNodeStatus, lastHeartbeatAt: Date | null): string {
  if (status === "gray") return "not deployed";
  if (!lastHeartbeatAt) return "no data";
  const diffMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

// ---- slots (logical layout) ------------------------------------------------

type AgentSlot = {
  id: string;
  label: string;
  nameMatch: string;
  x: number;
  y: number;
  notDeployed?: boolean;
};

const AGENT_SLOTS: AgentSlot[] = [
  { id: "felix", label: "Felix", nameMatch: "felix", x: 10, y: 50 },
  { id: "katya", label: "Katya", nameMatch: "katya", x: 370, y: 50 },
  { id: "quant", label: "Quant", nameMatch: "quant", x: 10, y: 135, notDeployed: true },
  { id: "builder", label: "Builder", nameMatch: "builder", x: 370, y: 135, notDeployed: true },
];

const STATIC_EDGES: Edge[] = [
  // Felix ↔ handoffs.md
  {
    id: "e-felix-handoffs",
    source: "felix",
    sourceHandle: "r-out",
    target: "handoffs",
    targetHandle: "l-in",
    animated: true,
    style: { stroke: "#10b981", strokeWidth: 1.5 },
  },
  {
    id: "e-handoffs-felix",
    source: "handoffs",
    sourceHandle: "l-out",
    target: "felix",
    targetHandle: "r-in",
    style: { stroke: "#6b7280", strokeWidth: 1, strokeDasharray: "4 2" },
  },
  // Katya ↔ handoffs.md
  {
    id: "e-katya-handoffs",
    source: "katya",
    sourceHandle: "l-out",
    target: "handoffs",
    targetHandle: "r-in",
    animated: true,
    style: { stroke: "#10b981", strokeWidth: 1.5 },
  },
  {
    id: "e-handoffs-katya",
    source: "handoffs",
    sourceHandle: "r-out",
    target: "katya",
    targetHandle: "l-in",
    style: { stroke: "#6b7280", strokeWidth: 1, strokeDasharray: "4 2" },
  },
  // Felix → Quant (pending)
  {
    id: "e-felix-quant",
    source: "felix",
    sourceHandle: "b-out",
    target: "quant",
    targetHandle: "t-in",
    style: { stroke: "#4b5563", strokeWidth: 1, strokeDasharray: "3 3" },
  },
  // Katya → Builder (pending)
  {
    id: "e-katya-builder",
    source: "katya",
    sourceHandle: "b-out",
    target: "builder",
    targetHandle: "t-in",
    style: { stroke: "#4b5563", strokeWidth: 1, strokeDasharray: "3 3" },
  },
];

// ---- component -------------------------------------------------------------

interface AgentFlowDiagramProps {
  agents: Agent[];
}

export function AgentFlowDiagram({ agents }: AgentFlowDiagramProps) {
  const navigate = useNavigate();
  const nowMs = Date.now();

  const nodes: AgentFlowNode[] = useMemo(() => {
    const built: AgentFlowNode[] = [];

    // Centre: handoffs.md
    built.push({
      id: "handoffs",
      type: "agent",
      position: { x: 190, y: 50 },
      data: {
        label: "handoffs.md",
        sublabel: "shared memory",
        status: "green",
        agentId: null,
        agentUrlKey: null,
        isCenter: true,
      },
      draggable: false,
    });

    for (const slot of AGENT_SLOTS) {
      const match = agents.find((a) =>
        a.name.toLowerCase().includes(slot.nameMatch),
      );

      const status: AgentNodeStatus = slot.notDeployed
        ? "gray"
        : match
          ? agentNodeStatus(match.lastHeartbeatAt, nowMs)
          : "gray";

      const sublabel = slot.notDeployed
        ? "not deployed"
        : agentSublabel(status, match?.lastHeartbeatAt ?? null);

      built.push({
        id: slot.id,
        type: "agent",
        position: { x: slot.x, y: slot.y },
        data: {
          label: slot.label,
          sublabel,
          status,
          agentId: match?.id ?? null,
          agentUrlKey: match?.urlKey ?? null,
        },
        draggable: false,
      });
    }

    return built;
  }, [agents, nowMs]);

  function handleNodeClick(_: React.MouseEvent, node: Node) {
    const data = node.data as AgentNodeData;
    if (data.agentId && data.agentUrlKey) {
      navigate(`/agents/${data.agentUrlKey}`);
    }
  }

  return (
    <div
      style={{
        height: 220,
        width: "100%",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid hsl(var(--border))",
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={STATIC_EDGES}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        zoomOnScroll={false}
        panOnDrag={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        style={{ background: "hsl(var(--card))" }}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={0.5} color="hsl(var(--border))" />
      </ReactFlow>
    </div>
  );
}
