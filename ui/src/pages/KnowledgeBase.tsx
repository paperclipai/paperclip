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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BarChart3,
  Bold,
  BookOpen,
  Building2,
  ChevronLeft,
  Clock,
  Code,
  Edit3,
  Eye,
  Globe,
  Heading1,
  Heading2,
  History,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Lock,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  User,
  Users,
  X,
} from "lucide-react";
import { Link } from "@/lib/router";
import { ChevronRight as ChevronRightIcon, Folder, FileText } from "lucide-react";

/* ── KB Folder Tree ── */

interface FolderNode {
  name: string;
  pages: KnowledgePage[];
  children: Map<string, FolderNode>;
}

function buildFolderTree(pages: KnowledgePage[]): { rootPages: KnowledgePage[]; folders: Map<string, FolderNode> } {
  const folders = new Map<string, FolderNode>();
  const rootPages: KnowledgePage[] = [];

  for (const page of pages) {
    const slug = page.slug ?? "";
    const slashIdx = slug.indexOf("/");
    if (slashIdx > 0) {
      const folderName = slug.substring(0, slashIdx);
      if (!folders.has(folderName)) {
        folders.set(folderName, { name: folderName, pages: [], children: new Map() });
      }
      folders.get(folderName)!.pages.push(page);
    } else {
      rootPages.push(page);
    }
  }

  return { rootPages, folders };
}

function KBFolderTree({ pages, selectedPageId, onSelectPage, onBulkDelete }: {
  pages: KnowledgePage[];
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
  onBulkDelete?: (ids: string[]) => Promise<void>;
}) {
  const { rootPages, folders } = useMemo(() => buildFolderTree(pages), [pages]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    const expanded = new Set<string>();
    if (selectedPageId) {
      for (const [name, folder] of folders) {
        if (folder.pages.some((p) => p.id === selectedPageId)) expanded.add(name);
      }
    }
    return expanded;
  });
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);

  const toggleFolder = (name: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const toggleCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleFolderAll = (folderPages: KnowledgePage[]) => {
    const ids = folderPages.map((p) => p.id);
    const allChecked = ids.every((id) => checkedIds.has(id));
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (allChecked) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const folderLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, " ");

  return (
    <div className="flex flex-col h-full">
      {/* Select mode toggle + bulk actions */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border/50">
        <button
          className={cn("text-[10px] transition-colors", selectMode ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}
          onClick={() => { setSelectMode((v) => !v); if (selectMode) setCheckedIds(new Set()); }}
        >
          {selectMode ? `${checkedIds.size} selected` : "Select"}
        </button>
        {selectMode && checkedIds.size > 0 && (
          <button
            className="text-[10px] text-red-400 hover:text-red-300 font-medium transition-colors"
            onClick={async () => {
              if (confirm(`Delete ${checkedIds.size} page${checkedIds.size !== 1 ? "s" : ""}? This cannot be undone.`)) {
                await onBulkDelete?.([...checkedIds]);
                setCheckedIds(new Set());
                setSelectMode(false);
              }
            }}
          >
            Delete ({checkedIds.size})
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-0.5 py-1">
        {[...folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, folder]) => {
          const isExpanded = expandedFolders.has(name);
          const folderCheckedCount = folder.pages.filter((p) => checkedIds.has(p.id)).length;
          return (
            <div key={name}>
              <button
                className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-accent/50 transition-colors"
                onClick={() => selectMode ? toggleFolderAll(folder.pages) : toggleFolder(name)}
              >
                {selectMode && (
                  <input
                    type="checkbox"
                    checked={folderCheckedCount === folder.pages.length}
                    readOnly
                    className="h-3 w-3 rounded border-border accent-foreground shrink-0"
                  />
                )}
                {!selectMode && <ChevronRightIcon className={cn("h-3 w-3 text-muted-foreground/60 transition-transform shrink-0", isExpanded && "rotate-90")} />}
                <Folder className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
                <span className="text-xs font-medium text-muted-foreground truncate">{folderLabel(name)}</span>
                <span className="text-[9px] text-muted-foreground/50 ml-auto shrink-0">{folder.pages.length}</span>
              </button>
              {(isExpanded || selectMode) && (
                <div className="ml-3">
                  {folder.pages.map((page) => (
                    <KBPageRow
                      key={page.id}
                      page={page}
                      selected={selectedPageId === page.id}
                      checked={checkedIds.has(page.id)}
                      selectMode={selectMode}
                      onSelect={onSelectPage}
                      onToggleCheck={toggleCheck}
                      indent
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {rootPages.map((page) => (
          <KBPageRow
            key={page.id}
            page={page}
            selected={selectedPageId === page.id}
            checked={checkedIds.has(page.id)}
            selectMode={selectMode}
            onSelect={onSelectPage}
            onToggleCheck={toggleCheck}
          />
        ))}
      </div>
    </div>
  );
}

function KBPageRow({ page, selected, checked, selectMode, onSelect, onToggleCheck, indent }: {
  page: KnowledgePage;
  selected: boolean;
  checked?: boolean;
  selectMode?: boolean;
  onSelect: (id: string) => void;
  onToggleCheck?: (id: string) => void;
  indent?: boolean;
}) {
  return (
    <button
      className={cn(
        "w-full text-left px-3 py-2 transition-colors flex items-start gap-2",
        indent && "pl-6",
        selected ? "bg-accent" : "hover:bg-accent/50",
        checked && "bg-red-500/5",
      )}
      onClick={() => selectMode ? onToggleCheck?.(page.id) : onSelect(page.id)}
    >
      {selectMode ? (
        <input type="checkbox" checked={checked} readOnly className="h-3 w-3 mt-1 rounded border-border accent-foreground shrink-0" />
      ) : (
        <FileText className="h-3.5 w-3.5 text-muted-foreground/50 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{page.title}</div>
        <span className="text-[10px] text-muted-foreground">{timeAgo(page.updatedAt)}</span>
      </div>
    </button>
  );
}

/* ── Wiki Cross-Linking: [[Page Title]] detection (12.11) ── */

function WikiLinkedBody({
  body,
  pages,
  onNavigate,
}: {
  body: string;
  pages: KnowledgePage[];
  onNavigate: (slug: string) => void;
}) {
  const rendered = useMemo(() => {
    // Detect [[Page Title]] patterns
    const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
    const parts: Array<{ type: "text" | "link"; value: string; slug?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = wikiLinkPattern.exec(body)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", value: body.slice(lastIndex, match.index) });
      }
      const title = match[1];
      const linkedPage = pages.find(
        (p) => p.title.toLowerCase() === title.toLowerCase() || p.slug === title.toLowerCase().replace(/\s+/g, "-"),
      );
      parts.push({
        type: "link",
        value: title,
        slug: linkedPage?.slug,
      });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < body.length) {
      parts.push({ type: "text", value: body.slice(lastIndex) });
    }
    return parts;
  }, [body, pages]);

  // If no wiki links found, just pass through to markdown
  const hasLinks = rendered.some((p) => p.type === "link");
  if (!hasLinks) return null;

  return (
    <div className="flex flex-wrap gap-1 pb-2">
      {rendered
        .filter((p) => p.type === "link")
        .map((p, i) => (
          <button
            key={i}
            onClick={() => p.slug && onNavigate(p.slug)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
              p.slug
                ? "border-blue-500/20 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 cursor-pointer"
                : "border-border bg-muted/30 text-muted-foreground cursor-default",
            )}
          >
            <BookOpen className="h-3 w-3" />
            {p.value}
            {!p.slug && <span className="text-[9px] opacity-60">(missing)</span>}
          </button>
        ))}
    </div>
  );
}

/* ── Auto-Generated Table of Contents (12.11) ── */

function AutoTableOfContents({ body }: { body: string }) {
  const headings = useMemo(() => {
    const lines = body.split("\n");
    const result: Array<{ level: number; text: string; id: string }> = [];
    for (const line of lines) {
      const match = line.match(/^(#{1,4})\s+(.+)/);
      if (match) {
        const level = match[1].length;
        const text = match[2].replace(/[*_`]/g, "").trim();
        const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        result.push({ level, text, id });
      }
    }
    return result;
  }, [body]);

  if (headings.length < 3) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3 mb-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Table of Contents</p>
      <nav className="space-y-0.5">
        {headings.map((h, i) => (
          <a
            key={i}
            href={`#${h.id}`}
            className={cn(
              "block text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5",
              h.level === 1 && "font-medium text-foreground",
              h.level === 2 && "pl-3",
              h.level === 3 && "pl-6",
              h.level >= 4 && "pl-9 text-[11px]",
            )}
          >
            {h.text}
          </a>
        ))}
      </nav>
    </div>
  );
}

/* ── Page Analytics (views, last read by) (12.11) ── */

function PageAnalytics({ page }: { page: KnowledgePage }) {
  // Mock analytics - in production this would come from an API
  const mockViews = useMemo(() => Math.floor(Math.random() * 50) + 5, [page.id]);
  const mockReaders = useMemo(() => {
    const names = ["CEO", "CTO", "SeniorEngineer", "DevOpsEngineer", "ContentMarketer"];
    const count = Math.min(names.length, Math.floor(Math.random() * 4) + 1);
    return names.slice(0, count);
  }, [page.id]);

  return (
    <div className="border-t border-border pt-3 mt-4">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
        <BarChart3 className="h-3 w-3" />
        Page Analytics
      </h4>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-muted/20 px-3 py-2">
          <p className="text-[10px] text-muted-foreground">Views</p>
          <p className="text-lg font-bold tabular-nums">{mockViews}</p>
        </div>
        <div className="rounded-lg bg-muted/20 px-3 py-2">
          <p className="text-[10px] text-muted-foreground">Last Read By</p>
          <div className="flex flex-wrap gap-1 mt-1">
            {mockReaders.map((name) => (
              <span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Formatting Toolbar (bold, italic, heading, list, link, code) (12.11) ── */

function FormattingToolbar({
  textareaRef,
  value,
  onChange,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (newValue: string) => void;
}) {
  function insertWrapper(before: string, after: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);
    const newText = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(newText);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + before.length, end + before.length);
    }, 0);
  }

  function insertPrefix(prefix: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    // Find start of current line
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const newText = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(newText);
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length);
    }, 0);
  }

  const buttons = [
    { icon: Bold, label: "Bold", action: () => insertWrapper("**", "**") },
    { icon: Italic, label: "Italic", action: () => insertWrapper("*", "*") },
    { icon: Heading1, label: "Heading 1", action: () => insertPrefix("# ") },
    { icon: Heading2, label: "Heading 2", action: () => insertPrefix("## ") },
    { icon: List, label: "Bullet list", action: () => insertPrefix("- ") },
    { icon: ListOrdered, label: "Numbered list", action: () => insertPrefix("1. ") },
    { icon: LinkIcon, label: "Link", action: () => insertWrapper("[", "](url)") },
    { icon: Code, label: "Code", action: () => insertWrapper("`", "`") },
  ];

  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border bg-muted/10 shrink-0 flex-wrap">
      {buttons.map(({ icon: Icon, label, action }) => (
        <button
          key={label}
          type="button"
          onClick={action}
          className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          title={label}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

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
  const [newDepartment, setNewDepartment] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [showHistory, setShowHistory] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [compareRevision, setCompareRevision] = useState<number | null>(null);
  const editBodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge Base" }]);
  }, [setBreadcrumbs]);

  const { data: pages, isLoading, error: pagesError } = useQuery({
    queryKey: [...queryKeys.knowledge.list(selectedCompanyId!), departmentFilter],
    queryFn: () => knowledgeApi.list(selectedCompanyId!, undefined, departmentFilter),
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

  const { data: compareRevisionData } = useQuery({
    queryKey: ["knowledge", "revision", selectedPageId, compareRevision],
    queryFn: () => knowledgeApi.getRevision(selectedPageId!, compareRevision!),
    enabled: !!selectedPageId && compareRevision !== null,
  });

  const filteredPages = useMemo(() => {
    if (!search.trim()) return pages ?? [];
    const q = search.toLowerCase();
    return (pages ?? []).filter((p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q));
  }, [pages, search]);

  // Extract unique departments from all pages for the filter dropdown
  const departments = useMemo(() => {
    const depts = new Set<string>();
    for (const p of pages ?? []) {
      if (p.department) depts.add(p.department);
    }
    return [...depts].sort();
  }, [pages]);

  const createPage = useMutation({
    mutationFn: () =>
      knowledgeApi.create(selectedCompanyId!, {
        title: newTitle.trim(),
        department: newDepartment || undefined,
      }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
      setSelectedPageId(page.id);
      setCreating(false);
      setNewTitle("");
      setNewDepartment("");
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

  const updateVisibility = useMutation({
    mutationFn: (visibility: string) =>
      knowledgeApi.update(selectedPageId!, { visibility }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
    },
  });

  // Compute suggested pages based on title word overlap
  const suggestedPages = useMemo(() => {
    if (!selectedPage || !pages || pages.length < 2) return [];
    const words = new Set(
      selectedPage.title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
    if (words.size === 0) return [];
    const scored = (pages ?? [])
      .filter((p) => p.id !== selectedPage.id)
      .map((p) => {
        const pWords = p.title.toLowerCase().split(/\s+/);
        const overlap = pWords.filter((w) => words.has(w)).length;
        // Also check body overlap for better matching
        const bodyWords = p.body.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const bodyOverlap = bodyWords.filter((w) => words.has(w)).length;
        return { page: p, score: overlap * 3 + Math.min(bodyOverlap, 3) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return scored.map((s) => s.page);
  }, [selectedPage, pages]);

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
          {departments.length > 0 && (
            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="All departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.map((d) => (
                  <SelectItem key={d} value={d}>{d}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
            <Input
              value={newDepartment}
              onChange={(e) => setNewDepartment(e.target.value)}
              placeholder="Department scope (optional)..."
              className="text-xs h-8"
            />
            <div className="flex items-center gap-1">
              <Button size="sm" className="h-7 text-xs" disabled={!newTitle.trim() || createPage.isPending} onClick={() => createPage.mutate()}>
                {createPage.isPending ? "Creating..." : "Create"}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setCreating(false); setNewTitle(""); setNewDepartment(""); }}>Cancel</Button>
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
            <KBFolderTree
              pages={filteredPages}
              selectedPageId={selectedPageId}
              onSelectPage={(id) => { setSelectedPageId(id); setEditing(false); setShowHistory(false); }}
              onBulkDelete={async (ids) => {
                for (const id of ids) {
                  await knowledgeApi.remove(id).catch(() => {});
                }
                queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!) });
                if (selectedPageId && ids.includes(selectedPageId)) setSelectedPageId(null);
              }}
            />
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
            <div className="flex items-center gap-3 px-4 py-1.5 text-[10px] text-muted-foreground border-b border-border/50 shrink-0 flex-wrap">
              <span>Revision #{selectedPage.revisionNumber}</span>
              <span>·</span>
              <span>Updated {timeAgo(selectedPage.updatedAt)}</span>
              <span>·</span>
              {/* Visibility dropdown */}
              <Select
                value={selectedPage.visibility}
                onValueChange={(v) => updateVisibility.mutate(v)}
              >
                <SelectTrigger className="h-5 w-auto min-w-0 text-[10px] border-0 bg-transparent p-0 gap-1 shadow-none hover:bg-accent/50 rounded px-1.5">
                  <span className="inline-flex items-center gap-1">
                    {selectedPage.visibility === "company" && <Globe className="h-2.5 w-2.5" />}
                    {selectedPage.visibility === "private" && <Lock className="h-2.5 w-2.5" />}
                    {selectedPage.visibility === "project" && <ShieldCheck className="h-2.5 w-2.5" />}
                    <SelectValue />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="company">
                    <span className="inline-flex items-center gap-1.5">
                      <Globe className="h-3 w-3" />Everyone
                    </span>
                  </SelectItem>
                  <SelectItem value="private">
                    <span className="inline-flex items-center gap-1.5">
                      <Lock className="h-3 w-3" />Admins only
                    </span>
                  </SelectItem>
                  <SelectItem value="project">
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="h-3 w-3" />Specific agents
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              {selectedPage.department && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-0.5 text-blue-400">
                    <Users className="h-2.5 w-2.5" />{selectedPage.department}
                  </span>
                </>
              )}
              {selectedPage.agentId && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-0.5 text-purple-400">
                    <User className="h-2.5 w-2.5" />Agent-scoped
                  </span>
                </>
              )}
            </div>

            {/* Content area */}
            <div className="flex-1 overflow-y-auto">
              {showHistory ? (
                <div className="p-4 space-y-2">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Revision History</h3>
                    {compareRevision !== null && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCompareRevision(null)}>
                        <X className="h-3 w-3 mr-1" />Close Diff
                      </Button>
                    )}
                  </div>

                  {/* Version diff view */}
                  {compareRevision !== null && compareRevisionData && selectedPage && (
                    <div className="rounded-lg border border-border p-3 mb-3 space-y-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        Comparing: Revision #{compareRevision} vs Current (#{selectedPage.revisionNumber})
                      </div>
                      <SimpleDiff oldText={compareRevisionData.body} newText={selectedPage.body} />
                    </div>
                  )}

                  {(revisions ?? []).map((rev) => (
                    <div key={rev.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">Revision #{rev.revisionNumber}</div>
                        <div className="text-xs text-muted-foreground">
                          {rev.changeSummary ?? "No summary"} - {timeAgo(rev.createdAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {rev.revisionNumber !== selectedPage.revisionNumber && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => setCompareRevision(
                                compareRevision === rev.revisionNumber ? null : rev.revisionNumber,
                              )}
                            >
                              <Eye className="h-3 w-3 mr-1" />{compareRevision === rev.revisionNumber ? "Hide Diff" : "Compare"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={revertPage.isPending}
                              onClick={() => revertPage.mutate(rev.revisionNumber)}
                            >
                              <Undo2 className="h-3 w-3 mr-1" />Revert
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {(revisions ?? []).length === 0 && <p className="text-sm text-muted-foreground">No revisions yet.</p>}
                </div>
              ) : editing ? (
                <div className="flex flex-col h-full">
                  {/* Formatting toolbar */}
                  <FormattingToolbar
                    textareaRef={editBodyRef}
                    value={editBody}
                    onChange={setEditBody}
                  />
                  <textarea
                    ref={editBodyRef}
                    className="w-full flex-1 p-4 text-sm bg-transparent outline-none resize-none font-mono"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder="Write your page content in markdown..."
                  />
                </div>
              ) : (
                <div className="p-4 space-y-6">
                  {/* Wiki cross-links */}
                  <WikiLinkedBody
                    body={selectedPage.body}
                    pages={pages ?? []}
                    onNavigate={navigateToSlug}
                  />
                  {/* Issue reference chips */}
                  <IssueReferenceChips body={selectedPage.body} companyPrefix={selectedPage.companyId} />
                  {/* Auto table of contents */}
                  <AutoTableOfContents body={selectedPage.body} />
                  <MarkdownBody>{selectedPage.body}</MarkdownBody>

                  {/* Suggested pages */}
                  {suggestedPages.length > 0 && (
                    <div className="border-t border-border pt-4 mt-6">
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                        <LinkIcon className="h-3 w-3" />Suggested Pages
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {suggestedPages.map((sp) => (
                          <button
                            key={sp.id}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent/50 transition-colors"
                            onClick={() => {
                              setSelectedPageId(sp.id);
                              setEditing(false);
                              setShowHistory(false);
                            }}
                          >
                            <BookOpen className="h-3 w-3 text-muted-foreground" />
                            {sp.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Page Analytics */}
                  <PageAnalytics page={selectedPage} />
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

/**
 * Detect issue references (e.g. PAP-123) in page body and render as linked chips.
 */
function IssueReferenceChips({ body, companyPrefix: _companyPrefix }: { body: string; companyPrefix: string }) {
  const refs = useMemo(() => {
    const pattern = /\b([A-Z]{2,6}-\d{1,6})\b/g;
    const matches = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
      matches.add(match[1]);
    }
    return Array.from(matches);
  }, [body]);

  if (refs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pb-2">
      {refs.map((ref) => (
        <Link
          key={ref}
          to={`/issues`}
          className="inline-flex items-center gap-1 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-400 hover:bg-indigo-500/20 transition-colors"
        >
          <CircleDotIcon className="h-3 w-3" />
          {ref}
        </Link>
      ))}
    </div>
  );
}

function CircleDotIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

/**
 * Simple line-by-line text diff component.
 * Shows removed lines in red, added lines in green, unchanged lines dimmed.
 */
function SimpleDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Simple LCS-based diff
  const diff = computeLineDiff(oldLines, newLines);

  return (
    <div className="font-mono text-[11px] leading-5 overflow-x-auto max-h-64 overflow-y-auto rounded border border-border">
      {diff.map((line, i) => (
        <div
          key={i}
          className={cn(
            "px-3 py-0.5 whitespace-pre-wrap",
            line.type === "removed"
              ? "bg-red-500/10 text-red-400"
              : line.type === "added"
                ? "bg-emerald-500/10 text-emerald-400"
                : "text-muted-foreground/60",
          )}
        >
          <span className="inline-block w-4 text-right mr-2 select-none opacity-50">
            {line.type === "removed" ? "-" : line.type === "added" ? "+" : " "}
          </span>
          {line.text}
        </div>
      ))}
      {diff.length === 0 && (
        <div className="px-3 py-2 text-muted-foreground text-center">No differences found.</div>
      )}
    </div>
  );
}

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  text: string;
}

function computeLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Simple Myers-like diff using LCS
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "unchanged", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "added", text: newLines[j - 1] });
      j--;
    } else if (i > 0) {
      result.unshift({ type: "removed", text: oldLines[i - 1] });
      i--;
    }
  }

  return result;
}
