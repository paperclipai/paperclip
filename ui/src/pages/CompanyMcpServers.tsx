import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentEnvConfig, CompanySecret, EnvBinding, McpServer, McpServerTransport } from "@paperclipai/shared";
import {
  Cable,
  CheckCircle2,
  Pencil,
  Plus,
  RefreshCcw,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToastActions } from "@/context/ToastContext";
import { mcpServersApi } from "@/api/mcpServers";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EnvironmentVariablesEditor } from "@/components/environment-variables-editor";

const MCP_SERVER_METADATA_BEARER_ENV_KEY = "httpBearerTokenEnvVar";
const MCP_SERVER_METADATA_FORWARDED_ENV_KEYS = "forwardedEnvKeys";
const MCP_SERVER_METADATA_HEADER_ENV_BINDINGS = "headerEnvBindings";

type KeyValueRow = {
  key: string;
  value: string;
};

type ServerDraft = {
  name: string;
  slug: string;
  description: string;
  transport: McpServerTransport;
  command: string;
  args: string[];
  cwd: string;
  url: string;
  env: Record<string, EnvBinding>;
  forwardedEnvKeys: string[];
  headers: KeyValueRow[];
  headerEnvBindings: KeyValueRow[];
  bearerTokenEnvVar: string;
};

const EMPTY_DRAFT: ServerDraft = {
  name: "",
  slug: "",
  description: "",
  transport: "stdio",
  command: "",
  args: [""],
  cwd: "",
  url: "",
  env: {},
  forwardedEnvKeys: [""],
  headers: [{ key: "", value: "" }],
  headerEnvBindings: [{ key: "", value: "" }],
  bearerTokenEnvVar: "",
};

function slugifyName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeStringArray(values: string[]): string[] {
  const next = values.map((value) => value.trim()).filter(Boolean);
  return next.length > 0 ? next : [];
}

function normalizeRecordRows(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(
    rows
      .map((row) => [row.key.trim(), row.value.trim()] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0),
  );
}

function toRows(record: Record<string, string> | null | undefined): KeyValueRow[] {
  const rows = Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
  return rows.length > 0 ? [...rows, { key: "", value: "" }] : [{ key: "", value: "" }];
}

function toStringRows(values: string[] | null | undefined): string[] {
  const rows = (values ?? []).filter((value) => value.trim().length > 0);
  return rows.length > 0 ? [...rows, ""] : [""];
}

function metadataString(server: McpServer, key: string): string {
  const value = server.metadata[key];
  return typeof value === "string" ? value : "";
}

function metadataStringArray(server: McpServer, key: string): string[] {
  const value = server.metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function metadataRecord(server: McpServer, key: string): Record<string, string> {
  const value = server.metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => typeof entry === "string"),
  ) as Record<string, string>;
}

function toDraft(server: McpServer): ServerDraft {
  return {
    name: server.name,
    slug: server.slug,
    description: server.description ?? "",
    transport: server.transport,
    command: server.command ?? "",
    args: toStringRows(server.args),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    env: server.env ?? {},
    forwardedEnvKeys: toStringRows(metadataStringArray(server, MCP_SERVER_METADATA_FORWARDED_ENV_KEYS)),
    headers: toRows(server.headers),
    headerEnvBindings: toRows(metadataRecord(server, MCP_SERVER_METADATA_HEADER_ENV_BINDINGS)),
    bearerTokenEnvVar: metadataString(server, MCP_SERVER_METADATA_BEARER_ENV_KEY),
  };
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

function DynamicStringList({
  label,
  placeholder,
  values,
  onChange,
  addLabel,
}: {
  label: string;
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
  addLabel: string;
}) {
  function updateRow(index: number, value: string) {
    const next = values.map((entry, entryIndex) => (entryIndex === index ? value : entry));
    if (next[next.length - 1]?.trim()) next.push("");
    onChange(next);
  }

  function removeRow(index: number) {
    const next = values.filter((_, entryIndex) => entryIndex !== index);
    onChange(next.length > 0 ? next : [""]);
  }

  return (
    <div className="grid gap-2 text-sm">
      <span>{label}</span>
      <div className="space-y-2">
        {values.map((value, index) => {
          const isTrailing = index === values.length - 1 && value.trim().length === 0;
          return (
            <div key={`${label}-${index}`} className="flex items-center gap-2">
              <Input
                value={value}
                placeholder={placeholder}
                onChange={(event) => updateRow(index, event.target.value)}
              />
              {!isTrailing ? (
                <Button type="button" size="icon-sm" variant="outline" onClick={() => removeRow(index)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-center"
        onClick={() => onChange([...values.slice(0, -1), values[values.length - 1] ?? "", ""])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

function KeyValueEditor({
  label,
  keyPlaceholder,
  valuePlaceholder,
  rows,
  onChange,
  addLabel,
}: {
  label: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  addLabel: string;
}) {
  function updateRow(index: number, patch: Partial<KeyValueRow>) {
    const next = rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    const last = next[next.length - 1];
    if (last && (last.key.trim().length > 0 || last.value.trim().length > 0)) {
      next.push({ key: "", value: "" });
    }
    onChange(next);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    onChange(next.length > 0 ? next : [{ key: "", value: "" }]);
  }

  return (
    <div className="grid gap-2 text-sm">
      <span>{label}</span>
      <div className="space-y-2">
        {rows.map((row, index) => {
          const isTrailing =
            index === rows.length - 1 &&
            row.key.trim().length === 0 &&
            row.value.trim().length === 0;
          return (
            <div key={`${label}-${index}`} className="flex items-center gap-2">
              <Input
                value={row.key}
                placeholder={keyPlaceholder}
                onChange={(event) => updateRow(index, { key: event.target.value })}
              />
              <Input
                value={row.value}
                placeholder={valuePlaceholder}
                onChange={(event) => updateRow(index, { value: event.target.value })}
              />
              {!isTrailing ? (
                <Button type="button" size="icon-sm" variant="outline" onClick={() => removeRow(index)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-center"
        onClick={() => onChange([...rows.slice(0, -1), rows[rows.length - 1] ?? { key: "", value: "" }, { key: "", value: "" }])}
      >
        {addLabel}
      </Button>
    </div>
  );
}

function EnvSummary({ env }: { env: Record<string, EnvBinding> }) {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs">
      <div className="mb-2 font-medium">Environment</div>
      <div className="space-y-1 text-muted-foreground">
        {entries.map(([key, value]) => (
          <div key={key}>
            <span className="font-mono">{key}</span>
            <span className="mx-2">=</span>
            <span>{typeof value === "object" && value && "type" in value && value.type === "secret_ref" ? "secret" : "plain"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CompanyMcpServers() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServer | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(EMPTY_DRAFT);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "MCP Servers" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.mcpServers.list(selectedCompanyId) : ["mcp-servers", "__none__"] as const,
    queryFn: () => mcpServersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "__none__"] as const,
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const snapshotsQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.mcpServers.list(selectedCompanyId), "latest-snapshots"] as const
      : ["mcp-servers", "__none__", "latest-snapshots"] as const,
    queryFn: async () => {
      const servers = await mcpServersApi.list(selectedCompanyId!);
      const snapshots = await Promise.all(
        servers.map(async (server) => {
          try {
            const snapshot = await mcpServersApi.latestSnapshot(server.id);
            return [server.id, snapshot] as const;
          } catch {
            return [server.id, null] as const;
          }
        }),
      );
      return {
        servers,
        snapshots: new Map(snapshots),
      };
    },
    enabled: !!selectedCompanyId,
  });

  const createSecret = useMutation({
    mutationFn: async (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const servers = useMemo(
    () => snapshotsQuery.data?.servers ?? listQuery.data ?? [],
    [listQuery.data, snapshotsQuery.data?.servers],
  );
  const availableSecrets = secretsQuery.data ?? [];
  const snapshotByServerId =
    snapshotsQuery.data?.snapshots ??
    new Map<string, Awaited<ReturnType<typeof mcpServersApi.latestSnapshot>> | null>();

  function invalidate() {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: [...queryKeys.mcpServers.list(selectedCompanyId), "latest-snapshots"] });
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        description: draft.description.trim() || null,
        transport: draft.transport,
        command: draft.transport === "stdio" ? draft.command.trim() || null : null,
        args: draft.transport === "stdio" ? normalizeStringArray(draft.args) : [],
        cwd: draft.transport === "stdio" ? draft.cwd.trim() || null : null,
        url: draft.transport !== "stdio" ? draft.url.trim() || null : null,
        headers: draft.transport !== "stdio" ? normalizeRecordRows(draft.headers) : {},
        env: draft.transport === "stdio" ? draft.env : {},
        metadata: {
          ...(draft.transport === "stdio"
            ? {
                [MCP_SERVER_METADATA_FORWARDED_ENV_KEYS]: normalizeStringArray(draft.forwardedEnvKeys),
              }
            : {
                [MCP_SERVER_METADATA_BEARER_ENV_KEY]: draft.bearerTokenEnvVar.trim() || null,
                [MCP_SERVER_METADATA_HEADER_ENV_BINDINGS]: normalizeRecordRows(draft.headerEnvBindings),
              }),
        },
      };
      if (!selectedCompanyId) throw new Error("No company selected");
      if (editingServer) {
        return mcpServersApi.update(editingServer.id, payload);
      }
      return mcpServersApi.create(selectedCompanyId, payload);
    },
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      setEditingServer(null);
      setDraft(EMPTY_DRAFT);
      pushToast({
        title: editingServer ? "MCP server updated" : "MCP server created",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save MCP server",
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
        title: result.ok ? "MCP discovery succeeded" : "MCP discovery failed",
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

  const deleteMutation = useMutation({
    mutationFn: (serverId: string) => mcpServersApi.remove(serverId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "MCP server removed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to remove MCP server",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  function openCreateDialog() {
    setEditingServer(null);
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  }

  function openEditDialog(server: McpServer) {
    setEditingServer(server);
    setDraft(toDraft(server));
    setDialogOpen(true);
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-lg font-semibold">MCP Servers</h1>
            <p className="text-sm text-muted-foreground">
              Register and test the MCP servers this company can expose to agents.
            </p>
          </div>
        </div>
        <Button size="sm" className="gap-2" onClick={openCreateDialog}>
          <Plus className="h-4 w-4" />
          New MCP Server
        </Button>
      </div>

      {listQuery.isLoading || snapshotsQuery.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading MCP servers...</div>
      ) : servers.length === 0 ? (
        <Card className="bg-muted/20">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Cable className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">No MCP servers registered</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create one here, test it, and then bind it to an agent.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {servers.map((server) => {
            const snapshot = snapshotByServerId.get(server.id) ?? null;
            const forwardedEnvKeys = metadataStringArray(server, MCP_SERVER_METADATA_FORWARDED_ENV_KEYS);
            const bearerTokenEnvVar = metadataString(server, MCP_SERVER_METADATA_BEARER_ENV_KEY);
            const headerEnvBindings = metadataRecord(server, MCP_SERVER_METADATA_HEADER_ENV_BINDINGS);
            return (
              <Card key={server.id} className="gap-4 py-5">
                <CardHeader className="px-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="text-base">{server.name}</CardTitle>
                      <CardDescription className="mt-1">
                        <span className="font-mono text-xs">{server.slug}</span>
                        <span className="mx-2">·</span>
                        <span>{server.transport}</span>
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={healthTone(server.lastHealthStatus)}>
                        {server.lastHealthStatus}
                      </Badge>
                      {server.enabled ? <Badge variant="outline">enabled</Badge> : <Badge variant="secondary">disabled</Badge>}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 px-5">
                  {server.description ? (
                    <p className="text-sm text-muted-foreground">{server.description}</p>
                  ) : null}

                  <div className="rounded-md border border-border/70 bg-background/60 p-3 text-xs">
                    <div className="grid gap-2">
                      {server.transport === "stdio" ? (
                        <>
                          <div><span className="text-muted-foreground">Command: </span><span className="font-mono">{server.command ?? "—"}</span></div>
                          <div><span className="text-muted-foreground">Args: </span><span className="font-mono break-all">{server.args.join(" ") || "—"}</span></div>
                          <div><span className="text-muted-foreground">Cwd: </span><span className="font-mono break-all">{server.cwd ?? "—"}</span></div>
                          <div><span className="text-muted-foreground">Forward env: </span><span className="font-mono break-all">{forwardedEnvKeys.join(", ") || "—"}</span></div>
                        </>
                      ) : (
                        <>
                          <div><span className="text-muted-foreground">URL: </span><span className="font-mono break-all">{server.url ?? "—"}</span></div>
                          <div><span className="text-muted-foreground">Bearer env var: </span><span className="font-mono break-all">{bearerTokenEnvVar || "—"}</span></div>
                          <div><span className="text-muted-foreground">Headers: </span><span className="font-mono break-all">{Object.keys(server.headers).join(", ") || "—"}</span></div>
                          <div><span className="text-muted-foreground">Header env vars: </span><span className="font-mono break-all">{Object.entries(headerEnvBindings).map(([header, envKey]) => `${header}<-${envKey}`).join(", ") || "—"}</span></div>
                        </>
                      )}
                    </div>
                  </div>

                  {server.transport === "stdio" ? <EnvSummary env={server.env} /> : null}

                  <div className="rounded-md border border-border/70 bg-muted/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium">Latest discovery</div>
                      {snapshot ? (
                        snapshot.status === "succeeded" ? (
                          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Ready
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                            <XCircle className="h-3.5 w-3.5" />
                            Failed
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">No snapshot yet</span>
                      )}
                    </div>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {snapshot ? (
                        <>
                          <div>{snapshot.summary ?? snapshot.error ?? "No summary available."}</div>
                          <div>
                            {snapshot.tools.length} tools · {snapshot.resources.length} resources · {snapshot.prompts.length} prompts
                          </div>
                        </>
                      ) : (
                        <div>Run a discovery test to inspect the server catalog.</div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={() => testMutation.mutate(server.id)}
                      disabled={testMutation.isPending}
                    >
                      <RefreshCcw className="h-3.5 w-3.5" />
                      Test & Discover
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => openEditDialog(server)}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2 text-destructive hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(`Remove MCP server "${server.name}"?`)) {
                          deleteMutation.mutate(server.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>

                  {server.lastError ? (
                    <div className="rounded-md border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-xs text-red-700 dark:text-red-300">
                      {server.lastError}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[88vh] overflow-hidden p-0">
          <div className="flex max-h-[88vh] flex-col">
          <DialogHeader>
            <div className="px-6 pt-6">
            <DialogTitle>{editingServer ? "Edit MCP Server" : "New MCP Server"}</DialogTitle>
            <DialogDescription>
              Register a server once, test it here, then bind it to whichever agents should use it.
            </DialogDescription>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-3">
          <div className="grid gap-3">
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-2 text-sm">
                <span>Name</span>
                <Input
                  value={draft.name}
                  onChange={(event) => {
                    const nextName = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      name: nextName,
                      slug: editingServer ? current.slug : slugifyName(nextName),
                    }));
                  }}
                />
              </label>
              <label className="grid gap-2 text-sm">
                <span>Slug</span>
                <Input
                  value={draft.slug}
                  onChange={(event) => setDraft((current) => ({ ...current, slug: slugifyName(event.target.value) }))}
                />
              </label>
            </div>

            <label className="grid gap-2 text-sm">
              <span>Description</span>
              <textarea
                value={draft.description}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                className="min-h-16 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </label>

            <label className="grid gap-2 text-sm">
              <span>Transport</span>
              <select
                value={draft.transport}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, transport: event.target.value as McpServerTransport }))
                }
                className="h-10 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>

            {draft.transport === "stdio" ? (
              <div className="grid gap-3">
                <label className="grid gap-2 text-sm">
                  <span>Command</span>
                  <Input
                    value={draft.command}
                    onChange={(event) => setDraft((current) => ({ ...current, command: event.target.value }))}
                  />
                </label>

                <DynamicStringList
                  label="Arguments"
                  placeholder="argument"
                  values={draft.args}
                  onChange={(args) => setDraft((current) => ({ ...current, args }))}
                  addLabel="+ Add argument"
                />

                <label className="grid gap-2 text-sm">
                  <span>Working directory</span>
                  <Input
                    value={draft.cwd}
                    onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))}
                  />
                </label>

                <div className="grid gap-2 text-sm">
                  <span>Environment variables</span>
                  <EnvironmentVariablesEditor
                    value={draft.env}
                    secrets={availableSecrets}
                    onCreateSecret={async (name, value) => createSecret.mutateAsync({ name, value })}
                    onChange={(env) => setDraft((current) => ({ ...current, env: env ?? {} }))}
                  />
                </div>

                <DynamicStringList
                  label="Environment variable forwarding"
                  placeholder="EXISTING_HOST_ENV_KEY"
                  values={draft.forwardedEnvKeys}
                  onChange={(forwardedEnvKeys) => setDraft((current) => ({ ...current, forwardedEnvKeys }))}
                  addLabel="+ Add variable"
                />
              </div>
            ) : (
              <div className="grid gap-3">
                <label className="grid gap-2 text-sm">
                  <span>Server URL</span>
                  <Input
                    value={draft.url}
                    onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </label>

                <label className="grid gap-2 text-sm">
                  <span>Bearer token environment variable</span>
                  <Input
                    value={draft.bearerTokenEnvVar}
                    onChange={(event) => setDraft((current) => ({ ...current, bearerTokenEnvVar: event.target.value }))}
                    placeholder="MCP_BEARER_TOKEN"
                  />
                </label>

                <KeyValueEditor
                  label="Headers"
                  keyPlaceholder="Header"
                  valuePlaceholder="Value"
                  rows={draft.headers}
                  onChange={(headers) => setDraft((current) => ({ ...current, headers }))}
                  addLabel="+ Add header"
                />

                <KeyValueEditor
                  label="Headers from environment variables"
                  keyPlaceholder="Header"
                  valuePlaceholder="ENV_KEY"
                  rows={draft.headerEnvBindings}
                  onChange={(headerEnvBindings) => setDraft((current) => ({ ...current, headerEnvBindings }))}
                  addLabel="+ Add header env binding"
                />
              </div>
            )}
          </div>
          </div>
          <DialogFooter className="border-t border-border px-6 py-4">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!draft.name.trim() || !draft.slug.trim() || saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving..." : editingServer ? "Save Changes" : "Create MCP Server"}
            </Button>
          </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
