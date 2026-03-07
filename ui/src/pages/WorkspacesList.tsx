import { useEffect, useMemo, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FolderOpen, Plus, Trash2 } from "lucide-react";

export function WorkspacesList() {
  const { companyPrefix, projectId } = useParams<{
    companyPrefix?: string;
    projectId: string;
  }>();
  const { companies, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const prefix = companyPrefix.toUpperCase();
    return companies.find((c) => c.issuePrefix.toUpperCase() === prefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;

  const { data: project } = useQuery({
    queryKey: [...queryKeys.projects.detail(projectId ?? ""), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(projectId!, lookupCompanyId),
    enabled: !!projectId,
  });

  const { data: workspaces, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.workspaces(projectId ?? ""),
    queryFn: () => projectsApi.listWorkspaces(projectId!, lookupCompanyId),
    enabled: !!projectId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? projectId ?? "Project", href: `/projects/${projectId}` },
      { label: "Workspaces" },
    ]);
  }, [setBreadcrumbs, project, projectId]);

  const invalidateWorkspaces = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.workspaces(projectId!) });
  };

  const createWorkspace = useMutation({
    mutationFn: (data: { name: string; cwd: string }) =>
      projectsApi.createWorkspace(projectId!, data, lookupCompanyId),
    onSuccess: () => {
      setCreateOpen(false);
      setNewName("");
      setNewPath("");
      setFormError(null);
      invalidateWorkspaces();
    },
    onError: () => {
      setFormError("Failed to create workspace. Please try again.");
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(projectId!, workspaceId, lookupCompanyId),
    onSuccess: invalidateWorkspaces,
  });

  const handleCreate = () => {
    const name = newName.trim();
    const path = newPath.trim();
    if (!name) {
      setFormError("Name is required.");
      return;
    }
    if (!path) {
      setFormError("Path is required.");
      return;
    }
    setFormError(null);
    createWorkspace.mutate({ name, cwd: path });
  };

  const handleDelete = (workspaceId: string, workspaceName: string) => {
    if (!window.confirm(`Delete workspace "${workspaceName}"?`)) return;
    removeWorkspace.mutate(workspaceId);
  };

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          New Workspace
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {workspaces && workspaces.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          message="No workspaces yet."
          action="New Workspace"
          onAction={() => setCreateOpen(true)}
        />
      )}

      {workspaces && workspaces.length > 0 && (
        <div className="border border-border">
          {workspaces.map((ws) => (
            <EntityRow
              key={ws.id}
              title={ws.name}
              subtitle={ws.cwd ?? ws.repoUrl ?? "No path"}
              to={`/projects/${projectId}/workspaces/${ws.id}`}
              trailing={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDelete(ws.id, ws.name);
                  }}
                  aria-label={`Delete workspace ${ws.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              }
            />
          ))}
        </div>
      )}

      {removeWorkspace.isError && (
        <p className="text-sm text-destructive">Failed to delete workspace.</p>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setNewName("");
            setNewPath("");
            setFormError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Workspace</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Name</label>
              <input
                className="w-full rounded border border-border bg-transparent px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="my-workspace"
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Filesystem Path</label>
              <input
                className="w-full rounded border border-border bg-transparent px-3 py-1.5 text-sm font-mono outline-none focus:ring-1 focus:ring-ring"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/absolute/path/to/workspace"
              />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={createWorkspace.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
