import { Fragment, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AppWindow,
  Archive,
  Boxes,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Globe,
  ListTree,
  Network,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Stethoscope,
  Terminal,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { ToolApplication, ToolApplicationType, ToolConnection } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { ToolsPageHeader, LoadingState, ErrorState, HealthBadge, RelativeTime } from "./shared";
import { AddConnectionDialog, CatalogDialog, TRANSPORT_LABEL, connectionEndpoint } from "./connection-dialogs";

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "__all", label: "All types" },
  { value: "mcp_http", label: "MCP HTTP" },
  { value: "mcp_stdio", label: "MCP stdio" },
  { value: "paperclip_plugin", label: "Plugin" },
];

const VISIBILITY_FILTERS: { value: string; label: string }[] = [
  { value: "__all", label: "All visibility" },
  { value: "active", label: "Active" },
  { value: "hidden", label: "Hidden" },
];

/** Transport-tinted 28×28 icon, keyed off the application type. */
function appVisual(type: ToolApplicationType): { icon: LucideIcon; tint: string } {
  switch (type) {
    case "mcp_http":
      return { icon: Globe, tint: "bg-blue-500/15 text-blue-600 dark:text-blue-400" };
    case "mcp_stdio":
      return { icon: Terminal, tint: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" };
    case "paperclip_plugin":
      return { icon: Boxes, tint: "bg-violet-500/15 text-violet-600 dark:text-violet-400" };
    default:
      return { icon: Network, tint: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  }
}

function typeLabel(type: ToolApplicationType): string {
  switch (type) {
    case "mcp_http":
      return "MCP HTTP";
    case "mcp_stdio":
      return "MCP stdio";
    case "paperclip_plugin":
      return "Plugin";
    default:
      return type;
  }
}

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "enabled") return "default";
  if (status === "archived" || status === "disabled") return "outline";
  return "secondary";
}

function AppIcon({ type }: { type: ToolApplicationType }) {
  const { icon: Icon, tint } = appVisual(type);
  return (
    <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-sm", tint)}>
      <Icon className="h-4 w-4" />
    </span>
  );
}

interface EditApplicationDialogProps {
  application: ToolApplication;
  error: string | null;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description: string | null }) => void;
}

function EditApplicationDialog({ application, error, isSaving, onClose, onSubmit }: EditApplicationDialogProps) {
  const [name, setName] = useState(application.name);
  const [description, setDescription] = useState(application.description ?? "");
  const trimmedName = name.trim();

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit application</DialogTitle>
          <DialogDescription>Update the application details agents see in tool access surfaces.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmedName) return;
            onSubmit({
              name: trimmedName,
              description: description.trim() ? description.trim() : null,
            });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="tool-application-name">Name</Label>
            <Input
              id="tool-application-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-application-description">Description</Label>
            <Textarea
              id="tool-application-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tool-application-type">Type</Label>
            <Input id="tool-application-type" value={typeLabel(application.type)} readOnly />
          </div>
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !trimmedName}>
              {isSaving ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ApplicationLifecycleAction = {
  application: ToolApplication;
  status: "disabled" | "archived";
  connectionCount: number;
  toolCount: number;
};

function LifecycleConfirmDialog({
  action,
  isSaving,
  onClose,
  onConfirm,
}: {
  action: ApplicationLifecycleAction;
  isSaving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const verb = action.status === "archived" ? "Archive" : "Disable";
  const lower = verb.toLowerCase();
  const pendingLabel = action.status === "archived" ? "Archiving..." : "Disabling...";
  const connectionLabel = action.connectionCount === 1 ? "connection" : "connections";
  const toolLabel = action.toolCount === 1 ? "catalog tool" : "catalog tools";

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{verb} application</DialogTitle>
          <DialogDescription>
            {lower === "archive" ? "Archive" : "Disable"} {action.application.name} for every connection attached to it.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 px-3 py-3 text-sm">
          <div className="font-medium text-foreground">Impact summary</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-muted-foreground">
            <div>
              <div className="font-mono text-base text-foreground">{action.connectionCount}</div>
              <div>{connectionLabel} affected</div>
            </div>
            <div>
              <div className="font-mono text-base text-foreground">{action.toolCount}</div>
              <div>{toolLabel} affected</div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" variant={action.status === "archived" ? "destructive" : "default"} onClick={onConfirm} disabled={isSaving}>
            {isSaving ? pendingLabel : `${verb} application`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteApplicationDialog({
  application,
  connectionCount,
  error,
  isDeleting,
  onClose,
  onConfirm,
}: {
  application: ToolApplication;
  connectionCount: number;
  error: string | null;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete application</DialogTitle>
          <DialogDescription>
            Permanently delete {application.name}. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {connectionCount > 0 ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            This application still has {connectionCount} {connectionCount === 1 ? "connection" : "connections"}. Remove
            them or archive the application instead — delete is blocked while connections exist.
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            No connections are attached, so this application can be deleted safely.
          </div>
        )}
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? "Deleting..." : "Delete application"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApplicationsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);
  const [defaultApplicationId, setDefaultApplicationId] = useState<string | null>(null);
  const [expandedAppId, setExpandedAppId] = useState<string | null>(null);
  const [catalogFor, setCatalogFor] = useState<ToolConnection | null>(null);
  const [editingApplication, setEditingApplication] = useState<ToolApplication | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<ApplicationLifecycleAction | null>(null);
  const [deletingApplication, setDeletingApplication] = useState<ToolApplication | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("__all");
  const [visibilityFilter, setVisibilityFilter] = useState("__all");

  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const connList = connections.data?.connections ?? [];
  const visibleConnList = useMemo(
    () => connList.filter((c) => (c.status ?? "active") !== "archived"),
    [connList],
  );

  // Per-connection catalog counts let us show a real "tools" total per app
  // without inventing a company-wide aggregate endpoint.
  const catalogs = useQueries({
    queries: visibleConnList.map((c) => ({
      queryKey: queryKeys.tools.catalog(c.id),
      queryFn: () => toolsApi.listCatalog(c.id),
      staleTime: 60_000,
    })),
  });

  const toolCountByApp = useMemo(() => {
    const counts = new Map<string, number>();
    visibleConnList.forEach((c, i) => {
      const n = catalogs[i]?.data?.catalog?.length ?? 0;
      counts.set(c.applicationId, (counts.get(c.applicationId) ?? 0) + n);
    });
    return counts;
  }, [visibleConnList, catalogs]);

  const connCountByApp = useMemo(() => {
    const counts = new Map<string, number>();
    visibleConnList.forEach((c) => counts.set(c.applicationId, (counts.get(c.applicationId) ?? 0) + 1));
    return counts;
  }, [visibleConnList]);

  const connectionsByApp = useMemo(() => {
    const map = new Map<string, ToolConnection[]>();
    visibleConnList.forEach((c) => map.set(c.applicationId, [...(map.get(c.applicationId) ?? []), c]));
    return map;
  }, [visibleConnList]);

  const catalogCountByConn = useMemo(() => {
    const counts = new Map<string, number | null>();
    visibleConnList.forEach((c, i) => counts.set(c.id, catalogs[i]?.data ? catalogs[i].data.catalog.length : null));
    return counts;
  }, [visibleConnList, catalogs]);

  const invalidateConnections = () => qc.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
  const invalidateApplications = () => qc.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) });

  const updateApplication = useMutation({
    mutationFn: ({
      applicationId,
      input,
    }: {
      applicationId: string;
      input: { name?: string; description?: string | null; status?: ToolApplication["status"] };
    }) =>
      toolsApi.updateApplication(applicationId, input),
    onSuccess: (application, variables) => {
      invalidateApplications();
      setEditingApplication(null);
      setLifecycleAction(null);
      setEditError(null);
      const status = variables.input.status;
      pushToast({
        title: status ? `Application ${status === "active" ? "reactivated" : status}` : "Application updated",
        tone: "success",
      });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : String(err);
      if (err instanceof ApiError && err.status === 409) {
        setEditError("Another application already uses that name.");
        return;
      }
      setEditError(message);
      pushToast({
        title: "Could not update application",
        body: message,
        tone: "error",
      });
    },
  });

  const deleteApplication = useMutation({
    mutationFn: (applicationId: string) => toolsApi.deleteApplication(applicationId),
    onSuccess: (application) => {
      invalidateApplications();
      invalidateConnections();
      setDeletingApplication(null);
      setDeleteError(null);
      pushToast({ title: `Deleted ${application.name}`, tone: "success" });
    },
    onError: (err) => {
      // The server returns 409 when the application still has connections; show
      // the "remove connections or archive instead" guidance inline rather than
      // as a transient toast.
      const message = err instanceof ApiError ? err.message : String(err);
      setDeleteError(message);
      if (!(err instanceof ApiError && err.status === 409)) {
        pushToast({ title: "Could not delete application", body: message, tone: "error" });
      }
    },
  });

  const healthCheck = useMutation({
    mutationFn: (id: string) => toolsApi.checkConnectionHealth(id),
    onSuccess: (res) => {
      invalidateConnections();
      pushToast({
        title: `Health: ${res.connection.healthStatus}`,
        body: res.connection.healthMessage ?? undefined,
        tone: res.connection.healthStatus === "error" ? "error" : "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Health check failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => toolsApi.refreshCatalog(id),
    onSuccess: (res) => {
      invalidateConnections();
      qc.invalidateQueries({ queryKey: queryKeys.tools.catalog(res.connection.id) });
      pushToast({
        title: `Discovered ${res.discoveredCount} tools`,
        body: res.quarantinedCount > 0 ? `${res.quarantinedCount} quarantined for review` : undefined,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Catalog refresh failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const toggleEnabled = useMutation({
    mutationFn: (conn: ToolConnection) => toolsApi.updateConnection(conn.id, { enabled: !conn.enabled }),
    onSuccess: (conn) => {
      invalidateConnections();
      pushToast({
        title: conn.enabled ? "Connection enabled" : "Connection disabled",
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Could not update connection",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const filtered = useMemo(() => {
    let list: ToolApplication[] = apps.data?.applications ?? [];
    if (typeFilter !== "__all") list = list.filter((a) => a.type === typeFilter);
    if (visibilityFilter === "active") list = list.filter((a) => a.status === "active");
    else if (visibilityFilter === "hidden")
      list = list.filter((a) => a.status === "archived" || a.status === "disabled");
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.description ?? "").toLowerCase().includes(q),
      );
    }
    return list;
  }, [apps.data, typeFilter, visibilityFilter, search]);

  if (apps.isLoading) return <LoadingState />;
  if (apps.error) return <ErrorState error={apps.error} onRetry={() => apps.refetch()} />;

  const total = apps.data?.applications.length ?? 0;

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Applications"
        description="External tool sources and their managed MCP connections. Expand an application to test, refresh, enable, or inspect its tools."
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                pushToast({
                  title: "Import manifest",
                  body: "Paste-an-mcp.json import is wired to the existing import endpoint in a follow-up. Use Add for now.",
                  tone: "info",
                })
              }
            >
              <Upload className="mr-1 h-4 w-4" />
              Import manifest
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setDefaultApplicationId(null);
                setOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              Add
            </Button>
          </>
        }
      />

      {total === 0 ? (
        <EmptyState
          icon={AppWindow}
          message="No applications yet"
          description="Add an MCP connection to create or attach an application and start governing tool access."
          action="Add application"
          onAction={() => {
            setDefaultApplicationId(null);
            setOpen(true);
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search applications…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_FILTERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={visibilityFilter} onValueChange={setVisibilityFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VISIBILITY_FILTERS.map((v) => (
                  <SelectItem key={v.value} value={v.value}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Card>
            <CardContent className="px-0 py-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="w-8 px-2 py-2.5 font-medium" aria-label="Expand" />
                    <th className="px-4 py-2.5 font-medium">Application</th>
                    <th className="px-3 py-2.5 font-medium">Type</th>
                    <th className="px-3 py-2.5 text-right font-medium">Tools</th>
                    <th className="px-3 py-2.5 text-right font-medium">Connections</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">Updated</th>
                    <th className="w-10 px-2 py-2.5 font-medium" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((app) => {
                    const appConnections = connectionsByApp.get(app.id) ?? [];
                    const isExpanded = expandedAppId === app.id;
                    return (
                      <Fragment key={app.id}>
                        <tr className="align-top">
                          <td className="px-2 py-3">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${app.name}`}
                              onClick={() => setExpandedAppId(isExpanded ? null : app.id)}
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <AppIcon type={app.type} />
                              <div className="min-w-0">
                                <div className="font-medium text-foreground">{app.name}</div>
                                {app.description ? (
                                  <div className="truncate text-xs text-muted-foreground">{app.description}</div>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant="outline">{typeLabel(app.type)}</Badge>
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-xs text-foreground">
                            {toolCountByApp.get(app.id) ?? 0}
                          </td>
                          <td className="px-3 py-3 text-right font-mono text-xs text-foreground">
                            {connCountByApp.get(app.id) ?? 0}
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right text-xs">
                            <RelativeTime value={app.updatedAt} />
                          </td>
                          <td className="px-2 py-3 text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-7 w-7"
                                  aria-label={`Actions for ${app.name}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                  onSelect={() => {
                                    setEditError(null);
                                    setEditingApplication(app);
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                  Edit
                                </DropdownMenuItem>
                                {app.status !== "archived" ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    {app.status !== "disabled" ? (
                                      <DropdownMenuItem
                                        disabled={updateApplication.isPending}
                                        onSelect={() =>
                                          setLifecycleAction({
                                            application: app,
                                            status: "disabled",
                                            connectionCount: connCountByApp.get(app.id) ?? 0,
                                            toolCount: toolCountByApp.get(app.id) ?? 0,
                                          })
                                        }
                                      >
                                        <Power className="h-4 w-4" />
                                        Disable
                                      </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                      disabled={updateApplication.isPending}
                                      variant="destructive"
                                      onSelect={() =>
                                        setLifecycleAction({
                                          application: app,
                                          status: "archived",
                                          connectionCount: connCountByApp.get(app.id) ?? 0,
                                          toolCount: toolCountByApp.get(app.id) ?? 0,
                                        })
                                      }
                                    >
                                      <Archive className="h-4 w-4" />
                                      Archive
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                                {app.status === "disabled" || app.status === "archived" ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      disabled={updateApplication.isPending}
                                      onSelect={() =>
                                        updateApplication.mutate({
                                          applicationId: app.id,
                                          input: { status: "active" },
                                        })
                                      }
                                    >
                                      <RotateCcw className="h-4 w-4" />
                                      Reactivate
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="destructive"
                                  disabled={deleteApplication.isPending}
                                  onSelect={() => {
                                    setDeleteError(null);
                                    setDeletingApplication(app);
                                  }}
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="bg-muted/20">
                            <td className="px-2 py-2" />
                            <td colSpan={7} className="px-4 py-3">
                              {appConnections.length === 0 ? (
                                <div className="flex items-center justify-between gap-3 py-1 text-sm">
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <Plug className="h-4 w-4" />
                                    No connections for this application yet.
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setDefaultApplicationId(app.id);
                                      setOpen(true);
                                    }}
                                  >
                                    <Plus className="mr-1 h-3.5 w-3.5" />
                                    Add connection
                                  </Button>
                                </div>
                              ) : (
                                <div className="divide-y divide-border">
                                  {appConnections.map((conn) => {
                                    const endpoint = connectionEndpoint(conn);
                                    const catalogCount = catalogCountByConn.get(conn.id);
                                    return (
                                      <div
                                        key={conn.id}
                                        className="grid grid-cols-[minmax(12rem,1.5fr)_8rem_8rem_8rem_minmax(18rem,auto)] items-center gap-3 py-2 text-sm"
                                      >
                                        <div className="flex min-w-0 items-start gap-2">
                                          <Plug className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                          <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                              <span className="font-medium text-foreground">{conn.name}</span>
                                              {!conn.enabled ? <Badge variant="outline">disabled</Badge> : null}
                                              {conn.status === "draft" ? <Badge variant="outline">draft</Badge> : null}
                                            </div>
                                            {endpoint ? (
                                              <div className="truncate font-mono text-xs text-muted-foreground" title={endpoint}>
                                                {endpoint}
                                              </div>
                                            ) : null}
                                          </div>
                                        </div>
                                        <Badge variant="outline" className="w-fit">
                                          {TRANSPORT_LABEL[conn.transport ?? ""] ?? conn.transport ?? "-"}
                                        </Badge>
                                        <HealthBadge status={conn.healthStatus} />
                                        <div className="text-xs text-muted-foreground">
                                          <span className="font-medium tabular-nums text-foreground">
                                            {catalogCount == null ? "-" : catalogCount}
                                          </span>{" "}
                                          tools
                                          <div className="text-[11px]">
                                            refreshed <RelativeTime value={conn.lastCatalogRefreshAt ?? conn.updatedAt} />
                                          </div>
                                        </div>
                                        <div className="flex justify-end gap-1.5">
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={healthCheck.isPending}
                                            onClick={() => healthCheck.mutate(conn.id)}
                                          >
                                            <Stethoscope className="mr-1 h-3.5 w-3.5" />
                                            Probe
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={refresh.isPending}
                                            onClick={() => refresh.mutate(conn.id)}
                                          >
                                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                                            Refresh
                                          </Button>
                                          <Button size="sm" variant="outline" onClick={() => setCatalogFor(conn)}>
                                            <ListTree className="mr-1 h-3.5 w-3.5" />
                                            Catalog
                                          </Button>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={toggleEnabled.isPending}
                                            onClick={() => toggleEnabled.mutate(conn)}
                                          >
                                            <Power className="mr-1 h-3.5 w-3.5" />
                                            {conn.enabled ? "Disable" : "Enable"}
                                          </Button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        No applications match the current filters.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {catalogFor ? <CatalogDialog connection={catalogFor} onClose={() => setCatalogFor(null)} /> : null}
      {editingApplication ? (
        <EditApplicationDialog
          application={editingApplication}
          error={editError}
          isSaving={updateApplication.isPending}
          onClose={() => {
            if (updateApplication.isPending) return;
            setEditingApplication(null);
            setEditError(null);
          }}
          onSubmit={(input) => {
            setEditError(null);
            updateApplication.mutate({ applicationId: editingApplication.id, input });
          }}
        />
      ) : null}
      {lifecycleAction ? (
        <LifecycleConfirmDialog
          action={lifecycleAction}
          isSaving={updateApplication.isPending}
          onClose={() => {
            if (updateApplication.isPending) return;
            setLifecycleAction(null);
          }}
          onConfirm={() =>
            updateApplication.mutate({
              applicationId: lifecycleAction.application.id,
              input: { status: lifecycleAction.status },
            })
          }
        />
      ) : null}
      {deletingApplication ? (
        <DeleteApplicationDialog
          application={deletingApplication}
          connectionCount={connCountByApp.get(deletingApplication.id) ?? 0}
          error={deleteError}
          isDeleting={deleteApplication.isPending}
          onClose={() => {
            if (deleteApplication.isPending) return;
            setDeletingApplication(null);
            setDeleteError(null);
          }}
          onConfirm={() => {
            setDeleteError(null);
            deleteApplication.mutate(deletingApplication.id);
          }}
        />
      ) : null}
      {open ? (
        <AddConnectionDialog
          companyId={companyId}
          defaultApplicationId={defaultApplicationId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
