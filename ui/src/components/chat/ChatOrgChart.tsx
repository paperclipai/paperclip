interface OrgNode {
  id: string;
  name: string;
  role: string;
  status: string;
  reports: OrgNode[];
}

interface ChatOrgChartProps {
  tree: OrgNode | OrgNode[];
  onNavigate: (path: string) => void;
}

const statusDot: Record<string, string> = {
  active: "bg-emerald-500",
  running: "bg-emerald-500",
  idle: "bg-gray-400",
  paused: "bg-gray-400",
  error: "bg-red-500",
  terminated: "bg-amber-500",
};

function OrgNodeRow({ node, depth, isLast }: { node: OrgNode; depth: number; isLast: boolean }) {
  const dot = statusDot[node.status] ?? "bg-gray-400";
  const prefix = depth === 0 ? "" : isLast ? "+-- " : "|-- ";

  return (
    <>
      <div className="flex items-center" style={{ paddingLeft: `${depth * 16}px` }}>
        {depth > 0 && (
          <span className="text-[10px] text-muted-foreground/50 font-mono whitespace-pre">{prefix}</span>
        )}
        <span className={`h-2 w-2 rounded-full shrink-0 ${dot} mr-1.5`} />
        <span className="text-xs font-medium truncate">{node.name}</span>
        <span className="text-[10px] text-muted-foreground ml-1.5 truncate">({node.role})</span>
      </div>
      {depth < 3 &&
        node.reports.map((child, i) => (
          <OrgNodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            isLast={i === node.reports.length - 1}
          />
        ))}
      {depth === 3 && node.reports.length > 0 && (
        <div className="text-[10px] text-muted-foreground" style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
          ... {node.reports.length} more
        </div>
      )}
    </>
  );
}

export function ChatOrgChart({ tree, onNavigate }: ChatOrgChartProps) {
  const roots = Array.isArray(tree) ? tree : [tree];

  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm space-y-1.5">
      <p className="text-xs font-semibold">Org Chart</p>

      <div className="space-y-0.5">
        {roots.map((root, i) => (
          <OrgNodeRow key={root.id} node={root} depth={0} isLast={i === roots.length - 1} />
        ))}
      </div>

      <button
        className="text-xs text-primary hover:underline cursor-pointer"
        onClick={() => onNavigate("agents")}
      >
        View full org chart &rarr;
      </button>
    </div>
  );
}
