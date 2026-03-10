import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { mcpServersApi } from "../api/mcpServers";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Plug, Plus, Pencil, Trash2 } from "lucide-react";
import type { McpServer, McpTransportType } from "@paperclipai/shared";

const TRANSPORT_LABELS: Record<McpTransportType, string> = {
  stdio: "stdio",
  sse: "SSE",
  "streamable-http": "Streamable HTTP",
};

function McpServerDialog({
  open,
  onOpenChange,
  companyId,
  editServer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  editServer: McpServer | null;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transportType, setTransportType] = useState<McpTransportType>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    if (editServer) {
      setName(editServer.name);
      setDescription(editServer.description ?? "");
      setTransportType(editServer.transportType);
      setCommand(editServer.command ?? "");
      setArgs(Array.isArray(editServer.args) ? editServer.args.join(" ") : "");
      setUrl(editServer.url ?? "");
      const envObj = (editServer.env ?? {}) as Record<string, unknown>;
      setEnvText(
        Object.entries(envObj)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : (v as { value?: string })?.value ?? ""}`)
          .join("\n"),
      );
    } else {
      setName("");
      setDescription("");
      setTransportType("stdio");
      setCommand("");
      setArgs("");
      setUrl("");
      setEnvText("");
    }
  }, [editServer, open]);

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      mcpServersApi.create(companyId, data as Parameters<typeof mcpServersApi.create>[1]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(companyId) });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      mcpServersApi.update(id, data as Parameters<typeof mcpServersApi.update>[1]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(companyId) });
    },
  });

  const mutation = editServer ? updateMutation : createMutation;

  function parseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
    return env;
  }

  async function handleSubmit() {
    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      transportType,
      command: transportType === "stdio" ? command.trim() : null,
      args: transportType === "stdio" && args.trim() ? args.trim().split(/\s+/) : [],
      url: transportType !== "stdio" ? url.trim() : null,
      env: parseEnv(),
    };

    try {
      if (editServer) {
        await updateMutation.mutateAsync({ id: editServer.id, data: payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
      onOpenChange(false);
    } catch {
      // surfaced via mutation.isError
    }
  }

  const isValid =
    name.trim().length > 0 &&
    (transportType === "stdio" ? command.trim().length > 0 : url.trim().length > 0);

  const inputClass =
    "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-foreground/30 transition-colors";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 sm:max-w-lg">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">
            {editServer ? "Edit MCP Server" : "New MCP Server"}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => onOpenChange(false)}>
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              className={inputClass}
              placeholder="my-mcp-server"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <input
              className={inputClass}
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Transport</label>
            <select
              className={inputClass}
              value={transportType}
              onChange={(e) => setTransportType(e.target.value as McpTransportType)}
            >
              <option value="stdio">stdio</option>
              <option value="sse">SSE</option>
              <option value="streamable-http">Streamable HTTP</option>
            </select>
          </div>

          {transportType === "stdio" ? (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Command</label>
                <input
                  className={inputClass}
                  placeholder="npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Args <span className="text-muted-foreground/60">(space-separated)</span>
                </label>
                <input
                  className={inputClass}
                  placeholder="-y @anthropic-ai/mcp-server-memory"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div>
              <label className="text-xs font-medium text-muted-foreground">URL</label>
              <input
                className={inputClass}
                placeholder="https://example.com/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Environment Variables <span className="text-muted-foreground/60">(KEY=value, one per line)</span>
            </label>
            <textarea
              className={`${inputClass} min-h-[60px] font-mono text-xs`}
              placeholder={"API_KEY=sk-...\nDEBUG=true"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {mutation.isError ? (
            <p className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Failed to save."}
            </p>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            disabled={!isValid || mutation.isPending}
            onClick={handleSubmit}
          >
            {mutation.isPending ? "Saving..." : editServer ? "Save" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirmDialog({
  open,
  onOpenChange,
  server,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: McpServer | null;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: (id: string) => mcpServersApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(companyId) });
      onOpenChange(false);
    },
  });

  if (!server) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 sm:max-w-md">
        <div className="px-4 py-4 space-y-3">
          <p className="text-sm font-medium">Delete MCP Server</p>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{server.name}</strong>? This will also remove it
            from all agents.
          </p>
          {deleteMutation.isError && (
            <p className="text-xs text-destructive">Failed to delete.</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate(server.id)}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function McpServers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editServer, setEditServer] = useState<McpServer | null>(null);
  const [deleteServer, setDeleteServer] = useState<McpServer | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "MCP Servers" }]);
  }, [setBreadcrumbs]);

  const {
    data: servers,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.mcpServers.list(selectedCompanyId!),
    queryFn: () => mcpServersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      mcpServersApi.update(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={Plug} message="Select a company." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">MCP Servers</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditServer(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Server
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load"}</p>}

      {servers && servers.length === 0 && (
        <EmptyState
          icon={Plug}
          message="No MCP servers configured yet."
          action="Add Server"
          onAction={() => {
            setEditServer(null);
            setDialogOpen(true);
          }}
        />
      )}

      {servers && servers.length > 0 && (
        <div className="rounded-md border border-border divide-y divide-border">
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
            >
              <Plug className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{server.name}</span>
                  <Badge variant="outline" className="text-[10px] font-normal shrink-0">
                    {TRANSPORT_LABELS[server.transportType]}
                  </Badge>
                  {!server.enabled && (
                    <Badge variant="secondary" className="text-[10px] font-normal shrink-0">
                      disabled
                    </Badge>
                  )}
                </div>
                {server.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {server.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title={server.enabled ? "Disable" : "Enable"}
                  onClick={() =>
                    toggleMutation.mutate({ id: server.id, enabled: !server.enabled })
                  }
                >
                  <span className={`text-xs ${server.enabled ? "text-green-500" : "text-muted-foreground"}`}>
                    {server.enabled ? "ON" : "OFF"}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setEditServer(server);
                    setDialogOpen(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setDeleteServer(server)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <McpServerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={selectedCompanyId}
        editServer={editServer}
      />

      <DeleteConfirmDialog
        open={!!deleteServer}
        onOpenChange={(open) => {
          if (!open) setDeleteServer(null);
        }}
        server={deleteServer}
        companyId={selectedCompanyId}
      />
    </div>
  );
}
