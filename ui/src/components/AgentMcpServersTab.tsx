import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentMcpServerBindingDetail, McpServer } from "@paperclipai/shared";
import { CheckCircle2, PlugZap, RefreshCcw, Server, Unplug } from "lucide-react";
import { mcpServersApi } from "@/api/mcpServers";
import { queryKeys } from "@/lib/queryKeys";
import { useToastActions } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function byServerId(bindings: AgentMcpServerBindingDetail[]) {
  return new Map(bindings.map((binding) => [binding.server.id, binding]));
}

function healthTone(status: McpServer["lastHealthStatus"]) {
  switch (status) {
    case "healthy":
      return "default";
    case "error":
      return "destructive";
    case "degraded":
      return "secondary";
    default:
      return "outline";
  }
}

export function AgentMcpServersTab({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const serversQuery = useQuery({
    queryKey: queryKeys.mcpServers.list(companyId),
    queryFn: () => mcpServersApi.list(companyId),
  });

  const bindingsQuery = useQuery({
    queryKey: queryKeys.mcpServers.agentBindings(agentId),
    queryFn: () => mcpServersApi.listAgentBindings(agentId, companyId),
  });

  const bindingsMap = useMemo(
    () => byServerId(bindingsQuery.data ?? []),
    [bindingsQuery.data],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.agentBindings(agentId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
  };

  const bindMutation = useMutation({
    mutationFn: (serverId: string) =>
      mcpServersApi.bindToAgent(agentId, { mcpServerId: serverId, bindingMode: "allowed", enabled: true }, companyId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "MCP server attached to agent", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to attach MCP server",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const updateBindingMutation = useMutation({
    mutationFn: ({
      serverId,
      data,
    }: {
      serverId: string;
      data: { bindingMode?: "allowed" | "preferred" | "required"; enabled?: boolean; allowedTools?: string[] };
    }) => mcpServersApi.updateAgentBinding(agentId, serverId, data, companyId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Agent MCP binding updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update binding",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const unbindMutation = useMutation({
    mutationFn: (serverId: string) => mcpServersApi.removeAgentBinding(agentId, serverId, companyId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "MCP server detached from agent", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to detach MCP server",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (serverId: string) => mcpServersApi.test(serverId, {}),
    onSuccess: (result) => {
      invalidate();
      pushToast({
        title: result.ok ? "MCP discovery refreshed" : "MCP discovery failed",
        body: result.snapshot.summary ?? result.snapshot.error ?? undefined,
        tone: result.ok ? "success" : "error",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to test MCP server",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (serversQuery.isLoading || bindingsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading MCP servers...</div>;
  }

  const servers = serversQuery.data ?? [];
  if (servers.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
        This company has no registered MCP servers yet. Add one in Company Settings first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">MCP Servers</h2>
          <p className="text-sm text-muted-foreground">
            Choose which registered MCP servers this agent may use during runs.
          </p>
        </div>
      </div>

      <div className="grid gap-4">
        {servers.map((server) => {
          const binding = bindingsMap.get(server.id) ?? null;
          const snapshot = binding?.latestSnapshot ?? null;
          return (
            <Card key={server.id} className="gap-4 py-5">
              <CardHeader className="px-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      {server.name}
                    </CardTitle>
                    <CardDescription className="mt-1">
                      <span className="font-mono text-xs">{server.slug}</span>
                      <span className="mx-2">·</span>
                      <span>{server.transport}</span>
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={healthTone(server.lastHealthStatus)}>{server.lastHealthStatus}</Badge>
                    {binding ? (
                      <Badge variant="outline">bound</Badge>
                    ) : (
                      <Badge variant="secondary">not bound</Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 px-5">
                {server.description ? (
                  <p className="text-sm text-muted-foreground">{server.description}</p>
                ) : null}

                <div className="grid gap-3 md:grid-cols-[1.3fr_0.9fr]">
                  <div className="rounded-md border border-border/70 bg-background/60 p-3 text-xs">
                    <div className="font-medium text-foreground">Catalog</div>
                    <div className="mt-2 text-muted-foreground">
                      {snapshot ? (
                        <>
                          <div>{snapshot.summary ?? snapshot.error ?? "No summary available."}</div>
                          <div className="mt-1">
                            {snapshot.tools.length} tools · {snapshot.resources.length} resources · {snapshot.prompts.length} prompts
                          </div>
                        </>
                      ) : (
                        <div>No discovery snapshot yet.</div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
                    <div className="font-medium text-foreground">Binding</div>
                    {binding ? (
                      <div className="mt-2 space-y-3">
                        <label className="grid gap-1">
                          <span className="text-muted-foreground">Mode</span>
                          <select
                            value={binding.bindingMode}
                            onChange={(event) =>
                              updateBindingMutation.mutate({
                                serverId: server.id,
                                data: { bindingMode: event.target.value as "allowed" | "preferred" | "required" },
                              })}
                            className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                          >
                            <option value="allowed">allowed</option>
                            <option value="preferred">preferred</option>
                            <option value="required">required</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={binding.enabled}
                            onChange={(event) =>
                              updateBindingMutation.mutate({
                                serverId: server.id,
                                data: { enabled: event.target.checked },
                              })}
                          />
                          <span>Enabled for this agent</span>
                        </label>
                        {snapshot && snapshot.tools.length > 0 ? (
                          <div className="grid gap-1">
                            <span className="text-muted-foreground">
                              Tools{" "}
                              {binding.allowedTools.length === 0
                                ? "(all allowed)"
                                : `(${binding.allowedTools.length} of ${snapshot.tools.length} allowed)`}
                            </span>
                            <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border/60 bg-background/60 p-2">
                              {snapshot.tools.map((tool) => {
                                const allowed =
                                  binding.allowedTools.length === 0 ||
                                  binding.allowedTools.includes(tool.name);
                                return (
                                  <label key={tool.name} className="flex items-center gap-2 text-sm">
                                    <input
                                      type="checkbox"
                                      checked={allowed}
                                      onChange={(event) => {
                                        const allNames = snapshot.tools.map((t) => t.name);
                                        const current =
                                          binding.allowedTools.length === 0
                                            ? [...allNames]
                                            : [...binding.allowedTools];
                                        const nextSet = event.target.checked
                                          ? Array.from(new Set([...current, tool.name]))
                                          : current.filter((name) => name !== tool.name);
                                        // Canonicalize "all selected" back to [] (backend reads empty as no restriction).
                                        const data =
                                          nextSet.length === allNames.length ? [] : nextSet;
                                        updateBindingMutation.mutate({
                                          serverId: server.id,
                                          data: { allowedTools: data },
                                        });
                                      }}
                                    />
                                    <span className="font-mono text-[11px]">{tool.name}</span>
                                  </label>
                                );
                              })}
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                              No restriction (all boxes checked) exposes every tool. Uncheck to limit
                              which tools this agent may call.
                            </span>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-2 text-muted-foreground">
                        Attach this server if the agent should be able to call its MCP tools.
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {binding ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        onClick={() => testMutation.mutate(server.id)}
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
                        Refresh Discovery
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 text-destructive hover:text-destructive"
                        onClick={() => unbindMutation.mutate(server.id)}
                      >
                        <Unplug className="h-3.5 w-3.5" />
                        Detach
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" className="gap-2" onClick={() => bindMutation.mutate(server.id)}>
                      <PlugZap className="h-3.5 w-3.5" />
                      Attach to Agent
                    </Button>
                  )}
                  {snapshot?.status === "succeeded" ? (
                    <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Ready for tool exposure
                    </span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
