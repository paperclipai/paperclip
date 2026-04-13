import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "@/lib/utils";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { PackageFileTree, buildFileTree } from "../components/PackageFileTree";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FolderOpen } from "lucide-react";

const ENTRY_FILE = "COMPANY.md";

function isMarkdown(path: string) {
  return path.toLowerCase().endsWith(".md");
}

function setsEqual<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export function CompanyInstructions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId!;

  const [selectedFile, setSelectedFile] = useState<string>(ENTRY_FILE);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [filePanelWidth, setFilePanelWidth] = useState(260);
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const lastFileVersionRef = useRef<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instructions" },
    ]);
  }, [setBreadcrumbs]);

  const { data: bundle, isLoading } = useQuery({
    queryKey: queryKeys.companyInstructions.bundle(companyId),
    queryFn: () => companiesApi.instructionsBundle(companyId),
    enabled: !!companyId,
  });

  const entryFile = bundle?.entryFile ?? ENTRY_FILE;
  const fileOptions = useMemo(() => bundle?.files.map((f) => f.path) ?? [], [bundle]);

  const visibleFilePaths = useMemo(
    () => [...new Set([...fileOptions, ...pendingFiles])],
    [fileOptions, pendingFiles],
  );

  const fileTree = useMemo(
    () => buildFileTree(Object.fromEntries(visibleFilePaths.map((p) => [p, ""]))),
    [visibleFilePaths],
  );

  const selectedOrEntryFile = selectedFile || entryFile;
  const selectedFileExists = fileOptions.includes(selectedOrEntryFile);
  const selectedFileSummary = bundle?.files.find((f) => f.path === selectedOrEntryFile) ?? null;

  const { data: selectedFileDetail, isLoading: fileLoading } = useQuery({
    queryKey: queryKeys.companyInstructions.file(companyId, selectedOrEntryFile),
    queryFn: () => companiesApi.instructionsFile(companyId, selectedOrEntryFile),
    enabled: !!companyId && selectedFileExists,
  });

  const saveFile = useMutation({
    mutationFn: (data: { path: string; content: string }) =>
      companiesApi.saveInstructionsFile(companyId, data),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, variables) => {
      setPendingFiles((prev) => prev.filter((f) => f !== variables.path));
      queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companyInstructions.file(companyId, variables.path),
      });
    },
    onError: () => setAwaitingRefresh(false),
  });

  const deleteFile = useMutation({
    mutationFn: (relativePath: string) =>
      companiesApi.deleteInstructionsFile(companyId, relativePath),
    onMutate: () => setAwaitingRefresh(true),
    onSuccess: (_, relativePath) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyInstructions.bundle(companyId) });
      queryClient.removeQueries({
        queryKey: queryKeys.companyInstructions.file(companyId, relativePath),
      });
    },
    onError: () => setAwaitingRefresh(false),
  });

  // Sync selected file when bundle loads
  useEffect(() => {
    if (!bundle) return;
    const availablePaths = bundle.files.map((f) => f.path);
    if (availablePaths.length === 0) return;
    if (!availablePaths.includes(selectedFile) && !pendingFiles.includes(selectedFile)) {
      setSelectedFile(availablePaths.includes(entryFile) ? entryFile : availablePaths[0]!);
    }
  }, [bundle, entryFile, pendingFiles, selectedFile]);

  // Expand parent dirs when file list changes
  useEffect(() => {
    const nextExpanded = new Set<string>();
    for (const filePath of visibleFilePaths) {
      const parts = filePath.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i]!;
        nextExpanded.add(cur);
      }
    }
    setExpandedDirs((current) => (setsEqual(current, nextExpanded) ? current : nextExpanded));
  }, [visibleFilePaths]);

  // Reset draft when selected file changes or after save
  useEffect(() => {
    const versionKey = selectedFileExists && selectedFileDetail
      ? `${selectedFileDetail.path}:${selectedFileDetail.content}`
      : `pending:${selectedOrEntryFile}`;
    if (awaitingRefresh) {
      setAwaitingRefresh(false);
      setDraft(null);
      lastFileVersionRef.current = versionKey;
      return;
    }
    if (lastFileVersionRef.current !== versionKey) {
      setDraft(null);
      lastFileVersionRef.current = versionKey;
    }
  }, [awaitingRefresh, selectedFileDetail, selectedFileExists, selectedOrEntryFile]);

  // Cmd+S to save
  const currentContent = selectedFileExists ? (selectedFileDetail?.content ?? "") : "";
  const displayValue = draft ?? currentContent;
  const isDirty = draft !== null && draft !== currentContent;

  const handleSave = useCallback(() => {
    if (!isDirty && selectedFileExists) return;
    saveFile.mutate({ path: selectedOrEntryFile, content: displayValue });
  }, [displayValue, isDirty, saveFile, selectedFileExists, selectedOrEntryFile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleSave]);

  // Draggable separator
  const handleSeparatorDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = filePanelWidth;
    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      setFilePanelWidth(Math.max(180, Math.min(500, startWidth + delta)));
    };
    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [filePanelWidth]);

  if (isLoading) return <PageSkeleton variant="detail" />;

  const hasAnyFiles = visibleFilePaths.length > 0;

  if (!hasAnyFiles) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Company Instructions</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Markdown files shared across all agents in this company. The entry file is automatically prepended to every agent's instructions at runtime.
          </p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 gap-3">
          <p className="text-sm text-muted-foreground">No instruction files yet.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPendingFiles([ENTRY_FILE]);
              setSelectedFile(ENTRY_FILE);
              setDraft("");
            }}
          >
            Create {ENTRY_FILE}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Company Instructions</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Markdown files shared across all agents in this company. The entry file ({entryFile}) is automatically prepended to every agent's instructions at runtime.
        </p>
      </div>

      <div className={cn("flex gap-0", isMobile && "flex-col gap-3")}>
        {/* File tree panel */}
        <div
          className={cn(
            "border border-border rounded-lg p-3 space-y-3 shrink-0",
            isMobile && showFilePanel && "block",
            isMobile && !showFilePanel && "hidden",
          )}
          style={isMobile ? undefined : { width: filePanelWidth }}
        >
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Files</h4>
            <div className="flex items-center gap-1">
              {!showNewFileInput && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7"
                  onClick={() => setShowNewFileInput(true)}
                >
                  +
                </Button>
              )}
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setShowFilePanel(false)}
                >
                  ✕
                </Button>
              )}
            </div>
          </div>

          {showNewFileInput && (
            <div className="space-y-2">
              <Input
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                placeholder="TOOLS.md"
                className="font-mono text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  className="flex-1"
                  disabled={!newFilePath.trim() || newFilePath.includes("..")}
                  onClick={() => {
                    const candidate = newFilePath.trim();
                    if (!candidate || candidate.includes("..")) return;
                    setPendingFiles((prev) => prev.includes(candidate) ? prev : [...prev, candidate]);
                    setSelectedFile(candidate);
                    setDraft("");
                    setNewFilePath("");
                    setShowNewFileInput(false);
                  }}
                >
                  Create
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowNewFileInput(false);
                    setNewFilePath("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <PackageFileTree
            nodes={fileTree}
            selectedFile={selectedOrEntryFile}
            expandedDirs={expandedDirs}
            checkedFiles={new Set()}
            onToggleDir={(dirPath) =>
              setExpandedDirs((current) => {
                const next = new Set(current);
                if (next.has(dirPath)) next.delete(dirPath);
                else next.add(dirPath);
                return next;
              })
            }
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              if (!fileOptions.includes(filePath)) setDraft("");
              if (isMobile) setShowFilePanel(false);
            }}
            onToggleCheck={() => {}}
            showCheckboxes={false}
            renderFileExtra={(node) => {
              const file = bundle?.files.find((f) => f.path === node.path);
              if (!file) return null;
              return (
                <span className="ml-3 shrink-0 rounded border border-border text-muted-foreground px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {file.isEntryFile ? "entry" : `${file.size}b`}
                </span>
              );
            }}
          />
        </div>

        {/* Draggable separator */}
        {!isMobile && (
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-border active:bg-primary/50 rounded transition-colors mx-1"
            onMouseDown={handleSeparatorDrag}
          />
        )}

        {/* Editor panel */}
        <div className={cn("border border-border rounded-lg p-4 space-y-3 min-w-0 flex-1", isMobile && showFilePanel && "hidden")}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {isMobile && (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowFilePanel(true)}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="min-w-0">
                <h4 className="text-sm font-medium font-mono truncate">{selectedOrEntryFile}</h4>
                <p className="text-xs text-muted-foreground">
                  {selectedFileExists
                    ? `${selectedFileSummary?.language ?? "text"} file`
                    : "New file — will be created on save"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {selectedFileExists && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (confirm(`Delete ${selectedOrEntryFile}?`)) {
                      deleteFile.mutate(selectedOrEntryFile, {
                        onSuccess: () => {
                          const remaining = fileOptions.filter((p) => p !== selectedOrEntryFile);
                          setSelectedFile(remaining.includes(entryFile) ? entryFile : (remaining[0] ?? entryFile));
                          setDraft(null);
                        },
                      });
                    }
                  }}
                  disabled={deleteFile.isPending}
                >
                  Delete
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="default"
                disabled={(!isDirty && selectedFileExists) || saveFile.isPending}
                onClick={handleSave}
              >
                {saveFile.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          {selectedFileExists && fileLoading && !selectedFileDetail ? (
            <div className="min-h-[420px] flex items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : isMarkdown(selectedOrEntryFile) ? (
            <MarkdownEditor
              key={selectedOrEntryFile}
              value={displayValue}
              onChange={(value) => setDraft(value ?? "")}
              placeholder="# Company instructions"
              contentClassName="min-h-[420px] text-sm font-mono"
            />
          ) : (
            <textarea
              value={displayValue}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[420px] w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm outline-none"
              placeholder="File contents"
            />
          )}
        </div>
      </div>
    </div>
  );
}
