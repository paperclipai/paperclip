import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Maximize2 } from "lucide-react";
import { brainApi } from "@/api/brain";
import type { BrainNode, BrainEntityType } from "@/api/brain";
import { queryKeys } from "@/lib/queryKeys";
import { ENTITY_TYPE_COLORS, ALL_ENTITY_TYPES, entityTypeLabel } from "@/lib/brain-utils";
import { EntityTypeBadge } from "./EntityTypeBadge";
import { cn } from "@/lib/utils";

interface BrainGraphExplorerProps {
  companyId: string;
  onSelectEntity?: (slug: string) => void;
}

interface GraphNode extends BrainNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export function BrainGraphExplorer({ companyId, onSelectEntity }: BrainGraphExplorerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [enabledTypes, setEnabledTypes] = useState<Set<BrainEntityType>>(new Set(ALL_ENTITY_TYPES));
  const [searchQuery, setSearchQuery] = useState("");
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const dragRef = useRef<{ active: boolean; lastX: number; lastY: number }>({ active: false, lastX: 0, lastY: 0 });
  const nodesRef = useRef<GraphNode[]>([]);
  const linksRef = useRef<{ source: string; target: string; type: string }[]>([]);
  const animFrameRef = useRef<number>(0);

  const { data: graphData, isLoading } = useQuery({
    queryKey: queryKeys.brain.graph(companyId),
    queryFn: () => brainApi.getGraph(companyId),
    enabled: !!companyId,
  });

  const filteredData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    const nodes = graphData.nodes.filter((n) => enabledTypes.has(n.type));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = graphData.links.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));
    return { nodes, links };
  }, [graphData, enabledTypes]);

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    const q = searchQuery.toLowerCase();
    return new Set(
      filteredData.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q)).map((n) => n.id),
    );
  }, [filteredData.nodes, searchQuery]);

  useEffect(() => {
    const nodes: GraphNode[] = filteredData.nodes.map((n, i) => ({
      ...n,
      x: 400 + Math.cos((i / filteredData.nodes.length) * Math.PI * 2) * 200 + (Math.random() - 0.5) * 40,
      y: 300 + Math.sin((i / filteredData.nodes.length) * Math.PI * 2) * 200 + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
    }));
    nodesRef.current = nodes;
    linksRef.current = filteredData.links;
  }, [filteredData]);

  const nodeRadius = useCallback((n: GraphNode) => Math.max(4, Math.min(16, 4 + n.backlinks * 1.5)), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;
    const nodeMap = new Map<string, GraphNode>();

    function simulate() {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      nodeMap.clear();
      for (const n of nodes) nodeMap.set(n.id, n);

      for (const n of nodes) {
        for (const m of nodes) {
          if (n === m) continue;
          const dx = (n.x ?? 0) - (m.x ?? 0);
          const dy = (n.y ?? 0) - (m.y ?? 0);
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = 800 / (dist * dist);
          n.vx = (n.vx ?? 0) + (dx / dist) * force;
          n.vy = (n.vy ?? 0) + (dy / dist) * force;
        }
      }

      for (const link of links) {
        const source = nodeMap.get(link.source);
        const target = nodeMap.get(link.target);
        if (!source || !target) continue;
        const dx = (target.x ?? 0) - (source.x ?? 0);
        const dy = (target.y ?? 0) - (source.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = (dist - 120) * 0.005;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        source.vx = (source.vx ?? 0) + fx;
        source.vy = (source.vy ?? 0) + fy;
        target.vx = (target.vx ?? 0) - fx;
        target.vy = (target.vy ?? 0) - fy;
      }

      for (const n of nodes) {
        n.vx = (n.vx ?? 0) * 0.85;
        n.vy = (n.vy ?? 0) * 0.85;
        n.x = (n.x ?? 0) + (n.vx ?? 0);
        n.y = (n.y ?? 0) + (n.vy ?? 0);
      }
    }

    function draw() {
      if (!running || !ctx || !canvas) return;
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const nodeMap = new Map<string, GraphNode>();
      for (const n of nodes) nodeMap.set(n.id, n);

      simulate();

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(offsetRef.current.x + w / 2, offsetRef.current.y + h / 2);
      ctx.scale(scaleRef.current, scaleRef.current);
      ctx.translate(-w / 2, -h / 2);

      ctx.lineWidth = 0.5;
      ctx.strokeStyle = "rgba(100,100,100,0.2)";
      for (const link of links) {
        const s = nodeMap.get(link.source);
        const t = nodeMap.get(link.target);
        if (!s || !t) continue;
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.stroke();
      }

      for (const n of nodes) {
        const r = nodeRadius(n);
        const isHovered = hoveredNode?.id === n.id;
        const isSelected = selectedNode?.id === n.id;
        const isMatch = searchMatches.size > 0 && searchMatches.has(n.id);
        const dimmed = searchMatches.size > 0 && !isMatch;

        ctx.beginPath();
        ctx.arc(n.x ?? 0, n.y ?? 0, isHovered || isSelected ? r + 2 : r, 0, Math.PI * 2);
        ctx.fillStyle = dimmed ? "rgba(100,100,100,0.15)" : (ENTITY_TYPE_COLORS[n.type] ?? "#6b7280");
        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.fill();

        if (isSelected || isHovered) {
          ctx.strokeStyle = isSelected ? "#fff" : "rgba(255,255,255,0.6)";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.globalAlpha = dimmed ? 0.2 : 1;
        ctx.fillStyle = dimmed ? "rgba(100,100,100,0.3)" : "rgba(255,255,255,0.9)";
        ctx.font = `${Math.max(9, r)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(n.name.length > 18 ? n.name.slice(0, 16) + ".." : n.name, n.x ?? 0, (n.y ?? 0) + r + 12);
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(draw);
    }

    animFrameRef.current = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [filteredData, hoveredNode, selectedNode, searchMatches, nodeRadius]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const observer = new ResizeObserver(() => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    });
    observer.observe(container);
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    return () => observer.disconnect();
  }, []);

  const findNodeAt = useCallback(
    (cx: number, cy: number): GraphNode | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const w = canvas.width;
      const h = canvas.height;
      const ox = offsetRef.current.x;
      const oy = offsetRef.current.y;
      const s = scaleRef.current;
      const worldX = (cx - w / 2 - ox) / s + w / 2;
      const worldY = (cy - h / 2 - oy) / s + h / 2;

      for (const n of nodesRef.current) {
        const r = nodeRadius(n) + 4;
        const dx = (n.x ?? 0) - worldX;
        const dy = (n.y ?? 0) - worldY;
        if (dx * dx + dy * dy < r * r) return n;
      }
      return null;
    },
    [nodeRadius],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (dragRef.current.active) {
        offsetRef.current.x += e.clientX - dragRef.current.lastX;
        offsetRef.current.y += e.clientY - dragRef.current.lastY;
        dragRef.current.lastX = e.clientX;
        dragRef.current.lastY = e.clientY;
        return;
      }

      const node = findNodeAt(cx, cy);
      setHoveredNode(node);
      if (canvasRef.current) canvasRef.current.style.cursor = node ? "pointer" : "grab";
    },
    [findNodeAt],
  );

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
  }, []);

  const handleMouseUp = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const wasDrag = dragRef.current.active && (Math.abs(e.clientX - dragRef.current.lastX) > 3 || Math.abs(e.clientY - dragRef.current.lastY) > 3);
      dragRef.current.active = false;

      if (!wasDrag) {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const node = findNodeAt(e.clientX - rect.left, e.clientY - rect.top);
        setSelectedNode(node);
        if (node) onSelectEntity?.(node.slug);
      }
    },
    [findNodeAt, onSelectEntity],
  );

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    scaleRef.current = Math.max(0.2, Math.min(5, scaleRef.current * delta));
  }, []);

  const fitToScreen = useCallback(() => {
    offsetRef.current = { x: 0, y: 0 };
    scaleRef.current = 1;
  }, []);

  const toggleType = useCallback((type: BrainEntityType) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-sm text-muted-foreground">Loading brain graph...</p>
      </div>
    );
  }

  const totalNodes = filteredData.nodes.length;
  const totalLinks = filteredData.links.length;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Find entity..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <button onClick={fitToScreen} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors" title="Fit to screen">
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 relative bg-background">
        <canvas
          ref={canvasRef}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          className="w-full h-full"
        />
        {hoveredNode && !dragRef.current.active && (
          <div className="absolute top-2 right-2 bg-card border border-border rounded-md px-3 py-2 shadow-md pointer-events-none">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{hoveredNode.name}</span>
              <EntityTypeBadge type={hoveredNode.type} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{hoveredNode.backlinks} backlinks</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-xs text-muted-foreground shrink-0 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {ALL_ENTITY_TYPES.map((type) => (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
                enabledTypes.has(type)
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground/50 line-through",
              )}
            >
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: ENTITY_TYPE_COLORS[type] }} />
              {entityTypeLabel(type)}
            </button>
          ))}
        </div>
        <span className="ml-auto tabular-nums">{totalNodes} nodes &middot; {totalLinks} links</span>
      </div>
    </div>
  );
}
