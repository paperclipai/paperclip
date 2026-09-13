import { useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderOpen, FolderPlus, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import type { WorkFile, WorkFolderOwner } from "@paperclipai/shared";
import { workFoldersApi } from "@/api/work-folders";
import { FileTree, type FileTreeNode } from "@/components/FileTree";
import { FileContentViewer } from "@/components/FileViewerSheet";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

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

export function WorkFolderButton({ owner, label = "Files" }: { owner: WorkFolderOwner; label?: string }) {
  return <Dialog><DialogTrigger asChild><Button variant="outline" size="sm"><FolderOpen aria-hidden />{label}</Button></DialogTrigger>
    <DialogContent className="flex max-h-screen flex-col sm:max-w-5xl">
      <DialogHeader><DialogTitle>{label}</DialogTitle><DialogDescription>
        {owner.scope === "user" ? "Your private Paperclip files in this company." : `Files shared with this ${owner.scope}'s sandbox runs.`} Changes from running agents are saved every three minutes and when a run ends.
      </DialogDescription></DialogHeader>
      <WorkFolderBrowser key={`${owner.companyId}:${owner.scope}:${owner.ownerId}`} owner={owner} />
    </DialogContent></Dialog>;
}

export function WorkFolderBrowser({ owner, exampleFiles }: { owner: WorkFolderOwner; exampleFiles?: WorkFile[] }) {
  const queryClient = useQueryClient();
  const [trash, setTrash] = useState(false);
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
  const preview = useQuery({ queryKey: [...key, "preview", selected?.path, selected?.sha256],
    queryFn: () => workFoldersApi.preview(owner, selected!), enabled: !exampleFiles && !trash && selected?.kind === "file", retry: false });
  const mutation = useMutation({ mutationFn: async (action: { type: "upload"; files: File[] } | { type: "mkdir" } | { type: "delete"; path: string } | { type: "restore" | "purge"; fileId: string } | { type: "refresh" }) => {
    if (action.type === "upload") for (const file of action.files) await workFoldersApi.upload(owner, file, directory ? `${directory}/${file.name}` : file.name, crypto.randomUUID());
    else if (action.type === "mkdir") { await workFoldersApi.operation(owner, { action: "mkdir", path: directory }, crypto.randomUUID()); setExpanded((before) => new Set([...before, directory])); }
    else if (action.type === "delete") await workFoldersApi.operation(owner, { action: "delete", path: action.path }, crypto.randomUUID());
    else if (action.type === "restore" || action.type === "purge") await workFoldersApi.operation(owner, { action: action.type, fileId: action.fileId }, crypto.randomUUID());
    else for (const run of (syncQuery.data ?? []).filter((run) => run.active)) await workFoldersApi.refresh(owner, run.runId);
  }, onSuccess: async (_data, action) => {
    setAnnouncement(action.type === "refresh" ? "Refresh requested for the next safe run boundary." : "Files saved.");
    await queryClient.invalidateQueries({ queryKey: key });
  } });
  const statuses = syncQuery.data ?? [];
  const failed = statuses.find((status) => status.state === "failed");
  const saving = mutation.isPending || statuses.some((status) => status.state === "saving");
  const lastSaved = statuses.map((status) => status.lastSavedAt)
    .filter((value): value is string => Boolean(value)).sort().at(-1);
  const lastOperation = filesQuery.data?.lastOperationAt;
  const saveFailed = Boolean(failed) || mutation.isError;
  const disabled = mutation.isPending || Boolean(exampleFiles);
  return <div className="flex min-h-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={disabled || trash} onClick={() => fileInput.current?.click()}><Upload aria-hidden />Upload</Button>
      <input ref={fileInput} className="hidden" aria-label="Upload work files" type="file" multiple onChange={(event) => {
        const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
        if (chosen.length) mutation.mutate({ type: "upload", files: chosen });
      }} />
      <Button variant={trash ? "secondary" : "outline"} size="sm" onClick={() => { setTrash(!trash); setSelectedPath(null); }}><Trash2 aria-hidden />{trash ? "Back to files" : "Trash"}</Button>
      <Button variant="outline" size="sm" disabled={disabled || !statuses.some((status) => status.active)} onClick={() => mutation.mutate({ type: "refresh" })}><RefreshCw aria-hidden />Refresh sandbox</Button>
      <span className="text-xs text-muted-foreground" role="status">{saving ? "Saving…" : saveFailed ? "Save failed" : "Saved"}</span>
      {lastSaved && <span className="text-xs text-muted-foreground">Last agent save {new Date(lastSaved).toLocaleTimeString()}</span>}
      {lastOperation && (!lastSaved || lastOperation > lastSaved) && <span className="text-xs text-muted-foreground">Files updated {new Date(lastOperation).toLocaleTimeString()}</span>}
    </div>
    {!trash && <div className="flex flex-wrap items-end gap-2">
      <div className="flex-1 space-y-1"><Label htmlFor={directoryId}>Folder path</Label><Input id={directoryId} value={directory} onChange={(event) => setDirectory(event.target.value)} placeholder="Root folder" /></div>
      <Button variant="outline" size="sm" disabled={disabled || !directory} onClick={() => mutation.mutate({ type: "mkdir" })}><FolderPlus aria-hidden />Create folder</Button>
    </div>}
    {[filesQuery.error, syncQuery.error, mutation.error].filter(Boolean).map((error, index) => <p key={index} role="alert" className="text-sm text-destructive">{(error as Error).message}</p>)}
    {failed && <p role="alert" className="text-sm text-destructive">{failed.error}</p>}
    <p className="sr-only" aria-live="polite">{announcement}</p>
    {trash ? <div className="max-h-96 overflow-auto">{files.length === 0 ? <p className="text-sm text-muted-foreground">Trash is empty.</p> : files.map((file) => <div key={file.id} className="flex items-center gap-2 border-b py-2">
      <span className="min-w-0 flex-1 truncate text-sm">{file.path}</span><Button size="sm" variant="outline" disabled={disabled} onClick={() => mutation.mutate({ type: "restore", fileId: file.id })}><RotateCcw aria-hidden />Restore</Button>
      <AlertDialog><AlertDialogTrigger asChild><Button size="sm" variant="ghost" disabled={disabled}>Purge…</Button></AlertDialogTrigger>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Permanently delete {file.path}?</AlertDialogTitle>
          <AlertDialogDescription>This deleted copy and its deleted children will no longer be recoverable.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => mutation.mutate({ type: "purge", fileId: file.id })}>Permanently delete</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent></AlertDialog>
    </div>)}</div> : <div className="grid min-h-0 gap-3 md:grid-cols-3">
      <div className="max-h-96 overflow-auto rounded-md border"><FileTree nodes={nodes} selectedFile={selectedPath} expandedDirs={expanded}
        onToggleDir={(filePath) => { setSelectedPath(filePath); setExpanded((before) => { const next = new Set(before); if (next.has(filePath)) next.delete(filePath); else next.add(filePath); return next; }); }}
        onSelectFile={setSelectedPath} loading={!exampleFiles && filesQuery.isLoading} empty={{ title: "No files yet", description: "Upload files here, or create them during a sandbox run." }} ariaLabel={`${owner.scope} files`} /></div>
      <div className="flex min-h-0 flex-col gap-2 md:col-span-2">
        {selected && <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{selected.path}</span>
          {selected.kind === "file" && !exampleFiles && <Button asChild size="sm" variant="outline"><a href={workFoldersApi.downloadUrl(owner, selected.path)} download><Download aria-hidden />Download</a></Button>}
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => mutation.mutate({ type: "delete", path: selected.path })}><Trash2 aria-hidden />Delete</Button></div>}
        {preview.isLoading ? <p className="text-sm text-muted-foreground">Loading preview…</p> : preview.error ? <p role="alert" className="text-sm text-muted-foreground">{preview.error.message}</p> : preview.data ?
          <div className="flex max-h-96 min-h-0 flex-col overflow-auto rounded-md border"><FileContentViewer content={preview.data} highlightedLine={null} /></div> : <p className="text-sm text-muted-foreground">Select a file to preview it.</p>}
      </div>
    </div>}
  </div>;
}
