import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ClientProject } from "@paperclipai/shared";
import { CLIENT_STATUSES } from "@paperclipai/shared";
import { clientsApi } from "../api/clients";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { projectUrl } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { LinkClientProjectDialog } from "../components/LinkClientProjectDialog";
import { InstructionsBundleEditor } from "../components/InstructionsBundleEditor";
import { Card, CardHeader, CardTitle, CardContent, CardAction } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

type ClientDetailTab = "overview" | "projects" | "instructions";

function PropertyRow({
  label,
  children,
  alignStart = false,
}: {
  label: ReactNode;
  children: ReactNode;
  alignStart?: boolean;
}) {
  return (
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-28 mt-0.5 text-xs text-muted-foreground">{label}</div>
      <div className={cn("min-w-0 flex-1 text-sm", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap")}>
        {children}
      </div>
    </div>
  );
}

export function ClientDetail() {
  const { clientId } = useParams<{ clientId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<ClientDetailTab>("overview");
  const [editing, setEditing] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<ClientProject | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string | null>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedInstructionsFile, setSelectedInstructionsFile] = useState("CLIENT.md");

  const { data: client, isLoading } = useQuery({
    queryKey: queryKeys.clients.detail(clientId!),
    queryFn: () => clientsApi.get(clientId!),
    enabled: !!clientId,
  });

  const {
    data: clientProjects,
    isLoading: projectsLoading,
  } = useQuery({
    queryKey: queryKeys.clients.projects(clientId!),
    queryFn: () => clientsApi.listProjects(clientId!),
    enabled: !!clientId && activeTab === "projects",
  });

  const {
    data: instructionsBundle,
    isLoading: instructionsLoading,
  } = useQuery({
    queryKey: queryKeys.clients.instructionsBundle(clientId!),
    queryFn: () => clientsApi.instructionsBundle(clientId!),
    enabled: !!clientId && activeTab === "instructions",
  });

  const { data: instructionsFileDetail, isLoading: instructionsFileLoading } = useQuery({
    queryKey: queryKeys.clients.instructionsFile(clientId!, selectedInstructionsFile),
    queryFn: () => clientsApi.instructionsFile(clientId!, selectedInstructionsFile),
    enabled:
      !!clientId
      && activeTab === "instructions"
      && !!instructionsBundle?.files.some((file) => file.path === selectedInstructionsFile),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Clients", href: "/clients" },
      { label: client?.name ?? "..." },
    ]);
  }, [setBreadcrumbs, client?.name]);

  const updateClient = useMutation({
    mutationFn: (data: Record<string, unknown>) => clientsApi.update(clientId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.detail(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId!) });
      setEditing(false);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.projects(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.detail(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.list(selectedCompanyId!) });
    },
  });

  const saveInstructionsFile = useMutation({
    mutationFn: (data: { path: string; content: string }) =>
      clientsApi.saveInstructionsFile(clientId!, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.instructionsBundle(clientId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.instructionsFile(clientId!, variables.path) });
    },
  });

  const deleteInstructionsFile = useMutation({
    mutationFn: (relativePath: string) =>
      clientsApi.deleteInstructionsFile(clientId!, relativePath),
    onSuccess: (_, relativePath) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clients.instructionsBundle(clientId!) });
      queryClient.removeQueries({ queryKey: queryKeys.clients.instructionsFile(clientId!, relativePath) });
    },
  });

  if (isLoading || !client) {
    return <PageSkeleton variant="detail" />;
  }
  const currentClient = client;

  function startEditing() {
    setEditForm({
      name: currentClient.name,
      email: currentClient.email ?? "",
      phone: currentClient.phone ?? "",
      contactName: currentClient.contactName ?? "",
      cnpj: currentClient.metadata?.cnpj ?? "",
      notes: currentClient.notes ?? "",
      status: currentClient.status,
    });
    setEditing(true);
  }

  function handleSave() {
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(editForm)) {
      if (key === "cnpj") continue; // handled separately via metadata
      patch[key] = value === "" ? null : value;
    }
    if (editForm.name) patch.name = editForm.name.trim();
    const cnpjValue = editForm.cnpj?.trim() || null;
    patch.metadata = { ...(currentClient.metadata ?? {}), cnpj: cnpjValue ?? undefined };
    updateClient.mutate(patch);
  }

  return (
    <div className="space-y-6 max-w-4xl">

      {/* Page header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-xl font-bold">{currentClient.name}</h2>
          <p className="text-sm text-muted-foreground">Client relationship record</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && (
            <Button size="sm" variant="ghost" onClick={startEditing}>
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Edit
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ClientDetailTab)}>
        <PageTabBar
          items={[
            { value: "overview", label: "Overview" },
            { value: "projects", label: "Projects" },
            { value: "instructions", label: "Instructions" },
          ]}
          align="start"
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as ClientDetailTab)}
        />

        {/* Overview tab */}
        <TabsContent value="overview" className="space-y-0 mt-4">
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input
                    value={editForm.name ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
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
                      {CLIENT_STATUSES.map((status) => (
                        <SelectItem key={status} value={status}>
                          {status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Primary contact</Label>
                  <Input
                    value={editForm.contactName ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, contactName: e.target.value })}
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
                  <Label>Phone</Label>
                  <Input
                    value={editForm.phone ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>CNPJ</Label>
                  <Input
                    value={editForm.cnpj ?? ""}
                    onChange={(e) => setEditForm({ ...editForm, cnpj: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={editForm.notes ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  placeholder="Relationship context, communication preferences, or operator reminders..."
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!editForm.name?.trim() || updateClient.isPending}
                >
                  {updateClient.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
              {updateClient.isError ? (
                <p className="text-xs text-destructive">Failed to update client.</p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-1 pb-4">
              <PropertyRow label="Name">{currentClient.name}</PropertyRow>
              <PropertyRow label="Status">
                <StatusBadge status={currentClient.status} />
              </PropertyRow>
              <PropertyRow label="Contact">
                {currentClient.contactName ?? (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </PropertyRow>
              <PropertyRow label="Email">
                {currentClient.email ?? (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </PropertyRow>
              <PropertyRow label="Phone">
                {currentClient.phone ?? (
                  <span className="text-muted-foreground">Not set</span>
                )}
              </PropertyRow>
              {currentClient.metadata?.cnpj && (
                <PropertyRow label="CNPJ">{currentClient.metadata.cnpj}</PropertyRow>
              )}
              <PropertyRow label="Notes" alignStart>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {currentClient.notes?.trim() || "No notes added yet."}
                </p>
              </PropertyRow>
            </div>
          )}
        </TabsContent>

        {/* Projects tab */}
        <TabsContent value="projects" className="space-y-6 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Linked Projects</CardTitle>
              <CardAction>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditingProject(null);
                    setLinkDialogOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Link Project
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {projectsLoading ? (
                <PageSkeleton variant="list" />
              ) : null}

              {!projectsLoading && (clientProjects ?? []).length === 0 ? (
                <EmptyState
                  icon={FolderOpen}
                  message="No projects linked to this client."
                  action="Link Project"
                  onAction={() => {
                    setEditingProject(null);
                    setLinkDialogOpen(true);
                  }}
                />
              ) : null}

              {!projectsLoading && (clientProjects ?? []).length > 0 ? (
                <div className="rounded-lg border border-border divide-y divide-border">
                  {clientProjects!.map((project) => (
                    <div key={project.id} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <Link
                            to={projectUrl({
                              id: project.projectId,
                              name: project.projectName ?? project.projectNameOverride ?? "project",
                            })}
                            className="truncate text-sm font-medium hover:underline"
                          >
                            {project.projectNameOverride || project.projectName || "Unnamed project"}
                          </Link>
                          <StatusBadge status={project.status} />
                        </div>
                        {project.description ? (
                          <p className="text-sm text-muted-foreground">{project.description}</p>
                        ) : null}
                        {(project.tags ?? []).length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {project.tags.map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            setEditingProject(project);
                            setLinkDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => deleteClientProject.mutate(project.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Instructions tab */}
        <TabsContent value="instructions" className="space-y-6 mt-4">
          <InstructionsBundleEditor
            title="Client Instructions"
            description="Markdown files applied when agents run work for projects linked to this client. The entry file (CLIENT.md) is included alongside company and agent instructions."
            files={instructionsBundle?.files ?? []}
            entryFile={instructionsBundle?.entryFile ?? "CLIENT.md"}
            loading={instructionsLoading}
            fileDetail={instructionsFileDetail}
            fileLoading={instructionsFileLoading}
            savePending={saveInstructionsFile.isPending}
            deletePending={deleteInstructionsFile.isPending}
            selectedFile={selectedInstructionsFile}
            onSelectedFileChange={setSelectedInstructionsFile}
            emptyMessage="No client instructions yet. Create a CLIENT.md file to add per-client instructions for linked project runs."
            emptyAction="Create CLIENT.md"
            emptyFilePath="CLIENT.md"
            emptyFileContent=""
            editorHeight="32rem"
            onSaveFile={(data, opts) => {
              saveInstructionsFile.mutate(data, {
                onSuccess: () => {
                  opts?.onSuccess?.();
                },
              });
            }}
            onDeleteFile={(relativePath) => deleteInstructionsFile.mutate(relativePath)}
          />
        </TabsContent>
      </Tabs>

      {/* Danger Zone */}
      <Separator className="my-4" />
      <div className="space-y-4 py-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Permanently delete this client and all linked project relationships. This cannot be undone.
          </p>
          {!confirmDelete ? (
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-3 w-3 mr-1" />
              Delete client
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-destructive">
                Delete &ldquo;{currentClient.name}&rdquo;?
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => deleteClient.mutate()}
                disabled={deleteClient.isPending}
              >
                {deleteClient.isPending ? "Deleting..." : "Confirm"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmDelete(false)}
                disabled={deleteClient.isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>

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
