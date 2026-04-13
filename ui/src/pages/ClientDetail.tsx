import { useEffect, useState } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Client, ClientProject } from "@paperclipai/shared";
import { CLIENT_STATUSES } from "@paperclipai/shared";
import { clientsApi } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { LinkClientProjectDialog } from "../components/LinkClientProjectDialog";
import { Card, CardHeader, CardTitle, CardContent, CardAction } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Pencil, FolderOpen } from "lucide-react";

export function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ClientProject | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string | null>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: client, isLoading } = useQuery({
    queryKey: queryKeys.clients.detail(clientId!),
    queryFn: () => clientsApi.get(clientId!),
    enabled: !!clientId,
  });

  const { data: clientProjects } = useQuery({
    queryKey: queryKeys.clients.projects(clientId!),
    queryFn: () => clientsApi.listProjects(clientId!),
    enabled: !!clientId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Clients", href: "/clients" },
      { label: client?.name ?? "..." },
    ]);
  }, [setBreadcrumbs, client?.name]);

  const updateClient = useMutation({
    mutationFn: (data: Record<string, unknown>) => clientsApi.update(clientId!, data),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.clients.detail(clientId!) });
      const previous = queryClient.getQueryData<Client>(queryKeys.clients.detail(clientId!));
      if (previous) {
        queryClient.setQueryData(queryKeys.clients.detail(clientId!), { ...previous, ...data });
      }
      setEditing(false);
      return { previous };
    },
    onError: (_err, _data, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.clients.detail(clientId!), ctx.previous);
      }
      setEditing(true);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.detail(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId!) });
    },
  });

  const deleteClient = useMutation({
    mutationFn: () => clientsApi.remove(clientId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId!) });
      navigate("/clients");
    },
  });

  const deleteClientProject = useMutation({
    mutationFn: (id: string) => clientsApi.removeProject(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.clients.projects(clientId!) });
      const previous = queryClient.getQueryData<ClientProject[]>(queryKeys.clients.projects(clientId!));
      if (previous) {
        queryClient.setQueryData(
          queryKeys.clients.projects(clientId!),
          previous.filter((cp) => cp.id !== id),
        );
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(queryKeys.clients.projects(clientId!), ctx.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.projects(clientId!) });
    },
  });

  if (isLoading || !client) {
    return <PageSkeleton variant="detail" />;
  }

  function startEditing() {
    setEditForm({
      name: client!.name,
      email: client!.email ?? "",
      cnpj: client!.cnpj ?? "",
      phone: client!.phone ?? "",
      contactName: client!.contactName ?? "",
      notes: client!.notes ?? "",
      status: client!.status,
    });
    setEditing(true);
  }

  function handleSave() {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(editForm)) {
      patch[key] = value === "" ? null : value;
    }
    if (editForm.name) patch.name = editForm.name;
    updateClient.mutate(patch);
  }

  function formatCurrency(cents: number | null) {
    if (cents == null) return "-";
    return `R$ ${(cents / 100).toFixed(2)}`;
  }

  return (
    <div className="space-y-6">
      {/* Client Info */}
      <Card>
        <CardHeader>
          <CardTitle>{client.name}</CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              <StatusBadge status={client.status} />
              {!editing && (
                <Button size="sm" variant="ghost" onClick={startEditing}>
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  Edit
                </Button>
              )}
            </div>
          </CardAction>
        </CardHeader>

        <CardContent>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={editForm.name ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input
                    value={editForm.email ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>CNPJ</Label>
                  <Input
                    value={editForm.cnpj ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, cnpj: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input
                    value={editForm.phone ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Contact Name</Label>
                  <Input
                    value={editForm.contactName ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, contactName: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={editForm.status ?? "active"}
                    onValueChange={(value) => setEditForm({ ...editForm, status: value })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CLIENT_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={editForm.notes ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                />
              </div>
              <div className="flex items-center gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                <Button size="sm" onClick={handleSave} disabled={!editForm.name?.trim() || updateClient.isPending}>
                  {updateClient.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
              {updateClient.isError && (
                <p className="text-xs text-destructive">Failed to update client.</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {client.email && (
                <div className="flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">Email</span>
                  <span className="text-sm">{client.email}</span>
                </div>
              )}
              {client.cnpj && (
                <div className="flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">CNPJ</span>
                  <span className="text-sm">{client.cnpj}</span>
                </div>
              )}
              {client.phone && (
                <div className="flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">Phone</span>
                  <span className="text-sm">{client.phone}</span>
                </div>
              )}
              {client.contactName && (
                <div className="flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">Contact</span>
                  <span className="text-sm">{client.contactName}</span>
                </div>
              )}
              {client.notes && (
                <div className="flex items-baseline gap-3">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">Notes</span>
                  <span className="text-sm whitespace-pre-wrap">{client.notes}</span>
                </div>
              )}
              {!client.email && !client.cnpj && !client.phone && !client.contactName && !client.notes && (
                <p className="text-sm text-muted-foreground">No additional details.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Client Projects */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked Projects</CardTitle>
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => { setEditingProject(null); setLinkDialogOpen(true); }}>
              <Plus className="h-4 w-4 mr-1" />
              Link Project
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent>
          {(clientProjects ?? []).length === 0 && (
            <EmptyState
              icon={FolderOpen}
              message="No projects linked to this client."
              action="Link Project"
              onAction={() => { setEditingProject(null); setLinkDialogOpen(true); }}
            />
          )}

          {(clientProjects ?? []).length > 0 && (
            <div className="border border-border rounded-lg divide-y divide-border">
              {clientProjects!.map((cp: ClientProject) => (
                <div key={cp.id} className="p-3 hover:bg-accent/30 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">
                          {cp.projectNameOverride || cp.projectName || "Unnamed project"}
                        </span>
                        <StatusBadge status={cp.status} />
                        {cp.projectType && (
                          <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                            {cp.projectType}
                          </span>
                        )}
                      </div>
                      {cp.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{cp.description}</p>
                      )}
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {cp.billingType && (
                          <span>{cp.billingType === "monthly" ? "Monthly" : "One-time"}: {formatCurrency(cp.amountCents)}</span>
                        )}
                        {cp.startDate && <span>Start: {formatDate(cp.startDate)}</span>}
                        {cp.endDate && <span>End: {formatDate(cp.endDate)}</span>}
                        {cp.lastPaymentAt && <span>Last payment: {formatDate(cp.lastPaymentAt)}</span>}
                      </div>
                      {cp.tags.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {cp.tags.map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => { setEditingProject(cp); setLinkDialogOpen(true); }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => deleteClientProject.mutate(cp.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          {!confirmDelete ? (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete Client
            </Button>
          ) : (
            <div className="flex items-center justify-between bg-destructive/5 border border-destructive/20 rounded-md px-4 py-3">
              <p className="text-sm text-destructive font-medium">
                Delete this client and all linked projects? This cannot be undone.
              </p>
              <div className="flex items-center gap-2 ml-4 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)} disabled={deleteClient.isPending}>
                  Cancel
                </Button>
                <Button variant="destructive" size="sm" onClick={() => deleteClient.mutate()} disabled={deleteClient.isPending}>
                  {deleteClient.isPending ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <LinkClientProjectDialog
        open={linkDialogOpen}
        onOpenChange={(open) => {
          setLinkDialogOpen(open);
          if (!open) setEditingProject(null);
        }}
        clientId={clientId!}
        companyId={selectedCompanyId!}
        editingProject={editingProject ?? undefined}
      />
    </div>
  );
}
