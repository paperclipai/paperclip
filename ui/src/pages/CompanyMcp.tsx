import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompanyMcpServerListItem,
  CompanyMcpServerUsageAgent,
  McpServerConfig,
  McpServersConfig,
} from "@paperclipai/shared";
import { companyMcpApi } from "../api/companyMcp";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { diffMcpServerRecords, toCatalogServerWrite } from "../lib/company-mcp-diff";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { McpServersEditor } from "../components/McpServersEditor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plug } from "lucide-react";

interface RemoveConflict {
  serverId: string;
  name: string;
  usedByAgents: CompanyMcpServerUsageAgent[];
}

export function CompanyMcp() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<McpServersConfig | null>(null);
  const [pendingOps, setPendingOps] = useState(0);
  const [removeConflict, setRemoveConflict] = useState<RemoveConflict | null>(null);
  const draftRef = useRef<McpServersConfig | null>(null);
  const pendingOpsRef = useRef(0);
  const opChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    setBreadcrumbs([{ label: "MCP" }]);
  }, [setBreadcrumbs]);

  const serversQuery = useQuery({
    queryKey: queryKeys.companyMcpServers.list(selectedCompanyId ?? ""),
    queryFn: () => companyMcpApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: secrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const forceRemove = useMutation({
    mutationFn: (serverId: string) =>
      companyMcpApi.remove(selectedCompanyId!, serverId, { force: true }),
    onSuccess: async () => {
      const removedName = removeConflict?.name;
      setRemoveConflict(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companyMcpServers.list(selectedCompanyId!),
      });
      pushToast({
        tone: "success",
        title: "MCP server removed",
        body: removedName
          ? `${removedName} was removed and detached from its agents.`
          : "The server was removed and detached from its agents.",
      });
    },
    onError: (error) => {
      pushToast({
        tone: "error",
        title: "Remove failed",
        body: error instanceof Error ? error.message : "Failed to remove MCP server.",
      });
    },
  });

  /**
   * Editor value: sanitized configs from the catalog keyed by name, with the
   * row-level `enabled` column folded into config.enabled so the editor's
   * toggle reflects it.
   */
  const serverRecord = useMemo<McpServersConfig>(() => {
    const record: McpServersConfig = {};
    for (const item of serversQuery.data ?? []) {
      record[item.name] = { ...item.config, enabled: item.enabled };
    }
    return record;
  }, [serversQuery.data]);

  const serverByName = useMemo(
    () => new Map((serversQuery.data ?? []).map((item) => [item.name, item])),
    [serversQuery.data],
  );

  // Drop the optimistic draft once server truth catches up and nothing is in
  // flight: the post-batch invalidation refetches the list, which lands here.
  useEffect(() => {
    if (pendingOpsRef.current === 0) {
      draftRef.current = null;
      setDraft(null);
    }
  }, [serverRecord]);

  function bumpPending(delta: number) {
    pendingOpsRef.current += delta;
    setPendingOps(pendingOpsRef.current);
    return pendingOpsRef.current;
  }

  /**
   * Serialize catalog mutations (and OAuth starts) through one promise chain:
   * "Save & connect" fires an editor change and an OAuth start back to back,
   * and the OAuth lookup must see the freshly created row. The list is
   * invalidated once, after the last queued op settles.
   */
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const companyId = selectedCompanyId;
    bumpPending(1);
    const started = opChainRef.current.then(run, run);
    opChainRef.current = started
      .then(
        () => undefined,
        () => undefined,
      )
      .then(async () => {
        if (bumpPending(-1) === 0 && companyId) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.companyMcpServers.list(companyId),
          });
        }
      });
    return started;
  }

  async function resolveServerRow(name: string): Promise<CompanyMcpServerListItem | null> {
    const cached = serverByName.get(name);
    if (cached) return cached;
    // Rows created earlier in the same op chain are not in the cache yet.
    const rows = await companyMcpApi.list(selectedCompanyId!);
    return rows.find((row) => row.name === name) ?? null;
  }

  function handleEditorChange(next: McpServersConfig | undefined) {
    if (!selectedCompanyId) return;
    const companyId = selectedCompanyId;
    const nextRecord = next ?? {};
    const prevRecord = draftRef.current ?? serverRecord;
    draftRef.current = nextRecord;
    setDraft(nextRecord);

    const diff = diffMcpServerRecords(prevRecord, nextRecord);
    if (diff.added.length === 0 && diff.changed.length === 0 && diff.removed.length === 0) return;

    void enqueue(async () => {
      try {
        for (const entry of diff.added) {
          const write = toCatalogServerWrite(entry.config);
          await companyMcpApi.create(companyId, {
            name: entry.name,
            config: write.config,
            enabled: write.enabled,
          });
        }
        for (const entry of diff.changed) {
          const row = await resolveServerRow(entry.name);
          if (!row) continue;
          const write = toCatalogServerWrite(entry.config);
          await companyMcpApi.update(
            companyId,
            row.id,
            entry.enabledOnly
              ? { enabled: write.enabled }
              : { config: write.config, enabled: write.enabled },
          );
        }
        for (const name of diff.removed) {
          const row = await resolveServerRow(name);
          if (!row) continue;
          try {
            await companyMcpApi.remove(companyId, row.id);
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) {
              const usedByAgents =
                (error.body as { usedByAgents?: CompanyMcpServerUsageAgent[] } | null)
                  ?.usedByAgents ?? [];
              setRemoveConflict({ serverId: row.id, name, usedByAgents });
              continue;
            }
            throw error;
          }
        }
      } catch (error) {
        pushToast({
          tone: "error",
          title: "MCP catalog update failed",
          body: error instanceof Error ? error.message : "Failed to update MCP servers.",
        });
      }
    });
  }

  function handleStartOauth(serverName: string, server?: McpServerConfig) {
    if (!selectedCompanyId) return Promise.resolve();
    const companyId = selectedCompanyId;
    return enqueue(async () => {
      let row = await resolveServerRow(serverName);
      if (!row && server) {
        // "Save & connect" for a brand-new server whose create op failed or
        // has not landed yet — persist it so the broker can find it.
        const write = toCatalogServerWrite(server);
        const created = await companyMcpApi.create(companyId, {
          name: serverName,
          config: write.config,
          enabled: write.enabled,
        });
        row = { ...created, attachedAgentCount: 0, oauthConnected: false };
      }
      if (!row) {
        throw new Error(`MCP server "${serverName}" not found in the catalog`);
      }
      const { authorizeUrl } = await companyMcpApi.startOauth(companyId, row.id);
      window.open(authorizeUrl, "_blank", "noopener");
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Plug} message="Select a company to manage MCP servers." />;
  }

  const usedServers = (serversQuery.data ?? []).filter((item) => item.attachedAgentCount > 0);

  return (
    <>
      <Dialog
        open={removeConflict !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveConflict(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove MCP server</DialogTitle>
            <DialogDescription>
              This server is still enabled on agents. Removing it detaches it from all of them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {removeConflict
                ? `${removeConflict.name} is enabled on ${removeConflict.usedByAgents.length} agent${removeConflict.usedByAgents.length === 1 ? "" : "s"}.`
                : "This server is enabled on agents."}
            </p>
            {removeConflict?.usedByAgents.length ? (
              <div className="rounded-md border border-border px-3 py-3 text-muted-foreground">
                Currently used by {removeConflict.usedByAgents.map((agent) => agent.name).join(", ")}.
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRemoveConflict(null)}
              disabled={forceRemove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeConflict && forceRemove.mutate(removeConflict.serverId)}
              disabled={forceRemove.isPending || !removeConflict}
            >
              {forceRemove.isPending ? "Removing..." : "Remove anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="max-w-4xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">MCP</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Company-wide MCP server catalog. Define a server once, then enable it per agent from
              the agent&apos;s MCP tab.
            </p>
          </div>
          {pendingOps > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Saving changes...</span>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border px-4 py-4">
          <h2 className="text-sm font-semibold">How it works</h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-sm text-muted-foreground">
            <li>
              Add an MCP server here — a stdio command or an http/sse URL. Store tokens as secret
              references, or click Save &amp; connect for OAuth.
            </li>
            <li>Open an agent → MCP tab → tick the servers it should use.</li>
            <li>
              The agent gets the server&apos;s tools (
              <code className="font-mono text-xs">mcp__&lt;name&gt;__*</code>) on its next run.
            </li>
          </ol>
          <p className="mt-2 text-xs text-muted-foreground">
            Learn more: /docs/guides/mcp-servers
          </p>
        </div>

        {serversQuery.isLoading ? (
          <PageSkeleton variant="list" />
        ) : serversQuery.error ? (
          <p className="text-sm text-destructive">{serversQuery.error.message}</p>
        ) : (
          <>
            <McpServersEditor
              value={draft ?? serverRecord}
              secrets={secrets}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={handleEditorChange}
              onStartOauth={handleStartOauth}
            />

            {usedServers.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Usage
                </h2>
                <div className="rounded-md border border-border divide-y divide-border">
                  {usedServers.map((server) => (
                    <div
                      key={server.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate font-mono">{server.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Used by {server.attachedAgentCount} agent
                        {server.attachedAgentCount === 1 ? "" : "s"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
