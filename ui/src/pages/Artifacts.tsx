import { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Artifact, ArtifactFolderTreeNode } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { artifactsApi } from "@/api/artifacts";
import { ArtifactFolderTree } from "@/components/artifacts/ArtifactFolderTree";
import { ArtifactFileList } from "@/components/artifacts/ArtifactFileList";
import { ArtifactToolbar } from "@/components/artifacts/ArtifactToolbar";
import { EmptyState } from "@/components/EmptyState";
import { FolderOpen } from "lucide-react";

export function Artifacts() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { folderId: urlFolderId } = useParams<{ folderId?: string }>();
  const [searchParams] = useSearchParams();
  const issueIdFilter = searchParams.get("issueId") ?? undefined;
  const queryClient = useQueryClient();

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(urlFolderId ?? null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Artifacts" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    if (urlFolderId) setSelectedFolderId(urlFolderId);
  }, [urlFolderId]);

  // Fetch folder tree
  const { data: tree = [] } = useQuery({
    queryKey: queryKeys.artifacts.tree(selectedCompanyId!),
    queryFn: () => artifactsApi.tree(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch artifacts for selected folder (or filtered by issueId)
  const { data: artifacts = [], isLoading: artifactsLoading } = useQuery({
    queryKey: queryKeys.artifacts.list(selectedCompanyId!, selectedFolderId ?? issueIdFilter ?? undefined),
    queryFn: () =>
      artifactsApi.list(selectedCompanyId!, {
        folderId: issueIdFilter ? undefined : selectedFolderId ?? undefined,
        issueId: issueIdFilter,
        search: search || undefined,
      }),
    enabled: !!selectedCompanyId,
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["artifacts"] });
  }, [queryClient]);

  // Mutations
  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      artifactsApi.upload(selectedCompanyId!, file, {
        folderId: selectedFolderId ?? undefined,
      }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => artifactsApi.remove(id),
    onSuccess: invalidate,
  });

  const deleteFolderMutation = useMutation({
    mutationFn: ({ id, recursive }: { id: string; recursive: boolean }) =>
      artifactsApi.removeFolder(id, recursive),
    onSuccess: invalidate,
  });

  const handleCreateFolder = useCallback(
    async (parentId: string | null) => {
      const name = prompt("Folder name:");
      if (!name?.trim()) return;
      await artifactsApi.createFolder(selectedCompanyId!, {
        parentId: parentId ?? undefined,
        name: name.trim(),
      });
      invalidate();
    },
    [selectedCompanyId, invalidate],
  );

  const handleRenameFolder = useCallback(
    async (folder: ArtifactFolderTreeNode) => {
      const name = prompt("New folder name:", folder.name);
      if (!name?.trim() || name === folder.name) return;
      await artifactsApi.updateFolder(folder.id, { name: name.trim() });
      invalidate();
    },
    [invalidate],
  );

  const handleDeleteFolder = useCallback(
    (folder: ArtifactFolderTreeNode) => {
      const hasContents = folder.fileCount > 0 || folder.children.length > 0;
      const msg = hasContents
        ? `Delete folder "${folder.name}" and all its contents?`
        : `Delete empty folder "${folder.name}"?`;
      if (!confirm(msg)) return;
      deleteFolderMutation.mutate({ id: folder.id, recursive: hasContents });
      if (selectedFolderId === folder.id) setSelectedFolderId(null);
    },
    [deleteFolderMutation, selectedFolderId],
  );

  const handleRenameArtifact = useCallback(
    async (artifact: Artifact) => {
      const name = prompt("New name:", artifact.title);
      if (!name?.trim() || name === artifact.title) return;
      await artifactsApi.update(artifact.id, { title: name.trim() });
      invalidate();
    },
    [invalidate],
  );

  const handleMoveArtifact = useCallback(
    async (artifact: Artifact) => {
      const folderPath = prompt("Enter destination folder path (e.g. /reports/weekly/):");
      if (!folderPath?.trim()) return;
      const folder = await artifactsApi.createFolder(selectedCompanyId!, { path: folderPath.trim() });
      await artifactsApi.update(artifact.id, { folderId: folder.id });
      invalidate();
    },
    [selectedCompanyId, invalidate],
  );

  const handleDeleteArtifact = useCallback(
    (artifact: Artifact) => {
      if (!confirm(`Delete "${artifact.title}"?`)) return;
      deleteMutation.mutate(artifact.id);
    },
    [deleteMutation],
  );

  const handleOpenInFinder = useCallback(async (artifact: Artifact) => {
    try {
      const result = await artifactsApi.getLocalPath(artifact.id);
      // Copy the path to clipboard since we can't directly open Finder from the browser
      await navigator.clipboard.writeText(result.path);
      alert(`Path copied to clipboard:\n${result.path}`);
    } catch {
      alert("Could not get local path. File may not be stored locally.");
    }
  }, []);

  if (!selectedCompanyId) {
    return <EmptyState icon={FolderOpen} message="Select a company to view artifacts" />;
  }

  return (
    <div className="flex h-full">
      <div className="w-64 flex-shrink-0">
        <ArtifactFolderTree
          tree={tree}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
        />
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        <ArtifactToolbar
          search={search}
          onSearchChange={setSearch}
          onCreateFolder={() => handleCreateFolder(selectedFolderId)}
          onUpload={(file) => uploadMutation.mutate(file)}
        />
        <ArtifactFileList
          artifacts={artifacts}
          isLoading={artifactsLoading}
          onRename={handleRenameArtifact}
          onMove={handleMoveArtifact}
          onDelete={handleDeleteArtifact}
          onOpenInFinder={handleOpenInFinder}
        />
      </div>
    </div>
  );
}
