import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyDocument, CompanyDocumentRevision } from "@paperclipai/shared";
import { FileText, History, Plus, Save, Trash2, X } from "lucide-react";
import { ApiError } from "@/api/client";
import { companyDocumentsApi } from "@/api/companyDocuments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useParams } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";

function hashSlugMatchesKey(slug: string, key: string): boolean {
  if (slug === key) return true;
  return slug === key.replace(/[/.]/g, "-");
}

const DOCUMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type ViewMode = "view" | "edit" | "create";

type DraftState = {
  key: string;
  title: string;
  body: string;
};

function isApiConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

function revisionActorLabel(revision: CompanyDocumentRevision) {
  if (revision.createdByUserId) return "board";
  if (revision.createdByAgentId) return "agent";
  return "system";
}

export function CompanyDocuments() {
  const { selectedCompany, selectedCompanyId, companies, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const routeParams = useParams<{ companyId?: string }>();
  const location = useLocation();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("view");
  const [draft, setDraft] = useState<DraftState>({ key: "", title: "", body: "" });
  const [showRevisions, setShowRevisions] = useState(false);
  const consumedHashRef = useRef<string | null>(null);

  useEffect(() => {
    const paramCompanyId = routeParams.companyId;
    if (!paramCompanyId || paramCompanyId === selectedCompanyId) return;
    const exists = companies.some((c) => c.id === paramCompanyId);
    if (exists) setSelectedCompanyId(paramCompanyId);
  }, [routeParams.companyId, selectedCompanyId, companies, setSelectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Documents" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.companyDocuments.list(selectedCompanyId ?? ""),
    queryFn: () => companyDocumentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const documents = listQuery.data ?? [];
  const selectedDocument = useMemo(
    () => (selectedKey ? documents.find((d) => d.key === selectedKey) ?? null : null),
    [documents, selectedKey],
  );

  useEffect(() => {
    const hash = location.hash;
    if (!hash || !hash.startsWith("#document-")) return;
    if (consumedHashRef.current === hash) return;
    if (documents.length === 0) return;
    const slug = hash.slice("#document-".length);
    if (!slug) return;
    const match = documents.find((d) => hashSlugMatchesKey(slug, d.key));
    if (!match) return;
    consumedHashRef.current = hash;
    setSelectedKey(match.key);
    setMode("view");
    setShowRevisions(false);
  }, [location.hash, documents]);

  useEffect(() => {
    if (selectedDocument && mode === "view") {
      setDraft({
        key: selectedDocument.key,
        title: selectedDocument.title ?? "",
        body: selectedDocument.body,
      });
    }
  }, [selectedDocument, mode]);

  const revisionsQuery = useQuery({
    queryKey: queryKeys.companyDocuments.revisions(selectedCompanyId ?? "", selectedKey ?? ""),
    queryFn: () => companyDocumentsApi.listRevisions(selectedCompanyId!, selectedKey!),
    enabled: !!selectedCompanyId && !!selectedKey && showRevisions,
  });

  const upsertMutation = useMutation({
    mutationFn: async (input: { key: string; title: string; body: string; baseRevisionId: string | null }) => {
      return companyDocumentsApi.upsert(selectedCompanyId!, input.key, {
        title: input.title || null,
        format: "markdown",
        body: input.body,
        baseRevisionId: input.baseRevisionId,
      });
    },
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyDocuments.list(selectedCompanyId ?? "") });
      setSelectedKey(doc.key);
      setMode("view");
      pushToast({ title: "Saved", body: `Document "${doc.key}" saved.`, tone: "success" });
    },
    onError: (error: unknown) => {
      if (isApiConflict(error)) {
        pushToast({
          title: "Conflict",
          body: error.message,
          tone: "warn",
        });
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to save document";
      pushToast({ title: "Save failed", body: message, tone: "error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => companyDocumentsApi.remove(selectedCompanyId!, key),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyDocuments.list(selectedCompanyId ?? "") });
      setSelectedKey(null);
      setMode("view");
      pushToast({ title: "Deleted", body: "Document removed.", tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to delete";
      pushToast({ title: "Delete failed", body: message, tone: "error" });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (revisionId: string) =>
      companyDocumentsApi.restoreRevision(selectedCompanyId!, selectedKey!, revisionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companyDocuments.list(selectedCompanyId ?? "") });
      queryClient.invalidateQueries({
        queryKey: queryKeys.companyDocuments.revisions(selectedCompanyId ?? "", selectedKey ?? ""),
      });
      pushToast({ title: "Restored", body: "Revision restored as the latest version.", tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : "Failed to restore";
      pushToast({ title: "Restore failed", body: message, tone: "error" });
    },
  });

  function startCreate() {
    setMode("create");
    setSelectedKey(null);
    setDraft({ key: "", title: "", body: "" });
  }

  function startEdit() {
    if (!selectedDocument) return;
    setMode("edit");
    setDraft({
      key: selectedDocument.key,
      title: selectedDocument.title ?? "",
      body: selectedDocument.body,
    });
  }

  function cancelEdit() {
    setMode("view");
    if (selectedDocument) {
      setDraft({
        key: selectedDocument.key,
        title: selectedDocument.title ?? "",
        body: selectedDocument.body,
      });
    }
  }

  function save() {
    const normalizedKey = draft.key.trim().toLowerCase();
    if (!DOCUMENT_KEY_PATTERN.test(normalizedKey)) {
      pushToast({
        title: "Invalid key",
        body: "Use lowercase letters, digits, '-' or '_' (max 64 chars).",
        tone: "warn",
      });
      return;
    }
    if (!draft.body.trim()) {
      pushToast({ title: "Empty body", body: "Document body cannot be empty.", tone: "warn" });
      return;
    }
    const baseRevisionId = mode === "edit" ? selectedDocument?.latestRevisionId ?? null : null;
    upsertMutation.mutate({
      key: normalizedKey,
      title: draft.title.trim(),
      body: draft.body,
      baseRevisionId,
    });
  }

  if (!selectedCompanyId) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">
        Select a company to view its documents.
      </div>
    );
  }

  const isWriting = mode === "edit" || mode === "create";

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Company Documents</h1>
          <p className="text-sm text-muted-foreground">
            Shared markdown documents for {selectedCompany?.name ?? "this company"}.
          </p>
        </div>
        <Button onClick={startCreate} disabled={isWriting}>
          <Plus className="mr-2 h-4 w-4" />
          New document
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 gap-4">
        <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
          {listQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading...</div>
          ) : documents.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No documents yet. Create one to get started.
            </div>
          ) : (
            <ul>
              {documents.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedKey(doc.key);
                      setMode("view");
                      setShowRevisions(false);
                    }}
                    className={cn(
                      "flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left text-sm transition hover:bg-muted",
                      selectedKey === doc.key && "bg-muted",
                    )}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{doc.title || doc.key}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {doc.key} · rev {doc.latestRevisionNumber} · {relativeTime(doc.updatedAt)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card p-4">
          {!selectedDocument && mode !== "create" ? (
            <div className="text-sm text-muted-foreground">
              Select a document from the list or create a new one.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-1 flex-col gap-2">
                  {isWriting ? (
                    <>
                      <Input
                        placeholder="key (lowercase, '-'/'_')"
                        value={draft.key}
                        onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))}
                        disabled={mode === "edit"}
                      />
                      <Input
                        placeholder="Title (optional)"
                        value={draft.title}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                      />
                    </>
                  ) : (
                    <div>
                      <h2 className="text-lg font-semibold">
                        {selectedDocument?.title || selectedDocument?.key}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {selectedDocument?.key} · revision {selectedDocument?.latestRevisionNumber} ·
                        updated {selectedDocument ? relativeTime(selectedDocument.updatedAt) : ""}
                        {selectedDocument?.lockedAt ? " · locked" : ""}
                      </p>
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  {isWriting ? (
                    <>
                      <Button
                        variant="ghost"
                        onClick={cancelEdit}
                        disabled={upsertMutation.isPending}
                      >
                        <X className="mr-2 h-4 w-4" />
                        Cancel
                      </Button>
                      <Button onClick={save} disabled={upsertMutation.isPending}>
                        <Save className="mr-2 h-4 w-4" />
                        {upsertMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                    </>
                  ) : selectedDocument ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => setShowRevisions((v) => !v)}
                      >
                        <History className="mr-2 h-4 w-4" />
                        {showRevisions ? "Hide history" : "History"}
                      </Button>
                      <Button onClick={startEdit} disabled={!!selectedDocument.lockedAt}>
                        Edit
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          if (window.confirm(`Delete document "${selectedDocument.key}"?`)) {
                            deleteMutation.mutate(selectedDocument.key);
                          }
                        }}
                        disabled={deleteMutation.isPending || !!selectedDocument.lockedAt}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              {isWriting ? (
                <MarkdownEditor
                  value={draft.body}
                  onChange={(value) => setDraft((d) => ({ ...d, body: value }))}
                  placeholder="Document body (Markdown)..."
                  className="min-h-[300px]"
                />
              ) : selectedDocument ? (
                <MarkdownBody>{selectedDocument.body}</MarkdownBody>
              ) : null}

              {!isWriting && showRevisions && selectedDocument ? (
                <RevisionList
                  revisions={revisionsQuery.data ?? []}
                  isLoading={revisionsQuery.isLoading}
                  currentRevisionId={selectedDocument.latestRevisionId}
                  isLocked={!!selectedDocument.lockedAt}
                  onRestore={(revisionId) => {
                    if (window.confirm("Restore this revision as the latest version?")) {
                      restoreMutation.mutate(revisionId);
                    }
                  }}
                  isRestoring={restoreMutation.isPending}
                />
              ) : null}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function RevisionList({
  revisions,
  isLoading,
  currentRevisionId,
  isLocked,
  onRestore,
  isRestoring,
}: {
  revisions: CompanyDocumentRevision[];
  isLoading: boolean;
  currentRevisionId: string | null;
  isLocked: boolean;
  onRestore: (revisionId: string) => void;
  isRestoring: boolean;
}) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading revisions...</div>;
  }
  if (revisions.length === 0) {
    return <div className="text-sm text-muted-foreground">No revisions yet.</div>;
  }
  return (
    <div className="rounded-md border border-border">
      <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">Revision history</h3>
      <ul className="divide-y divide-border">
        {revisions.map((rev) => {
          const isCurrent = rev.id === currentRevisionId;
          return (
            <li key={rev.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm">
                  Revision {rev.revisionNumber}
                  {isCurrent ? <span className="ml-2 text-xs text-muted-foreground">(current)</span> : null}
                </div>
                <div className="text-xs text-muted-foreground">
                  {relativeTime(rev.createdAt)} · {revisionActorLabel(rev)}
                  {rev.changeSummary ? ` · ${rev.changeSummary}` : ""}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={isCurrent || isLocked || isRestoring}
                onClick={() => onRestore(rev.id)}
              >
                Restore
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
