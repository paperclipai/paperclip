import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { AGENT_ROLE_LABELS, type Agent } from "@paperclipai/shared";
import {
  AlertTriangle,
  Building2,
  Coffee,
  DoorOpen,
  Search,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { agentsApi, type OrgNode } from "../api/agents";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { agentUrl } from "../lib/utils";

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

const statusColors: Record<string, string> = {
  running: "#22d3ee",
  active: "#4ade80",
  paused: "#fbbf24",
  idle: "#f97316",
  pending_approval: "#fb7185",
  error: "#ef4444",
  terminated: "#94a3b8",
};

const ROOM_PADDING_X = 18;
const ROOM_PADDING_Y = 18;
const ROOM_HEADER_HEIGHT = 62;
const CARD_WIDTH = 188;
const CARD_HEIGHT = 110;
const CARD_GAP_X = 14;
const CARD_GAP_Y = 14;
const ROOM_MIN_WIDTH = 360;
const ROOM_MIN_HEIGHT = 248;
const OFFICE_COLUMNS = 2;
const OFFICE_ROOM_GAP_X = 56;
const OFFICE_ROOM_GAP_Y = 48;

interface OfficeZone {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  statuses: string[];
  icon: LucideIcon;
}

interface OfficeZoneSummary extends OfficeZone {
  agents: Agent[];
}

interface FlatAgent {
  id: string;
  name: string;
  role: string;
  status: string;
  depth: number;
  parentId: string | null;
  teamSize: number;
}

interface RoomData extends Record<string, unknown> {
  title: string;
  subtitle: string;
  accentColor: string;
  count: number;
}

interface AgentData extends Record<string, unknown> {
  name: string;
  initial: string;
  title: string;
  role: string;
  status: string;
  statusColor: string;
  teamSize: number;
  roomTitle: string;
}

type OrgFlowNode = Node<RoomData, "room"> | Node<AgentData, "agent">;
type OrgFlowEdge = Edge;

const officeZones: OfficeZone[] = [
  {
    id: "workspace",
    title: "Workspace",
    subtitle: "Shipping and active execution",
    accent: "#38bdf8",
    statuses: ["running", "active"],
    icon: TerminalSquare,
  },
  {
    id: "breakroom",
    title: "Breakroom",
    subtitle: "Idle or paused agents",
    accent: "#f97316",
    statuses: ["idle", "paused"],
    icon: Coffee,
  },
  {
    id: "bug-corner",
    title: "Bug Corner",
    subtitle: "Needs immediate support",
    accent: "#ef4444",
    statuses: ["error"],
    icon: AlertTriangle,
  },
  {
    id: "control-desk",
    title: "Control Desk",
    subtitle: "Approval or lifecycle state",
    accent: "#a78bfa",
    statuses: ["pending_approval", "terminated"],
    icon: Building2,
  },
];

const zoneByStatus = officeZones.reduce<Record<string, string>>((acc, zone) => {
  for (const status of zone.statuses) {
    acc[status] = zone.id;
  }
  return acc;
}, {});

function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}

function isAgentNode(node: OrgFlowNode): node is Node<AgentData, "agent"> {
  return node.type === "agent";
}

function flattenOrgTree(roots: OrgNode[]): FlatAgent[] {
  const flattened: FlatAgent[] = [];

  const visit = (node: OrgNode, depth: number, parentId: string | null): number => {
    const entry: FlatAgent = {
      id: node.id,
      name: node.name,
      role: node.role,
      status: node.status,
      depth,
      parentId,
      teamSize: 1,
    };
    flattened.push(entry);

    let subtreeSize = 1;
    for (const report of node.reports) {
      subtreeSize += visit(report, depth + 1, node.id);
    }

    entry.teamSize = subtreeSize;
    return subtreeSize;
  };

  for (const root of roots) {
    visit(root, 0, null);
  }

  return flattened;
}

function buildRoomLayout(orgTree: OrgNode[], agentMap: Map<string, Agent>) {
  const flattened = flattenOrgTree(orgTree);
  const zoneAgents = new Map<string, FlatAgent[]>(officeZones.map((zone) => [zone.id, []]));

  for (const agent of flattened) {
    const zoneId = zoneByStatus[agent.status] ?? "control-desk";
    const bucket = zoneAgents.get(zoneId);
    if (bucket) bucket.push(agent);
  }

  const roomDrafts = officeZones.map((zone, index) => {
    const agentsInZone = [...(zoneAgents.get(zone.id) ?? [])].sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.name.localeCompare(b.name);
    });
    const columns = agentsInZone.length >= 7 ? 3 : agentsInZone.length >= 3 ? 2 : 1;
    const rows = Math.max(1, Math.ceil(agentsInZone.length / columns));
    const width = Math.max(
      ROOM_MIN_WIDTH,
      ROOM_PADDING_X * 2 + columns * CARD_WIDTH + (columns - 1) * CARD_GAP_X,
    );
    const height = Math.max(
      ROOM_MIN_HEIGHT,
      ROOM_HEADER_HEIGHT + ROOM_PADDING_Y * 2 + rows * CARD_HEIGHT + (rows - 1) * CARD_GAP_Y,
    );

    return {
      zone,
      agents: agentsInZone,
      columns,
      rows,
      width,
      height,
      col: index % OFFICE_COLUMNS,
      row: Math.floor(index / OFFICE_COLUMNS),
    };
  });

  const rowCount = Math.ceil(roomDrafts.length / OFFICE_COLUMNS);
  const colWidths = Array.from({ length: OFFICE_COLUMNS }, (_, col) =>
    roomDrafts
      .filter((draft) => draft.col === col)
      .reduce((max, draft) => Math.max(max, draft.width), ROOM_MIN_WIDTH),
  );
  const rowHeights = Array.from({ length: rowCount }, (_, row) =>
    roomDrafts
      .filter((draft) => draft.row === row)
      .reduce((max, draft) => Math.max(max, draft.height), ROOM_MIN_HEIGHT),
  );

  const colOffsets = colWidths.map((_, index) =>
    colWidths.slice(0, index).reduce((sum, width) => sum + width + OFFICE_ROOM_GAP_X, 0),
  );
  const rowOffsets = rowHeights.map((_, index) =>
    rowHeights.slice(0, index).reduce((sum, height) => sum + height + OFFICE_ROOM_GAP_Y, 0),
  );

  const nodes: OrgFlowNode[] = [];
  const edges: OrgFlowEdge[] = [];

  for (const draft of roomDrafts) {
    const roomId = `room-${draft.zone.id}`;
    const roomX = colOffsets[draft.col] ?? 0;
    const roomY = rowOffsets[draft.row] ?? 0;

    nodes.push({
      id: roomId,
      type: "room",
      position: { x: roomX, y: roomY },
      draggable: false,
      selectable: false,
      data: {
        title: draft.zone.title,
        subtitle: draft.zone.subtitle,
        count: draft.agents.length,
        accentColor: draft.zone.accent,
      },
      style: {
        width: draft.width,
        height: draft.height,
        border: "none",
        background: "transparent",
      },
      zIndex: 0,
    });

    draft.agents.forEach((agent, index) => {
      const col = index % draft.columns;
      const row = Math.floor(index / draft.columns);
      const agentDetail = agentMap.get(agent.id);
      const statusColor = statusColors[agent.status] ?? "#94a3b8";

      nodes.push({
        id: agent.id,
        type: "agent",
        parentId: roomId,
        extent: "parent",
        position: {
          x: ROOM_PADDING_X + col * (CARD_WIDTH + CARD_GAP_X),
          y: ROOM_HEADER_HEIGHT + ROOM_PADDING_Y + row * (CARD_HEIGHT + CARD_GAP_Y),
        },
        draggable: false,
        data: {
          name: agent.name,
          initial: agent.name.trim().charAt(0).toUpperCase() || "?",
          title: agentDetail?.title ?? roleLabel(agent.role),
          role: roleLabel(agent.role),
          status: agent.status,
          statusColor,
          teamSize: agent.teamSize,
          roomTitle: draft.zone.title,
        },
        style: {
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          border: "none",
          background: "transparent",
        },
        zIndex: 5,
      });

      if (agent.parentId) {
        const isAnimated = agent.status === "running" || agent.status === "active";
        edges.push({
          id: `edge-${agent.parentId}-${agent.id}`,
          source: agent.parentId,
          target: agent.id,
          type: "step",
          animated: isAnimated,
          style: {
            stroke: isAnimated ? "#7dd3fc" : "#5b7b95",
            strokeWidth: 2.2,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isAnimated ? "#7dd3fc" : "#5b7b95",
          },
        });
      }
    });
  }

  return { nodes, edges };
}

function RoomNodeCard({ data }: NodeProps<Node<RoomData, "room">>) {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-md border-2 border-[#2f4f68] bg-[#0c1d2d] shadow-[0_16px_36px_rgba(2,6,23,0.5)]">
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          background:
            "linear-gradient(0deg, rgba(12,29,45,0.35), rgba(12,29,45,0.35)), repeating-linear-gradient(0deg, transparent 0 16px, rgba(29,78,116,0.16) 16px 17px), repeating-linear-gradient(90deg, transparent 0 16px, rgba(29,78,116,0.14) 16px 17px)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-1"
        style={{ backgroundColor: data.accentColor }}
      />
      <div className="relative flex items-start justify-between px-4 pt-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-slate-300/80">{data.subtitle}</p>
          <h3 className="mt-1 font-mono text-sm font-semibold text-slate-100">{data.title}</h3>
        </div>
        <div className="rounded-sm border border-slate-400/40 bg-slate-950/75 px-2 py-1 font-mono text-[11px] text-slate-200">
          {data.count} agents
        </div>
      </div>
    </div>
  );
}

function AgentNodeCard({ data, selected }: NodeProps<Node<AgentData, "agent">>) {
  return (
    <div
      className="relative h-full w-full rounded-[6px] border-2 p-3 text-slate-100 shadow-[0_10px_24px_rgba(2,6,23,0.4)] transition-transform"
      style={{
        borderColor: selected ? data.statusColor : "#32526d",
        background:
          "linear-gradient(180deg, rgba(12,29,45,0.92), rgba(10,24,36,0.95)), repeating-linear-gradient(0deg, transparent 0 7px, rgba(148,163,184,0.06) 7px 8px)",
        transform: selected ? "translateY(-2px)" : "translateY(0)",
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-slate-100"
        style={{ left: -6 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-slate-100"
        style={{ right: -6 }}
      />

      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-sm border border-slate-300/45 bg-slate-900/80 font-mono text-[10px] font-semibold text-slate-100">
          {data.initial}
        </span>
        <span className="truncate text-[10px] uppercase tracking-[0.2em] text-slate-300/85">{data.roomTitle}</span>
      </div>

      <p className="mt-2 truncate font-mono text-sm font-semibold">{data.name}</p>
      <p className="truncate text-xs text-slate-300">{data.title}</p>

      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-300">
        <span className="truncate">{data.role}</span>
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: data.statusColor }}
          />
          {data.status}
        </span>
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  room: RoomNodeCard,
  agent: AgentNodeCard,
};

export function OrgChart() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const { data: orgTree, isLoading } = useQuery({
    queryKey: queryKeys.org(selectedCompanyId!),
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Org Chart" }]);
  }, [setBreadcrumbs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const agent of agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [agents]);

  const flow = useMemo(() => buildRoomLayout(orgTree ?? [], agentMap), [orgTree, agentMap]);

  const [nodes, setNodes, onNodesChange] = useNodesState<OrgFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<OrgFlowEdge>([]);

  useEffect(() => {
    setNodes(flow.nodes);
    setEdges(flow.edges);
  }, [flow, setNodes, setEdges]);

  useEffect(() => {
    if (!selectedAgentId) return;
    const stillExists = nodes.some((node) => node.id === selectedAgentId && node.type === "agent");
    if (!stillExists) {
      setSelectedAgentId(null);
    }
  }, [nodes, selectedAgentId]);

  const selectedAgentNode = useMemo(() => {
    if (!selectedAgentId) return null;
    const match = nodes.find((node) => node.id === selectedAgentId);
    return match && isAgentNode(match) ? match : null;
  }, [nodes, selectedAgentId]);

  const selectedAgent = useMemo(
    () => (selectedAgentId ? agentMap.get(selectedAgentId) ?? null : null),
    [agentMap, selectedAgentId],
  );

  const zoneSummaries = useMemo<OfficeZoneSummary[]>(() => {
    const zoneMap = new Map(
      officeZones.map((zone) => [
        zone.id,
        {
          ...zone,
          agents: [] as Agent[],
        },
      ]),
    );

    for (const agent of agents ?? []) {
      const zoneId = zoneByStatus[agent.status] ?? "control-desk";
      const zone = zoneMap.get(zoneId);
      if (zone) {
        zone.agents.push(agent);
      }
    }

    return officeZones.map((zone) => {
      const summary = zoneMap.get(zone.id);
      return summary
        ? {
            ...summary,
            agents: [...summary.agents].sort((a, b) => a.name.localeCompare(b.name)),
          }
        : { ...zone, agents: [] };
    });
  }, [agents]);

  const openAgent = useCallback(
    (agentId: string) => {
      const agent = agentMap.get(agentId);
      navigate(agent ? agentUrl(agent) : `/agents/${agentId}`);
    },
    [agentMap, navigate],
  );

  const activeCount = useMemo(
    () => (agents ?? []).filter((agent) => agent.status === "running" || agent.status === "active").length,
    [agents],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={DoorOpen} message="Select a company to open the Star Office org page." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="org-chart" />;
  }

  if (orgTree && orgTree.length === 0) {
    return <EmptyState icon={DoorOpen} message="No organizational hierarchy defined." />;
  }

  return (
    <div className="grid gap-3 xl:h-[calc(100vh-4rem)] xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="relative h-[60vh] min-h-[430px] overflow-hidden rounded-xl border border-[#2a455d] bg-[#040d16] xl:h-full">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_12%,rgba(56,189,248,0.22),transparent_32%),radial-gradient(circle_at_85%_86%,rgba(249,115,22,0.20),transparent_30%)]" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(0deg,transparent_0_23px,rgba(40,70,95,0.27)_23px_24px),linear-gradient(90deg,transparent_0_23px,rgba(40,70,95,0.25)_23px_24px)] [background-size:24px_24px]" />

        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-md border border-slate-300/20 bg-slate-950/65 px-3 py-2 text-xs text-slate-200 backdrop-blur">
          <p className="flex items-center gap-1.5 font-mono tracking-wide">
            <Sparkles className="h-3.5 w-3.5 text-sky-300" />
            Star Office Org
          </p>
          <p className="mt-0.5 text-[11px] text-slate-300/80">Status-inspired room map for your hierarchy</p>
        </div>

        <ReactFlow<OrgFlowNode, OrgFlowEdge>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18, includeHiddenNodes: false }}
          minZoom={0.36}
          maxZoom={1.75}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
          className="[&_.react-flow__attribution]:hidden"
          onPaneClick={() => setSelectedAgentId(null)}
          onNodeClick={(_, node) => {
            if (node.type === "agent") {
              setSelectedAgentId(node.id);
            }
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.type === "agent") {
              openAgent(node.id);
            }
          }}
        >
          <Background color="#1f3d56" gap={24} size={1} />
          <MiniMap
            pannable
            zoomable
            nodeBorderRadius={4}
            nodeColor={(node) => (node.type === "room" ? "#11324d" : "#071c2d")}
            maskColor="rgba(3,10,17,0.72)"
            className="!rounded-md !border !border-slate-300/25 !bg-slate-950/80"
          />
          <Controls showInteractive={false} className="!border-slate-300/25 !bg-slate-950/80" />
        </ReactFlow>
      </section>

      <aside className="flex min-h-[320px] flex-col overflow-hidden rounded-xl border border-[#2a455d] bg-[#07111c] text-slate-100 xl:h-full">
        <div className="border-b border-[#2a455d] px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-slate-300/80">Office Pulse</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="rounded-md border border-slate-300/20 bg-[#0d1c2b] px-3 py-2">
              <p className="text-[11px] text-slate-300/75">Active now</p>
              <p className="mt-1 font-mono text-lg font-semibold">{activeCount}</p>
            </div>
            <div className="rounded-md border border-slate-300/20 bg-[#0d1c2b] px-3 py-2">
              <p className="text-[11px] text-slate-300/75">Total agents</p>
              <p className="mt-1 font-mono text-lg font-semibold">{agents?.length ?? 0}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          {zoneSummaries.map((zone) => {
            const Icon = zone.icon;
            return (
              <div key={zone.id} className="rounded-md border border-slate-300/20 bg-[#0c1b2a] p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-sm"
                      style={{ backgroundColor: `${zone.accent}26`, color: zone.accent }}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div>
                      <p className="font-mono text-sm font-semibold">{zone.title}</p>
                      <p className="text-[11px] text-slate-300/75">{zone.subtitle}</p>
                    </div>
                  </div>
                  <span className="rounded-sm border border-slate-300/25 px-1.5 py-0.5 font-mono text-xs">
                    {zone.agents.length}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {zone.agents.length === 0 && (
                    <span className="rounded-sm border border-slate-300/20 bg-slate-900/50 px-2 py-0.5 text-[11px] text-slate-400">
                      no agents
                    </span>
                  )}
                  {zone.agents.slice(0, 6).map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      className="rounded-sm border border-slate-300/25 bg-[#13283b] px-2 py-0.5 text-[11px] text-slate-100 transition-colors hover:bg-[#1a344c]"
                      onClick={() => {
                        setSelectedAgentId(agent.id);
                        openAgent(agent.id);
                      }}
                    >
                      {agent.name}
                    </button>
                  ))}
                  {zone.agents.length > 6 && (
                    <span className="rounded-sm border border-slate-300/20 bg-slate-900/50 px-2 py-0.5 text-[11px] text-slate-300">
                      +{zone.agents.length - 6} more
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          <div className="rounded-md border border-slate-300/20 bg-[#0c1b2a] p-3">
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-300/80">Selected Agent</p>
            {selectedAgentNode ? (
              <>
                <p className="mt-2 font-mono text-base font-semibold text-slate-100">{selectedAgentNode.data.name}</p>
                <p className="text-xs text-slate-300">{selectedAgentNode.data.title}</p>
                <div className="mt-3 space-y-1 text-[11px] text-slate-300">
                  <p className="flex items-center gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: selectedAgentNode.data.statusColor }}
                    />
                    Status: {selectedAgentNode.data.status}
                  </p>
                  <p>Room: {selectedAgentNode.data.roomTitle}</p>
                  <p>Team size: {selectedAgentNode.data.teamSize}</p>
                </div>
                <button
                  type="button"
                  onClick={() => openAgent(selectedAgentNode.id)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-sm border border-slate-300/25 px-2.5 py-1 text-xs text-slate-100 transition-colors hover:bg-slate-100/10"
                >
                  <Search className="h-3.5 w-3.5" />
                  Open agent profile
                </button>
                {!selectedAgent && (
                  <p className="mt-2 text-[11px] text-slate-400">Profile metadata unavailable. Opening raw agent page.</p>
                )}
              </>
            ) : (
              <p className="mt-2 text-xs text-slate-400">Click an agent card in the map to inspect details.</p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
