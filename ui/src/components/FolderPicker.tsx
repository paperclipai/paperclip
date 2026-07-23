import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  TriangleAlert,
  ArrowUp,
} from "lucide-react";
import { accessApi, type FilesystemListEntry } from "@/api/access";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { PathInstructionsModal } from "./PathInstructionsModal";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

const PATH_INPUT_DEBOUNCE_MS = 250;

type FolderPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value?: string | null;
  onSelect: (path: string) => void;
};

type FolderPickerButtonProps = Omit<FolderPickerProps, "open" | "onOpenChange"> & {
  className?: string;
  children?: string;
};

function normalizePath(path?: string | null) {
  return path?.trim() ?? "";
}

function isWindowsPath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || isWindowsPath(path);
}

function joinFilesystemPath(basePath: string, entryName: string) {
  if (isAbsolutePath(entryName)) return entryName;
  if (!basePath) return entryName;
  const separator = isWindowsPath(basePath) ? "\\" : "/";
  if (basePath === "/") return `/${entryName}`;
  return basePath.endsWith(separator) ? `${basePath}${entryName}` : `${basePath}${separator}${entryName}`;
}

function buildBreadcrumbSegments(path: string) {
  if (!path) return [];

  if (isWindowsPath(path)) {
    const normalized = path.replace(/\//g, "\\");
    const parts = normalized.split("\\").filter(Boolean);
    const drive = normalized.startsWith("\\\\")
      ? `\\\\${parts[0] ?? ""}${parts[1] ? `\\${parts[1]}` : ""}`
      : parts[0] ?? normalized;
    const startIndex = normalized.startsWith("\\\\") ? 2 : 1;
    const segments = [{ label: drive, path: drive.endsWith("\\") ? drive : `${drive}\\` }];
    let current = segments[0]?.path ?? drive;
    for (const part of parts.slice(startIndex)) {
      current = joinFilesystemPath(current, part);
      segments.push({ label: part, path: current });
    }
    return segments;
  }

  const parts = path.split("/").filter(Boolean);
  const segments = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current = joinFilesystemPath(current || "/", part);
    segments.push({ label: part, path: current });
  }
  return segments;
}

function formatFolderLabel(entry: FilesystemListEntry, basePath: string) {
  const nextPath = joinFilesystemPath(basePath, entry.name);
  return {
    nextPath,
    secondaryLabel: basePath ? nextPath : entry.name,
  };
}

function getErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Could not load folders.";
}

export function FolderPicker({
  open,
  onOpenChange,
  value,
  onSelect,
}: FolderPickerProps) {
  const debounceRef = useRef<number | null>(null);
  const entryRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [inputPath, setInputPath] = useState("");
  const [requestedPath, setRequestedPath] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const applyPathImmediately = useCallback((nextPath: string) => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setInputPath(nextPath);
    setRequestedPath(nextPath);
  }, []);

  useEffect(() => {
    if (!open) return;
    const initialPath = normalizePath(value);
    applyPathImmediately(initialPath);
  }, [open, value, applyPathImmediately]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const directoryQuery = useQuery({
    queryKey: queryKeys.access.filesystemList(requestedPath),
    queryFn: () => accessApi.listFilesystem(requestedPath || undefined),
    enabled: open,
    retry: false,
    placeholderData: (previousData) => previousData,
  });

  const activePath = directoryQuery.data?.path ?? requestedPath;
  const folders = useMemo(
    () => (directoryQuery.data?.entries ?? []).filter((entry) => entry.isDir),
    [directoryQuery.data?.entries],
  );
  const breadcrumbSegments = useMemo(() => buildBreadcrumbSegments(activePath), [activePath]);
  const selectablePath = normalizePath(inputPath) || activePath;
  const canSelect = selectablePath.length > 0;
  const canGoUp = Boolean(directoryQuery.data?.parent ?? activePath);

  useEffect(() => {
    setHighlightedIndex(folders.length > 0 ? 0 : -1);
    entryRefs.current = [];
  }, [activePath, folders.length]);

  const focusEntry = (index: number) => {
    const clamped = Math.max(0, Math.min(index, folders.length - 1));
    setHighlightedIndex(clamped);
    window.requestAnimationFrame(() => {
      entryRefs.current[clamped]?.focus();
    });
  };

  const navigateTo = (nextPath: string) => {
    applyPathImmediately(nextPath);
  };

  const handleInputChange = (nextValue: string) => {
    const nextPath = normalizePath(nextValue);
    setInputPath(nextPath);
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      setRequestedPath(nextPath);
      debounceRef.current = null;
    }, PATH_INPUT_DEBOUNCE_MS);
  };

  const handleSelect = () => {
    if (!canSelect) return;
    onSelect(selectablePath);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[calc(100%-2rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-border px-6 pt-6 pb-4">
            <DialogTitle className="text-base">Choose a folder</DialogTitle>
            <DialogDescription>
              Paste an absolute path or browse folders on this machine. The selected path is returned as plain text.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-6 py-4">
            <div className="space-y-2">
              <label htmlFor="folder-picker-path" className="text-xs font-medium text-muted-foreground">
                Current path
              </label>
              <Input
                id="folder-picker-path"
                value={inputPath}
                onChange={(event) => handleInputChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" && folders.length > 0) {
                    event.preventDefault();
                    focusEntry(0);
                  }
                  if (event.key === "Enter" && canSelect) {
                    event.preventDefault();
                    handleSelect();
                  }
                }}
                className="font-mono text-sm"
                placeholder="/absolute/path/to/workspace"
              />
              <p className="text-xs text-muted-foreground">
                Typing updates the folder list after a short debounce. Paste still works even if browsing is unavailable.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canGoUp}
                onClick={() => navigateTo(directoryQuery.data?.parent ?? "")}
              >
                <ArrowUp className="size-4" />
                Up
              </Button>
              <div className="min-w-0 flex-1 rounded-md border border-border px-3 py-2">
                {breadcrumbSegments.length > 0 ? (
                  <Breadcrumb>
                      <BreadcrumbList className="flex-nowrap overflow-x-auto whitespace-nowrap">
                        {breadcrumbSegments.map((segment, index) => (
                          <Fragment key={segment.path}>
                            <BreadcrumbItem>
                              {index === breadcrumbSegments.length - 1 ? (
                                <BreadcrumbPage className="font-mono text-xs">{segment.label}</BreadcrumbPage>
                              ) : (
                                <button
                                  type="button"
                                  className="font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                                  onClick={() => navigateTo(segment.path)}
                                >
                                  {segment.label}
                                </button>
                              )}
                            </BreadcrumbItem>
                            {index < breadcrumbSegments.length - 1 ? <BreadcrumbSeparator /> : null}
                          </Fragment>
                        ))}
                      </BreadcrumbList>
                  </Breadcrumb>
                ) : (
                  <span className="text-xs text-muted-foreground">Roots</span>
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
                <span>{activePath ? "Subdirectories" : "Available roots"}</span>
                <span className="inline-flex items-center gap-1">
                  {directoryQuery.isFetching ? <Loader2 className="size-3 animate-spin" /> : null}
                  {directoryQuery.isFetching ? "Loading" : `${folders.length} folder${folders.length === 1 ? "" : "s"}`}
                </span>
              </div>

              {directoryQuery.isPending && !directoryQuery.data ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-12 w-full" />
                  ))}
                </div>
              ) : directoryQuery.error ? (
                <div className="space-y-3 p-4">
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    <div className="flex items-start gap-2">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                      <div>
                        <p className="font-medium">Could not load folders</p>
                        <p>{getErrorMessage(directoryQuery.error)}</p>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    You can still paste a path above and use it directly.
                  </p>
                </div>
              ) : (
                <ScrollArea className="h-72">
                  {folders.length > 0 ? (
                    <ul className="p-2">
                      {folders.map((entry, index) => {
                        const { nextPath, secondaryLabel } = formatFolderLabel(entry, activePath);
                        const isActive = index === highlightedIndex;
                        return (
                          <li key={nextPath}>
                            <button
                              ref={(node) => {
                                entryRefs.current[index] = node;
                              }}
                              type="button"
                              className={cn(
                                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                                isActive ? "bg-accent text-foreground" : "hover:bg-accent/60",
                              )}
                              onClick={() => navigateTo(nextPath)}
                              onMouseEnter={() => setHighlightedIndex(index)}
                              onKeyDown={(event) => {
                                if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  focusEntry(index + 1);
                                }
                                if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  focusEntry(index - 1);
                                }
                                if (event.key === "Home") {
                                  event.preventDefault();
                                  focusEntry(0);
                                }
                                if (event.key === "End") {
                                  event.preventDefault();
                                  focusEntry(folders.length - 1);
                                }
                              }}
                            >
                              <div className="flex size-8 items-center justify-center rounded-md border border-border bg-background">
                                {nextPath === activePath ? (
                                  <FolderOpen className="size-4 text-foreground" />
                                ) : (
                                  <Folder className="size-4 text-muted-foreground" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-medium">{entry.name}</span>
                                  {entry.isSymlink ? (
                                    <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      symlink
                                    </span>
                                  ) : null}
                                </div>
                                <p className="truncate font-mono text-xs text-muted-foreground">{secondaryLabel}</p>
                              </div>
                              <ChevronRight className="size-4 text-muted-foreground" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                      <FolderOpen className="size-8 text-muted-foreground" />
                      <div className="space-y-1">
                        <p className="text-sm font-medium">No subdirectories here</p>
                        <p className="text-xs text-muted-foreground">
                          Select this folder or paste a different absolute path above.
                        </p>
                      </div>
                    </div>
                  )}
                </ScrollArea>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="link"
                className="h-auto px-0 text-xs"
                onClick={() => setHelpOpen(true)}
              >
                Need help finding a path?
              </Button>
              <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {selectablePath || "No folder selected yet"}
              </p>
            </div>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSelect} onClick={handleSelect}>
              Select this folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PathInstructionsModal open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}

export function FolderPickerButton({
  value,
  onSelect,
  className,
  children = "Choose",
}: FolderPickerButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={cn("text-muted-foreground", className)}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      <FolderPicker
        open={open}
        onOpenChange={setOpen}
        value={value}
        onSelect={onSelect}
      />
    </>
  );
}
