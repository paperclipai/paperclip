import { useQuery } from "@tanstack/react-query";
import { Server, Plus, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { api } from "@/api/client";
import type { Node } from "@paperclipai/shared";

function statusColor(status: string) {
  if (status === "online") return "text-green-500";
  if (status === "draining") return "text-yellow-500";
  return "text-muted-foreground";
}

function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

export function Nodes() {
  const { selectedCompanyId: companyId } = useCompany();

  const nodesQuery = useQuery({
    queryKey: ["nodes", companyId],
    queryFn: () => api.get<Node[]>(`/companies/${companyId}/nodes`),
    enabled: !!companyId,
    refetchInterval: 15_000,
  });

  const nodes = nodesQuery.data ?? [];

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Server className="h-5 w-5" />
            Remote Nodes
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Registered compute environments for remote agent execution
          </p>
        </div>
      </div>

      {nodes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <Server className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">No nodes registered yet</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Register a node with: <code className="font-mono bg-muted/30 px-1 rounded">paperclipai node register &lt;name&gt; --company-id {companyId}</code>
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {nodes.map((node) => (
            <div
              key={node.id}
              className="rounded-lg border border-border bg-card p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <Circle className={`h-3 w-3 fill-current ${statusColor(node.status)}`} />
                <div>
                  <div className="font-medium text-sm">{node.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{node.id}</div>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span className={statusColor(node.status)}>{node.status}</span>
                <span>Last seen: {relativeTime(node.lastSeenAt)}</span>
                {Object.keys(node.capabilities).length > 0 && (
                  <span>{Object.keys(node.capabilities).join(", ")}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
