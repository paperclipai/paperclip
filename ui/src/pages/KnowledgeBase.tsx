import { useEffect, useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { knowledgeApi, type KnowledgePage, type KnowledgePageRevision } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
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
import { cn, formatDate } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import {
  BookOpen,
  ChevronLeft,
  Clock,
  Edit3,
  Eye,
  History,
  Plus,
  Save,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

/* ── Main component ── */

export function KnowledgeBase() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge Base" }]);
  }, [setBreadcrumbs]);

  const { data: pages, isLoading, error: pagesError } = useQuery({
    queryKey: queryKeys.knowledge.list(selectedCompanyId!),
    queryFn: () => knowledgeApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const selectedPage = useMemo(
    () => (pages ?? []).find((p) => p.id === selectedPageId) ?? null,
    [pages, selectedPageId],
  );

  const { data: revisions } = useQuery({
    queryKey: ["knowledge", "revisions", selectedPageId],
    queryFn: () => knowledgeApi.listRevisions(selectedPageId!),
    enabled: !!selectedPageId && showHistory,
  });

  const filteredPages = useMemo(() => {
    if (!search.trim()) return pages ?? [];
    const q = search.toLowerCase();
    return (pages ?? []).filter((p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q));
  }, [pages, search]);

  const createPage = useMutation({
    mutationFn: () => knowledgeApi.create(selectedCompanyId!, { title: newTitle.trim() }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
      setSelectedPageId(page.id);
      setCreating(false);
      setNewTitle("");
      setEditing(true);
      setEditTitle(page.title);
      setEditBody(page.body);
    },
  });

  const updatePage = useMutation({
    mutationFn: () => knowledgeApi.update(selectedPageId!, { title: editTitle, body: editBody }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
      setEditing(false);
    },
  });

  const deletePage = useMutation({
    mutationFn: () => knowledgeApi.remove(selectedPageId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
      setSelectedPageId(null);
      setEditing(false);
    },
  });

  const revertPage = useMutation({
    mutationFn: (revisionNumber: number) => knowledgeApi.revert(selectedPageId!, revisionNumber),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["knowledge", "revisions", selectedPageId] });
      setShowHistory(false);
    },
  });

  function startEditing() {
    if (!selectedPage) return;
    setEditTitle(selectedPage.title);
    setEditBody(selectedPage.body);
    setEditing(true);
    setTimeout(() => editBodyRef.current?.focus(), 50);
  }

  function navigateToSlug(slug: string) {
    const page = (pages ?? []).find((p) => p.slug === slug);
    if (page) {
      setSelectedPageId(page.id);
      setEditing(false);
      setShowHistory(false);
    }
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to view the Knowledge Base." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="flex h-full gap-0 -m-4 md:-m-6">
      {/* Left panel — page list */}
      <div className={cn(
        "flex flex-col border-r border-border bg-background shrink-0 transition-[width]",
        selectedPageId ? "w-0 md:w-72 overflow-hidden" : "w-full md:w-72",
      )}>
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Knowledge Base</h2>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCreating(true)}>
              <Plus className="h-3 w-3 mr-1" />New Page
            </Button>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." className="pl-7 text-xs h-8" />
          </div>
        </div>

        {creating && (
          <div className="p-3 border-b border-border space-y-2">
            <Input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Page title..."
              className="text-xs h-8"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && newTitle.trim()) createPage.mutate(); if (e.key === "Escape") setCreating(false); }}
            />
            <div className="flex items-center gap-1">
              <Button size="sm" className="h-7 text-xs" disabled={!newTitle.trim() || createPage.isPending} onClick={() => createPage.mutate()}>
                {createPage.isPending ? "Creating..." : "Create"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setCreating(false); setNewTitle(""); }}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {pagesError && (
            <div className="p-4 text-xs text-destructive text-center">
              Failed to load pages. Please try again.
            </div>
          )}
          {!pagesError && filteredPages.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              {search.trim() ? "No pages match your search." : "No pages yet. Create one to get started."}
            </div>
          ) : (
            filteredPages.map((page) => (
              <button
                key={page.id}
                className={cn(
                  "w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors",
                  selectedPageId === page.id ? "bg-accent" : "hover:bg-accent/50",
                )}
                onClick={() => { setSelectedPageId(page.id); setEditing(false); setShowHistory(false); }}
              >
                <div className="text-sm font-medium truncate">{page.title}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">{timeAgo(page.updatedAt)}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right panel — page content */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {!selectedPage ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <BookOpen className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a page or create a new one</p>
            </div>
          </div>
        ) : (
          <>
            {/* Page header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <button className="md:hidden text-muted-foreground" onClick={() => setSelectedPageId(null)}>
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {editing ? (
                  <input
                    className="text-sm font-semibold bg-transparent outline-none border-b border-border flex-1 min-w-0"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                  />
                ) : (
                  <h2 className="text-sm font-semibold truncate">{selectedPage.title}</h2>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {editing ? (
                  <>
                    <Button size="sm" className="h-7 text-xs" disabled={updatePage.isPending} onClick={() => updatePage.mutate()}>
                      <Save className="h-3 w-3 mr-1" />{updatePage.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}>
                      <X className="h-3 w-3 mr-1" />Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={startEditing}>
                      <Edit3 className="h-3 w-3 mr-1" />Edit
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowHistory(!showHistory)}>
                      <History className="h-3 w-3 mr-1" />History
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-destructive"
                      onClick={() => setShowDeleteConfirm(true)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Page metadata */}
            <div className="flex items-center gap-3 px-4 py-1.5 text-[10px] text-muted-foreground border-b border-border/50 shrink-0">
              <span>Revision #{selectedPage.revisionNumber}</span>
              <span>·</span>
              <span>Updated {timeAgo(selectedPage.updatedAt)}</span>
              <span>·</span>
              <span className="capitalize">{selectedPage.visibility}</span>
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-y-auto">
              {showHistory ? (
                <div className="p-4 space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">Revision History</h3>
                  {(revisions ?? []).map((rev) => (
                    <div key={rev.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">Revision #{rev.revisionNumber}</div>
                        <div className="text-xs text-muted-foreground">
                          {rev.changeSummary ?? "No summary"} · {timeAgo(rev.createdAt)}
                        </div>
                      </div>
                      {rev.revisionNumber !== selectedPage.revisionNumber && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs shrink-0"
                          disabled={revertPage.isPending}
                          onClick={() => revertPage.mutate(rev.revisionNumber)}
                        >
                          <Undo2 className="h-3 w-3 mr-1" />Revert
                        </Button>
                      )}
                    </div>
                  ))}
                  {(revisions ?? []).length === 0 && <p className="text-sm text-muted-foreground">No revisions yet.</p>}
                </div>
              ) : editing ? (
                <textarea
                  ref={editBodyRef}
                  className="w-full h-full p-4 text-sm bg-transparent outline-none resize-none font-mono"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  placeholder="Write your page content in markdown..."
                />
              ) : (
                <div className="p-4">
                  <MarkdownBody>{selectedPage.body}</MarkdownBody>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Delete page confirmation dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete page?</DialogTitle>
            <DialogDescription>
              {selectedPage
                ? `"${selectedPage.title}" will be permanently deleted along with all its revision history. This cannot be undone.`
                : "This page will be permanently deleted. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletePage.isPending}
              onClick={() => {
                deletePage.mutate();
                setShowDeleteConfirm(false);
              }}
            >
              {deletePage.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
