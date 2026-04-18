import { useState, useCallback, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, Save, Play, Plus, Bot, GitBranch, UserCheck, Shuffle, Clock, Globe, Trash2, Loader2 } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowsApi } from "@/api/routines";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, string>;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

type NodeType = "agent_task" | "decision" | "approval" | "transform" | "delay" | "webhook";

const NODE_PALETTE: { type: NodeType; label: string; icon: typeof Bot; color: string }[] = [
  { type: "agent_task", label: "Agent Task", icon: Bot, color: "var(--accent)" },
  { type: "decision", label: "Decision", icon: GitBranch, color: "var(--warning)" },
  { type: "approval", label: "Approval", icon: UserCheck, color: "var(--success)" },
  { type: "transform", label: "Transform", icon: Shuffle, color: "#8B5CF6" },
  { type: "delay", label: "Delay", icon: Clock, color: "var(--fg-muted)" },
  { type: "webhook", label: "Webhook", icon: Globe, color: "#EC4899" },
];

function parseGraph(graphJson: string | undefined | null): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  try {
    const parsed = JSON.parse(graphJson || "{}");
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export function WorkflowBuilder() {
  const navigate = useNavigate();
  const { workflowId } = useParams<{ workflowId: string }>();
  const queryClient = useQueryClient();

  const { data: workflow, isLoading } = useQuery({
    queryKey: [...queryKeys.workflows.list(""), "detail", workflowId],
    queryFn: () => workflowsApi.get(workflowId!),
    enabled: !!workflowId,
  });

  const initialGraph = parseGraph(workflow?.graph);
  const [nodes, setNodes] = useState<WorkflowNode[]>(initialGraph.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(initialGraph.edges);
  const [initialized, setInitialized] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Sync state when workflow data arrives
  if (workflow && !initialized) {
    const graph = parseGraph(workflow.graph);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      workflowsApi.update(workflowId!, undefined, JSON.stringify({ nodes, edges })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list("") });
    },
  });

  const getNodeStyle = (type: NodeType) => {
    const item = NODE_PALETTE.find((n) => n.type === type);
    return item ? { color: item.color } : { color: "var(--fg-muted)" };
  };

  const handleCanvasDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("node-type") as NodeType;
    if (!type || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - 80;
    const y = e.clientY - rect.top - 40;
    const item = NODE_PALETTE.find((n) => n.type === type);
    if (!item) return;

    const newNode: WorkflowNode = {
      id: `n${Date.now()}`,
      type,
      label: item.label,
      x: Math.max(0, x),
      y: Math.max(0, y),
      config: {},
    };
    setNodes((prev) => [...prev, newNode]);
  }, []);

  const handleNodeDrag = useCallback((nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDragTarget(nodeId);
    const startX = e.clientX;
    const startY = e.clientY;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const origX = node.x;
    const origY = node.y;

    const onMove = (ev: MouseEvent) => {
      setNodes((prev) => prev.map((n) => n.id === nodeId ? { ...n, x: origX + ev.clientX - startX, y: origY + ev.clientY - startY } : n));
    };
    const onUp = () => {
      setDragTarget(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [nodes]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin" style={{ color: "var(--fg-muted)" }} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col -m-8">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/workflows")} className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg-muted)" }}>
            <ArrowLeft size={14} /> Back
          </button>
          <span className="text-sm font-medium">{workflow?.name ?? "Untitled Workflow"}</span>
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium capitalize" style={{ background: "var(--bg-muted)", color: "var(--fg-muted)" }}>
            {workflow?.status ?? "draft"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium"
            style={{ borderColor: "var(--border)", color: "var(--fg-secondary)" }}
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            <Save size={14} /> {saveMutation.isPending ? "Saving..." : "Save"}
          </button>
          <button className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] font-medium" style={{ background: "var(--accent)", color: "var(--accent-fg)" }}>
            <Play size={14} /> Run
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Node palette */}
        <div className="w-48 shrink-0 border-r p-3 overflow-y-auto" style={{ borderColor: "var(--border-subtle)", background: "var(--sidebar-bg)" }}>
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>
            Nodes
          </div>
          {NODE_PALETTE.map(({ type, label, icon: Icon, color }) => (
            <div
              key={type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("node-type", type)}
              className="flex cursor-grab items-center gap-2.5 rounded-md px-3 py-2 mb-1 text-[13px] transition-colors hover:bg-[var(--bg-muted)] active:cursor-grabbing"
              style={{ color: "var(--fg-secondary)" }}
            >
              <Icon size={14} style={{ color }} />
              {label}
            </div>
          ))}
        </div>

        {/* Canvas */}
        <div
          ref={canvasRef}
          className="flex-1 relative overflow-auto"
          style={{ background: "var(--bg)", backgroundImage: "radial-gradient(circle, var(--border-subtle) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleCanvasDrop}
          onClick={() => setSelectedNode(null)}
        >
          {/* Edges (SVG) */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ minWidth: 900, minHeight: 400 }}>
            {edges.map((edge) => {
              const source = nodes.find((n) => n.id === edge.source);
              const target = nodes.find((n) => n.id === edge.target);
              if (!source || !target) return null;
              const sx = source.x + 160;
              const sy = source.y + 40;
              const tx = target.x;
              const ty = target.y + 40;
              const mx = (sx + tx) / 2;

              return (
                <g key={edge.id}>
                  <path
                    d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth="2"
                  />
                  {edge.label && (
                    <text x={mx} y={(sy + ty) / 2 - 8} textAnchor="middle" fill="var(--fg-muted)" fontSize="11" fontFamily="var(--font-body)">
                      {edge.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Nodes */}
          {nodes.map((node) => {
            const style = getNodeStyle(node.type);
            const Icon = NODE_PALETTE.find((n) => n.type === node.type)?.icon || Bot;
            const isSelected = selectedNode === node.id;

            return (
              <div
                key={node.id}
                className={cn(
                  "absolute flex w-40 cursor-move items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-shadow select-none",
                  dragTarget === node.id && "shadow-lg",
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  background: "var(--card-bg)",
                  borderColor: isSelected ? style.color : "var(--card-border)",
                  borderWidth: isSelected ? 2 : 1,
                  boxShadow: isSelected ? `0 0 0 3px color-mix(in oklch, ${style.color} 20%, transparent)` : undefined,
                }}
                onClick={(e) => { e.stopPropagation(); setSelectedNode(node.id); }}
                onMouseDown={(e) => handleNodeDrag(node.id, e)}
              >
                <Icon size={16} style={{ color: style.color, flexShrink: 0 }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium truncate">{node.label}</div>
                  {node.config.agent && (
                    <div className="text-[10px] truncate" style={{ color: "var(--fg-muted)" }}>{node.config.agent}</div>
                  )}
                </div>
              </div>
            );
          })}

          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center" style={{ color: "var(--fg-muted)" }}>
                <Plus size={32} className="mx-auto mb-2 opacity-30" />
                <p className="text-[13px]">Drag nodes from the palette to get started</p>
              </div>
            </div>
          )}
        </div>

        {/* Properties panel */}
        {selectedNode && (
          <div className="w-56 shrink-0 border-l p-4 overflow-y-auto" style={{ borderColor: "var(--border-subtle)", background: "var(--sidebar-bg)" }}>
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--fg-muted)" }}>
              Properties
            </div>
            {(() => {
              const node = nodes.find((n) => n.id === selectedNode);
              if (!node) return null;
              const palette = NODE_PALETTE.find((n) => n.type === node.type);
              return (
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium" style={{ color: "var(--fg-muted)" }}>Type</label>
                    <div className="text-[13px] font-medium">{palette?.label}</div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium" style={{ color: "var(--fg-muted)" }}>Label</label>
                    <input
                      value={node.label}
                      onChange={(e) => setNodes((prev) => prev.map((n) => n.id === node.id ? { ...n, label: e.target.value } : n))}
                      className="w-full rounded-md border px-2 py-1.5 text-[13px] outline-none"
                      style={{ background: "var(--input-bg)", borderColor: "var(--input-border)", color: "var(--fg)", fontFamily: "var(--font-body)" }}
                    />
                  </div>
                  <button
                    onClick={() => { setNodes((prev) => prev.filter((n) => n.id !== selectedNode)); setSelectedNode(null); }}
                    className="mt-4 flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px] font-medium"
                    style={{ borderColor: "var(--destructive)", color: "var(--destructive)" }}
                  >
                    <Trash2 size={12} /> Remove Node
                  </button>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
