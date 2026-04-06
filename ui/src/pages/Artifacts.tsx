import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { artifactsApi, type Artifact } from "../api/artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { ArtifactCard } from "../components/ArtifactCard";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { FileBox, Plus, Filter } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const KIND_OPTIONS = ["all", "attachment", "image", "link", "package"] as const;

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Artifacts" }]);
  }, [setBreadcrumbs]);

  const { data: artifacts, isLoading, error } = useQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!),
    queryFn: () => artifactsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => artifactsApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.list(selectedCompanyId!) });
      pushToast({ title: "Artifact deleted", tone: "info" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to delete artifact", body: err.message, tone: "error" });
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => artifactsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.list(selectedCompanyId!) });
      setShowCreateForm(false);
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      title: formData.get("title") as string,
      kind: formData.get("kind") as string || "attachment",
      description: formData.get("description") as string || undefined,
      url: formData.get("url") as string || undefined,
      filePath: formData.get("filePath") as string || undefined,
      previewUrl: formData.get("previewUrl") as string || undefined,
      mimeType: formData.get("mimeType") as string || undefined,
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={FileBox} message="Select a company to view artifacts." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = artifacts
    ? kindFilter === "all"
      ? artifacts
      : artifacts.filter((a) => a.kind === kindFilter)
    : [];

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {artifacts && artifacts.length === 0 && !showCreateForm && (
        <div className="flex flex-col items-center gap-4 py-12">
          <FileBox className="h-12 w-12 text-muted-foreground/40" />
          <h2 className="text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Artifacts</h2>
          <p className="text-sm text-muted-foreground max-w-lg text-center">
            Artifacts are files, documents, code outputs, and resources produced by your agents during task execution.
            They provide a centralized place to track everything your AI workforce creates.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl text-xs text-muted-foreground">
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Code & Files</p>
              <p>Generated source code, configs, scripts produced by agents</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Reports & Docs</p>
              <p>Analysis reports, documentation, research outputs</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Attachments</p>
              <p>Images, PDFs, spreadsheets, and other file attachments</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Artifact
          </Button>
        </div>
      )}

      {(artifacts && artifacts.length > 0 || showCreateForm) && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Filter className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="flex gap-1">
                {KIND_OPTIONS.map((kind) => (
                  <Button
                    key={kind}
                    size="sm"
                    variant={kindFilter === kind ? "default" : "outline"}
                    className="text-xs capitalize"
                    onClick={() => setKindFilter(kind)}
                  >
                    {kind}
                  </Button>
                ))}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Artifact
            </Button>
          </div>

          {showCreateForm && (
            <form onSubmit={handleCreate} className="rounded-[2px] border border-border bg-card p-4 space-y-3 hud-panel hud-shimmer">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Title *</label>
                  <input
                    name="title"
                    required
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="Artifact title"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Kind</label>
                  <select
                    name="kind"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  >
                    <option value="attachment">Attachment</option>
                    <option value="image">Image</option>
                    <option value="link">Link</option>
                    <option value="package">Package</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <input
                  name="description"
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  placeholder="Optional description"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">URL</label>
                  <input
                    name="url"
                    type="url"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="https://..."
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">File Path</label>
                  <input
                    name="filePath"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="/path/to/file"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Preview URL</label>
                  <input
                    name="previewUrl"
                    type="url"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="https://preview..."
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">MIME Type</label>
                  <input
                    name="mimeType"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="e.g. application/pdf"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setShowCreateForm(false)}>
                  Cancel
                </Button>
              </div>
              {createMutation.error && (
                <p className="text-xs text-destructive">{createMutation.error.message}</p>
              )}
            </form>
          )}

          <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete artifact</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this artifact? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-white hover:bg-destructive/90"
                  onClick={() => {
                    if (deleteTarget) deleteMutation.mutate(deleteTarget);
                    setDeleteTarget(null);
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="space-y-2">
            {filtered.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                onDelete={(id) => setDeleteTarget(id)}
              />
            ))}
            {filtered.length === 0 && artifacts && artifacts.length > 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No artifacts match the selected filter.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
