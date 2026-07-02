import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DataRecoveryDetailResponse, DataRecoveryItem, DataRecoveryItemType } from "@paperclipai/shared";
import { ArchiveRestore, ExternalLink, Pencil, RotateCcw, Search, Trash2 } from "lucide-react";
import { dataRecoveryApi } from "@/api/dataRecovery";
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
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { Link, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";

const typeLabels: Record<DataRecoveryItemType, string> = {
  company: "Company",
  agent: "Agent",
  project: "Project",
  issue: "Issue",
};

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getTypeValue(value: string): DataRecoveryItemType | "all" {
  return value === "company" || value === "agent" || value === "project" || value === "issue"
    ? value
    : "all";
}

function shortId(id: string) {
  return id.slice(0, 8);
}

export function InstanceDataRecovery() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const location = useLocation();
  const { companies: allCompanies } = useCompany();
  const [typeFilter, setTypeFilter] = useState<DataRecoveryItemType | "all">("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [detail, setDetail] = useState<DataRecoveryDetailResponse | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<DataRecoveryItem | null>(null);
  const [renameCandidate, setRenameCandidate] = useState<DataRecoveryItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings", href: "/instance/settings/general" },
      { label: "Data Recovery" },
    ]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    const companyId = new URLSearchParams(location.search).get("companyId");
    if (companyId) setCompanyFilter(companyId);
  }, [location.search]);

  const recoveryQuery = useQuery({
    queryKey: queryKeys.instance.dataRecovery,
    queryFn: () => dataRecoveryApi.list(),
  });

  const items = recoveryQuery.data?.items ?? [];
  const companies = useMemo(() => {
    const entries = new Map<string, string>();
    for (const company of allCompanies) {
      entries.set(company.id, company.name);
    }
    for (const item of items) {
      if (item.companyId && item.companyName) entries.set(item.companyId, item.companyName);
    }
    return [...entries.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allCompanies, items]);

  const filteredItems = useMemo(
    () =>
      items.filter((item) => {
        if (typeFilter !== "all" && item.type !== typeFilter) return false;
        if (companyFilter !== "all" && item.companyId !== companyFilter) return false;
        return true;
      }),
    [companyFilter, items, typeFilter],
  );

  const restoreMutation = useMutation({
    mutationFn: (item: DataRecoveryItem) => dataRecoveryApi.restore(item.type, item.id),
    onSuccess: async (response) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.dataRecovery }),
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
      ]);
      if (response.item.companyId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(response.item.companyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(response.item.companyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(response.item.companyId) }),
        ]);
      }
      pushToast({ title: "Item restored", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to restore item",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const detailsMutation = useMutation({
    mutationFn: (item: DataRecoveryItem) => dataRecoveryApi.details(item.type, item.id),
    onSuccess: (response) => setDetail(response),
    onError: (error) => {
      pushToast({
        title: "Failed to inspect item",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (item: DataRecoveryItem) => dataRecoveryApi.deletePermanent(item.type, item.id),
    onSuccess: async () => {
      setDeleteCandidate(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.dataRecovery });
      pushToast({ title: "Item permanently deleted", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete item",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ item, name }: { item: DataRecoveryItem; name: string }) =>
      dataRecoveryApi.renameAgent(item.id, name),
    onSuccess: async () => {
      setRenameCandidate(null);
      setRenameValue("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.dataRecovery });
      pushToast({ title: "Agent renamed", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to rename agent",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ArchiveRestore className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Data Recovery</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Review archived, hidden, or terminated records that still exist in the database and restore them when needed.
        </p>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap gap-3">
          <label className="space-y-1.5 text-sm">
            <span className="block font-medium">Type</span>
            <select
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              value={typeFilter}
              onChange={(event) => setTypeFilter(getTypeValue(event.currentTarget.value))}
            >
              <option value="all">All types</option>
              <option value="company">Companies</option>
              <option value="agent">Agents</option>
              <option value="project">Projects</option>
              <option value="issue">Issues</option>
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span className="block font-medium">Company</span>
            <select
              className="h-9 rounded-md border border-border bg-background px-3 text-sm"
              value={companyFilter}
              onChange={(event) => setCompanyFilter(event.currentTarget.value)}
            >
              <option value="all">All companies</option>
              {companies.map(([companyId, companyName]) => (
                <option key={companyId} value={companyId}>
                  {companyName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        {recoveryQuery.isLoading ? (
          <div className="p-5 text-sm text-muted-foreground">Loading recoverable items...</div>
        ) : recoveryQuery.error ? (
          <div className="p-5 text-sm text-destructive">
            {recoveryQuery.error instanceof Error
              ? recoveryQuery.error.message
              : "Failed to load recoverable items."}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">
            No recoverable items match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Item</th>
                  <th className="px-4 py-3 text-left font-medium">ID</th>
                  <th className="px-4 py-3 text-left font-medium">Type</th>
                  <th className="px-4 py-3 text-left font-medium">State</th>
                  <th className="px-4 py-3 text-left font-medium">Company</th>
                  <th className="px-4 py-3 text-left font-medium">Removed</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredItems.map((item) => (
                  <tr key={`${item.type}:${item.id}`} className="align-top">
                    <td className="max-w-md px-4 py-3">
                      <div className="font-medium text-foreground">{item.name}</div>
                      {item.projectName && item.type !== "project" ? (
                        <div className="mt-1 text-xs text-muted-foreground">Project: {item.projectName}</div>
                      ) : null}
                      {item.restoreBlockedReason ? (
                        <div className="mt-1 max-w-sm text-xs text-amber-700 dark:text-amber-300">
                          <span>{item.restoreBlockedReason}</span>
                          {item.type === "agent" ? (
                            <button
                              type="button"
                              className="ml-2 font-medium underline underline-offset-2"
                              onClick={() => {
                                setRenameCandidate(item);
                                setRenameValue(`${item.name} ${shortId(item.id)}`);
                              }}
                            >
                              Rename
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs" title={item.id}>
                        {shortId(item.id)}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{typeLabels[item.type]}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={item.state} />
                    </td>
                    <td className="px-4 py-3">
                      <div>{item.companyName ?? "-"}</div>
                      {item.companyStatus === "archived" ? (
                        <div className="mt-1">
                          <StatusBadge status="archived" />
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(item.removedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => detailsMutation.mutate(item)}
                          disabled={detailsMutation.isPending}
                        >
                          <Search className="mr-1.5 h-3.5 w-3.5" />
                          Inspect
                        </Button>
                        {item.href ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link to={item.href}>
                              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                              Open
                            </Link>
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          onClick={() => restoreMutation.mutate(item)}
                          disabled={restoreMutation.isPending || Boolean(item.restoreBlockedReason)}
                          title={item.restoreBlockedReason ?? undefined}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          Restore
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => setDeleteCandidate(item)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          Delete forever
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog open={Boolean(detail)} onOpenChange={(open) => {
        if (!open) setDetail(null);
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Recoverable item details</DialogTitle>
            <DialogDescription>
              Inspect the stored record without using the normal route, which may resolve to a replacement item.
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium text-foreground">{detail.item.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge status={detail.item.state} />
                  <span>{typeLabels[detail.item.type]}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5">{detail.item.id}</code>
                </div>
              </div>
              <div className="max-h-[55vh] overflow-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-border">
                    {detail.details.map((field) => (
                      <tr key={field.label}>
                        <th className="w-40 px-3 py-2 text-left align-top font-medium text-muted-foreground">
                          {field.label}
                        </th>
                        <td className="px-3 py-2 align-top">
                          {field.value === null || field.value === "" ? (
                            <span className="text-muted-foreground">-</span>
                          ) : (
                            <span className="break-all">{String(field.value)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(renameCandidate)} onOpenChange={(open) => {
        if (!open) {
          setRenameCandidate(null);
          setRenameValue("");
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename terminated agent</DialogTitle>
            <DialogDescription>
              Change the stored agent name by ID so it no longer conflicts with a non-terminated replacement.
            </DialogDescription>
          </DialogHeader>
          {renameCandidate ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
                <div className="font-medium">{renameCandidate.name}</div>
                <div className="mt-1 text-muted-foreground">
                  Agent · {shortId(renameCandidate.id)} · {renameCandidate.companyName ?? "No company"}
                </div>
              </div>
              <label className="space-y-1.5 text-sm">
                <span className="block font-medium">New name</span>
                <Input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.currentTarget.value)}
                  autoFocus
                />
              </label>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRenameCandidate(null);
                setRenameValue("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (renameCandidate) renameMutation.mutate({ item: renameCandidate, name: renameValue });
              }}
              disabled={renameMutation.isPending || renameValue.trim().length === 0}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {renameMutation.isPending ? "Renaming..." : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteCandidate)} onOpenChange={(open) => {
        if (!open) setDeleteCandidate(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete recoverable item?</DialogTitle>
            <DialogDescription>
              This removes the stored record and its dependent data where the existing delete service supports it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {deleteCandidate ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <div className="font-medium">{deleteCandidate.name}</div>
              <div className="mt-1 text-muted-foreground">
                {typeLabels[deleteCandidate.type]} · {shortId(deleteCandidate.id)} · {deleteCandidate.companyName ?? "No company"}
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteCandidate(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteCandidate) deleteMutation.mutate(deleteCandidate);
              }}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete forever"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
