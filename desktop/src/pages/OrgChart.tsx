import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import type { OrgNode } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

const CARD_W = 200;
const CARD_H = 100;
const GAP_X = 32;
const GAP_Y = 80;
const PADDING = 60;

const STATUS_COLORS: Record<string, string> = {
  running: "var(--success)",
  active: "var(--success)",
  idle: "var(--warning)",
  paused: "var(--warning)",
  error: "var(--destructive)",
  terminated: "var(--fg-muted)",
};

const ROLE_COLORS: Record<string, string> = {
  ceo: "#5A78BE",
  manager: "#5AA87E",
  specialist: "#C4954A",
  general: "#7A8B9A",
  contractor: "#B45A8E",
};

interface LayoutNode {
  node: OrgNode;
  x: number;
  y: number;
  children: LayoutNode[];
}

function computeSubtreeWidth(node: OrgNode): number {
  if (node.children.length === 0) return CARD_W;
  const childrenWidth = node.children.reduce((sum, child, i) => {
    return sum + computeSubtreeWidth(child) + (i > 0 ? GAP_X : 0);
  }, 0);
  return Math.max(CARD_W, childrenWidth);
}

function layoutTree(node: OrgNode, x: number, y: number): LayoutNode {
  const subtreeWidth = computeSubtreeWidth(node);
  const nodeX = x + subtreeWidth / 2 - CARD_W / 2;

  const childLayouts: LayoutNode[] = [];
  if (node.children.length > 0) {
    const childrenTotalWidth = node.children.reduce((sum, child, i) => {
      return sum + computeSubtreeWidth(child) + (i > 0 ? GAP_X : 0);
    }, 0);

    let childX = x + (subtreeWidth - childrenTotalWidth) / 2;
    const childY = y + CARD_H + GAP_Y;

    for (const child of node.children) {
      const childWidth = computeSubtreeWidth(child);
      childLayouts.push(layoutTree(child, childX, childY));
      childX += childWidth + GAP_X;
    }
  }

  return { node, x: nodeX, y, children: childLayouts };
}

function collectNodes(layout: LayoutNode): LayoutNode[] {
  const result: LayoutNode[] = [layout];
  for (const child of layout.children) {
    result.push(...collectNodes(child));
  }
  return result;
}

function collectEdges(layout: LayoutNode): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const child of layout.children) {
    edges.push({
      x1: layout.x + CARD_W / 2,
      y1: layout.y + CARD_H,
      x2: child.x + CARD_W / 2,
      y2: child.y,
    });
    edges.push(...collectEdges(child));
  }
  return edges;
}

export function OrgChart() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();

  const { data: orgTree = [], isLoading } = useQuery({
    queryKey: queryKeys.agents.orgTree(selectedCompanyId!),
    queryFn: () => agentsApi.getOrgTree(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Build a single virtual root if multiple top-level nodes
  const virtualRoot: OrgNode | null = useMemo(() => {
    if (orgTree.length === 0) return null;
    if (orgTree.length === 1) return orgTree[0];
    return {
      id: "__root__",
      name: "Organization",
      role: "",
      title: null,
      icon: null,
      status: "active",
      adapter_type: "",
      reports_to: null,
      children: orgTree,
    };
  }, [orgTree]);

  const layout = useMemo(() => virtualRoot ? layoutTree(virtualRoot, PADDING, PADDING) : null, [virtualRoot]);
  const nodes = useMemo(() => layout ? collectNodes(layout).filter((n) => n.node.id !== "__root__") : [], [layout]);
  const edges = useMemo(() => layout ? collectEdges(layout) : [], [layout]);

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  if (!virtualRoot) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Organization</h1>
        </div>
        <div className="py-16 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>No agents to display.</div>
      </div>
    );
  }

  const allNodes = layout ? collectNodes(layout) : [];
  const totalWidth = virtualRoot ? computeSubtreeWidth(virtualRoot) + PADDING * 2 : 0;
  const maxY = allNodes.length > 0 ? Math.max(...allNodes.map((n) => n.y)) : 0;
  const totalHeight = maxY + CARD_H + PADDING;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Organization</h1>
      </div>

      <div className="overflow-auto rounded-lg border" style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}>
        <svg width={totalWidth} height={totalHeight} viewBox={`0 0 ${totalWidth} ${totalHeight}`}>
          {/* Connection lines */}
          {edges.map((edge, i) => {
            const midY = (edge.y1 + edge.y2) / 2;
            return (
              <path
                key={i}
                d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${midY}, ${edge.x2} ${midY}, ${edge.x2} ${edge.y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={2}
              />
            );
          })}

          {/* Node cards */}
          {nodes.map((ln) => {
            const color = ROLE_COLORS[ln.node.role.toLowerCase()] || "#7A8B9A";
            return (
              <g
                key={ln.node.id}
                onClick={() => navigate(`/agents/${ln.node.id}`)}
                className="cursor-pointer"
              >
                <rect
                  x={ln.x}
                  y={ln.y}
                  width={CARD_W}
                  height={CARD_H}
                  rx={12}
                  fill="var(--bg)"
                  stroke="var(--border)"
                  strokeWidth={1}
                />
                {/* Initial circle */}
                <circle cx={ln.x + CARD_W / 2} cy={ln.y + 32} r={16} fill={color} opacity={0.15} />
                <text
                  x={ln.x + CARD_W / 2}
                  y={ln.y + 37}
                  textAnchor="middle"
                  fontSize={14}
                  fontWeight={600}
                  fill={color}
                >
                  {ln.node.icon || ln.node.name[0]}
                </text>
                {/* Name */}
                <text
                  x={ln.x + CARD_W / 2}
                  y={ln.y + 62}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={500}
                  fill="var(--fg)"
                >
                  {ln.node.name}
                </text>
                {/* Role */}
                <text
                  x={ln.x + CARD_W / 2}
                  y={ln.y + 78}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--fg-muted)"
                >
                  {ln.node.role}
                </text>
                {/* Status dot */}
                <circle
                  cx={ln.x + CARD_W - 16}
                  cy={ln.y + 16}
                  r={4}
                  fill={STATUS_COLORS[ln.node.status] || "var(--fg-muted)"}
                />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
