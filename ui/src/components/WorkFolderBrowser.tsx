import { useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderPlus, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import type { WorkFile, WorkFolderOwner } from "@paperclipai/shared";
import { workFoldersApi } from "@/api/work-folders";
import { FileTree, collectAllPaths, type FileTreeNode } from "@/components/FileTree";
import { FileContentViewer } from "@/components/FileViewerSheet";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Link } from "@/lib/router";

function tree(files: WorkFile[]) {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const file of files) {
    let parent = root;
    const parts = file.path.split("/");
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      let node = parent.children.find((child) => child.name === name);
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join("/"), kind: i < parts.length - 1 || file.kind === "directory" ? "dir" : "file", children: [] };
        parent.children.push(node);
      }
      parent = node;
    }
  }
  function sort(nodes: FileTreeNode[]) { nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)); nodes.forEach((node) => sort(node.children)); }
  sort(root.children); return root.children;
}

export function WorkFolderBrowser({ owner, exampleFiles, readOnly = false, fillHeight = false, allowTrashActions = false }: { owner: WorkFolderOwner; exampleFiles?: WorkFile[]; readOnly?: boolean; fillHeight?: boolean; allowTrashActions?: boolean }) {
  const queryClient = useQueryClient();
  const [trash, setTrash] = useState(false);
  const [checkedFiles, setCheckedFiles] = useState(new Set<string>());
  const canManageTrash = !readOnly || allowTrashActions;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [directory, setDirectory] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const directoryId = useId();
  const key = ["work-folders", owner.companyId, owner.scope, owner.ownerId];
  const filesQuery = useQuery({ queryKey: [...key, "files", trash], queryFn: () => workFoldersApi.list(owner, trash),
    enabled: !exampleFiles, refetchInterval: 15_000, retry: false });
  const syncQuery = useQuery({ queryKey: [...key, "sync"], queryFn: () => workFoldersApi.sync(owner), enabled: !exampleFiles, refetchInterval: 5000, retry: false });
  const files = exampleFiles ?? filesQuery.data?.files ?? [];
  const selected = files.find((file) => file.path === selectedPath);
  const nodes = useMemo(() => tree(files), [files]);
  const availablePaths = collectAllPaths(nodes);
  const checkedPaths = [...checkedFiles].filter((path) => availablePaths.has(path));
  const checkedPathSet = new Set(checkedPaths);
  const deletePaths = checkedPaths.filter((path) => {
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (checkedPathSet.has(parent)) return false;
    }
    return true;
  });
  const filePaths = new Set(files.filter((file) => file.kind === "file").map((file) => file.path));
  const selectionLabel = deletePaths.every((path) => filePaths.has(path)) ? "file" : "item";
  const preview = useQuery({ queryKey: [...key, "preview", selected?.path, selected?.sha256],
    queryFn: () => workFoldersApi.preview(owner, selected!), enabled: !exampleFiles && !trash && selected?.kind === "file", retry: false });
  const mutation = useMutation({ mutationFn: async (action: { type: "upload"; files: File[] } | { type: "mkdir" } | { type: "deleteSelected"; paths: string[] } | { type: "restore" | "purge"; fileId: string } | { type: "refresh" }) => {
    if (readOnly && !(allowTrashActions && (action.type === "deleteSelected" || action.type === "restore"))) throw new Error("This cached file action is unavailable.");
    if (action.type === "upload") for (const file of action.files) await workFoldersApi.upload(owner, file, directory ? `${directory}/${file.name}` : file.name, crypto.randomUUID());
    else if (action.type === "mkdir") { await workFoldersApi.operation(owner, { action: "mkdir", path: directory }, crypto.randomUUID()); setExpanded((before) => new Set([...before, directory])); }
    else if (action.type === "deleteSelected") {
      const failures: string[] = [];
      for (const path of action.paths) {
        try {
          await workFoldersApi.operation(owner, { action: "delete", path }, crypto.randomUUID());
          setCheckedFiles((before) => new Set([...before].filter((candidate) => candidate !== path && !candidate.startsWith(`${path}/`))));
          setSelectedPath((before) => before === path || before?.startsWith(`${path}/`) ? null : before);
        } catch (error) {
          failures.push(`${path}: ${error instanceof Error ? error.message : "Could not move to trash"}`);
        }
      }
      if (failures.length > 0) throw new Error(failures.join("; "));
    }
    else if (action.type === "restore" || action.type === "purge") await workFoldersApi.operation(owner, { action: action.type, fileId: action.fileId }, crypto.randomUUID());
    else for (const run of (syncQuery.data ?? []).filter((run) => run.active)) await workFoldersApi.refresh(owner, run.runId);
  }, onMutate: () => setAnnouncement(""), onSuccess: async (_data, action) => {
    setAnnouncement(action.type === "refresh" ? "Refresh requested for the next safe run boundary." : "Files saved.");
  }, onSettled: () => queryClient.invalidateQueries({ queryKey: key }) });
  const statuses = syncQuery.data ?? [];
  const failures = statuses.filter((status) => status.state === "failed");
  const saving = mutation.isPending || statuses.some((status) => status.state === "saving");
  const lastSaved = statuses.map((status) => status.lastSavedAt)
    .filter((value): value is string => Boolean(value)).sort().at(-1);
  const lastOperation = filesQuery.data?.lastOperationAt;
  const saveLabel = mutation.isPending ? "Saving…"
    : mutation.isError ? "Save failed"
    : syncQuery.isError ? "Save status unavailable"
    : !exampleFiles && syncQuery.isPending ? "Loading save status…"
    : saving ? "Saving…"
    : failures.length > 0 ? "Run save failed"
    : !lastSaved && statuses.some((status) => status.active) ? "Waiting for first save"
    : !lastSaved && !exampleFiles && filesQuery.isPending ? "Loading files…"
    : !lastSaved && filesQuery.isError && !filesQuery.data ? "File list unavailable"
    : lastSaved || lastOperation || files.length > 0 ? "Saved"
    : "No saved files";
  const disabled = mutation.isPending || Boolean(exampleFiles);
  return <Tabs value={trash ? "trash" : "files"} onValueChange={(value) => { setTrash(value === "trash"); setSelectedPath(null); setCheckedFiles(new Set()); }} className={cn("flex min-h-0 flex-col gap-3", fillHeight && "flex-1")}>
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {!readOnly && <><Button variant="outline" size="sm" disabled={disabled || trash} onClick={() => fileInput.current?.click()}><Upload aria-hidden />Upload</Button>
      <input ref={fileInput} className="hidden" aria-label="Upload work files" type="file" multiple onChange={(event) => {
        const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
        if (chosen.length) mutation.mutate({ type: "upload", files: chosen });
      }} /></>}
      <TabsList aria-label="Cached folder contents">
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsTrigger value="trash">Trash</TabsTrigger>
      </TabsList>
      {!trash && canManageTrash && deletePaths.length > 0 && <Button variant="outline" size="sm" disabled={disabled} onClick={() => mutation.mutate({ type: "deleteSelected", paths: deletePaths })}><Trash2 aria-hidden />Move {deletePaths.length} {selectionLabel}{deletePaths.length === 1 ? "" : "s"} to trash</Button>}
      {!readOnly && <Button variant="outline" size="sm" disabled={disabled || !statuses.some((status) => status.active)} onClick={() => mutation.mutate({ type: "refresh" })}><RefreshCw aria-hidden />Refresh sandbox</Button>}
      <span className="text-xs text-muted-foreground" role="status">{saveLabel}</span>
      {lastSaved && <span className="text-xs text-muted-foreground">Last agent save {new Date(lastSaved).toLocaleTimeString()}</span>}
      {lastOperation && (!lastSaved || lastOperation > lastSaved) && <span className="text-xs text-muted-foreground">Files updated {new Date(lastOperation).toLocaleTimeString()}</span>}
    </div>
    {!readOnly && !trash && <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 space-y-1"><Label htmlFor={directoryId}>Folder path</Label><Input id={directoryId} value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="Root folder" /></div>
      <Button variant="outline" size="sm" disabled={disabled || !directory} onClick={() => mutation.mutate({ type: "mkdir" })}><FolderPlus aria-hidden />Create folder</Button>
    </div>}
    {[filesQuery.error, syncQuery.error, mutation.error].filter(Boolean).map((error, index) => <p key={index} role="alert" className="text-sm text-destructive">{(error as Error).message}</p>)}
    {failures.length > 0 && <div role="alert" className="text-sm text-destructive">
      <p>{failures.length === 1 ? "A sandbox run could not save its files." : `${failures.length} sandbox runs could not save their files.`} The files below are saved copies.</p>
      <ul className="max-h-24 space-y-1 overflow-auto">
        {failures.map((failure) => <li key={failure.runId}>
          {failure.error}{" "}
          {failure.agentId && <Link className="underline" to={`/agents/${encodeURIComponent(failure.agentId)}/runs/${encodeURIComponent(failure.runId)}`} aria-label={`View failed run ${failure.runId}`}>View failed run</Link>}
        </li>)}
      </ul>
    </div>}
    <p className="sr-only" aria-live="polite">{announcement}</p>
    {trash ? <TabsContent value="trash" className={cn("overflow-auto", fillHeight ? "min-h-0 flex-1" : "max-h-96")}><p className="mb-3 text-sm text-muted-foreground">Deleted cached files are retained here. Restore them to return them to Files.</p>{!exampleFiles && filesQuery.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading trash…</p> : filesQuery.isError && !filesQuery.data ? <p className="text-sm text-muted-foreground">Trash could not be loaded.</p> : files.length === 0 ? <p className="text-sm text-muted-foreground">Trash is empty.</p> : files.map((file) => <div key={file.id} className="flex items-center gap-2 border-b py-2">
      <span className="min-w-0 flex-1 truncate text-sm">{file.path}</span>{canManageTrash && <Button size="sm" variant="outline" disabled={disabled} onClick={() => mutation.mutate({ type: "restore", fileId: file.id })}><RotateCcw aria-hidden />Restore</Button>}
      {!readOnly && <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={disabled}>Purge…</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Permanently delete {file.path}?</AlertDialogTitle>
          <AlertDialogDescription>This deleted copy and its deleted children will no longer be recoverable.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => mutation.mutate({ type: "purge", fileId: file.id })}>Permanently delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent></AlertDialog>}
    </div>)}</TabsContent> : <TabsContent value="files" className={cn("grid min-h-0 gap-3 md:grid-cols-3", fillHeight && "flex-1 grid-rows-2 md:grid-rows-1")}>
      <div className={cn("min-h-0 overflow-auto rounded-md border", !fillHeight && "max-h-96")}><FileTree nodes={nodes} selectedFile={selectedPath} expandedDirs={expanded}
        onToggleDir={(filePath) => { setSelectedPath(filePath); setExpanded((before) => { const next = new Set(before); if (next.has(filePath)) next.delete(filePath); else next.add(filePath); return next; }); }}
        showCheckboxes={canManageTrash && !exampleFiles} checkedFiles={new Set(checkedPaths)} includeDirectoriesInSelection
        onToggleCheck={(path, kind) => {
          if (disabled) return;
          const paths = kind === "file" ? [path] : [...availablePaths].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`));
          setCheckedFiles((before) => {
            const next = new Set(before);
            const remove = paths.every((candidate) => before.has(candidate));
            // A partial child selection must never leave its parent selected
            // for a recursive delete.
            for (const ancestor of before) if (path.startsWith(`${ancestor}/`)) next.delete(ancestor);
            for (const candidate of paths) { if (remove) next.delete(candidate); else next.add(candidate); }
            return next;
          });
        }}
        onSelectFile={setSelectedPath} loading={!exampleFiles && filesQuery.isLoading} empty={filesQuery.isError ? { title: "File list unavailable", description: "The saved contents could not be listed." } : { title: "No files yet", description: readOnly ? "No cached files have been saved for this scope." : "Upload files here, or create them during a sandbox run." }} ariaLabel={`${owner.scope} files`} /></div>
      <div className="flex min-h-0 flex-col gap-2 md:col-span-2">
        {selected && <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{selected.path}</span>
          {selected.kind === "file" && !exampleFiles && <Button asChild size="sm" variant="outline"><a href={workFoldersApi.downloadUrl(owner, selected.path)} download><Download aria-hidden />Download</a></Button>}
          </div>}
        {preview.isLoading || (preview.isFetching && preview.isError) ? <p className="text-sm text-muted-foreground">Loading preview…</p> : preview.error ? <p role="alert" className="text-sm text-muted-foreground">{preview.error.message}</p> : preview.data ?
          <div className={cn("flex min-h-0 flex-col overflow-auto rounded-md border", fillHeight ? "flex-1" : "max-h-96")}><FileContentViewer content={preview.data} highlightedLine={null} /></div> : <p className="text-sm text-muted-foreground">Select a file to preview it.</p>}
      </div>
    </TabsContent>}
  </Tabs>;
}
