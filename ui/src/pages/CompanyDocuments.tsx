import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanyDocument } from "@paperclipai/shared";
import { FileText, History, Plus, Save, Trash2 } from "lucide-react";
import { useNavigate, useParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { companiesApi } from "../api/companies";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";

type DraftDocument = {
  id: string | null;
  title: string;
  format: "markdown";
  body: string;
  baseRevisionId: string | null;
};

function toDraft(document: CompanyDocument): DraftDocument {
  return {
    id: document.id,
    title: document.title ?? "",
    format: document.format,
    body: document.body,
    baseRevisionId: document.latestRevisionId,
  };
}

function createBlankDraft(): DraftDocument {
  return {
    id: null,
    title: "",
    format: "markdown",
    body: "",
    baseRevisionId: null,
  };
}

export function CompanyDocuments() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { documentId } = useParams<{ documentId?: string }>();
  const [draft, setDraft] = useState<DraftDocument>(createBlankDraft);
  const [creatingNew, setCreatingNew] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Documents" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const { data: documents = [] } = useQuery({
    queryKey: queryKeys.companies.documents(selectedCompanyId!),
    queryFn: () => companiesApi.listDocuments(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const selectedDocument = useMemo(() => {
    if (creatingNew) return null;
    if (!documents.length) return null;
    if (documentId) {
      return documents.find((document) => document.id === documentId) ?? documents[0] ?? null;
    }
    return documents[0] ?? null;
  }, [creatingNew, documentId, documents]);

  useEffect(() => {
    if (creatingNew) return;
    if (selectedDocument) {
      setDraft(toDraft(selectedDocument));
      return;
    }
    setDraft(createBlankDraft());
  }, [creatingNew, selectedDocument?.id, selectedDocument?.latestRevisionId]);

  const { data: revisions = [] } = useQuery({
    queryKey: queryKeys.companies.documentRevisions(selectedCompanyId!, selectedDocument?.id ?? ""),
    queryFn: () => companiesApi.listDocumentRevisions(selectedCompanyId!, selectedDocument!.id),
    enabled: !!selectedCompanyId && !!selectedDocument?.id && !creatingNew,
  });

  const filteredDocuments = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((document) => {
      const haystack = `${document.title ?? ""}\n${document.body}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [documents, search]);

  const draftDirty = useMemo(() => {
    if (creatingNew) {
      return draft.title.trim().length > 0 || draft.body.trim().length > 0;
    }
    if (!selectedDocument) return false;
    return (
      draft.title !== (selectedDocument.title ?? "")
      || draft.body !== selectedDocument.body
      || draft.format !== selectedDocument.format
    );
  }, [creatingNew, draft, selectedDocument]);

  const saveDocument = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) throw new Error("No company selected");
      const title = draft.title.trim();
      if (!title) throw new Error("Document title is required");
      if (!draft.body.trim()) throw new Error("Document body is required");
      if (creatingNew || !draft.id) {
        return companiesApi.createDocument(selectedCompanyId, {
          title,
          format: draft.format,
          body: draft.body,
        });
      }
      return companiesApi.updateDocument(selectedCompanyId, draft.id, {
        title,
        format: draft.format,
        body: draft.body,
        baseRevisionId: draft.baseRevisionId,
      });
    },
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.documents(selectedCompanyId!) });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.documentRevisions(selectedCompanyId!, document.id),
      });
      setCreatingNew(false);
      setDraft(toDraft(document));
      navigate(`/company/documents/${document.id}`);
      pushToast({
        title: creatingNew ? "Document created" : "Document saved",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to save document",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const deleteDocument = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !selectedDocument) throw new Error("No document selected");
      return companiesApi.deleteDocument(selectedCompanyId, selectedDocument.id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.documents(selectedCompanyId!) });
      setCreatingNew(false);
      setDraft(createBlankDraft());
      navigate("/company/documents");
      pushToast({ title: "Document deleted", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to delete document",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const restoreRevision = useMutation({
    mutationFn: async (revisionId: string) => {
      if (!selectedCompanyId || !selectedDocument) throw new Error("No document selected");
      return companiesApi.restoreDocumentRevision(selectedCompanyId, selectedDocument.id, revisionId);
    },
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.documents(selectedCompanyId!) });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.documentRevisions(selectedCompanyId!, document.id),
      });
      setDraft(toDraft(document));
      pushToast({ title: "Revision restored", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to restore revision",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  function selectDocument(nextDocument: CompanyDocument) {
    setCreatingNew(false);
    navigate(`/company/documents/${nextDocument.id}`);
  }

  function startNewDocument() {
    setCreatingNew(true);
    setDraft(createBlankDraft());
    navigate("/company/documents");
  }

  if (!selectedCompanyId || !selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Company Documents</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Canonical operating documents for this company. Use these for execution briefs, tone profiles,
          QA plans, and other staff-managed guidance.
        </p>
        <div className="flex gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search documents..."
          />
          <Button type="button" variant="outline" onClick={startNewDocument}>
            <Plus className="mr-1.5 h-4 w-4" />
            New
          </Button>
        </div>
        <div className="rounded-lg border border-border">
          {filteredDocuments.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              {documents.length === 0 ? "No company documents yet." : "No matching documents."}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredDocuments.map((document) => {
                const active = !creatingNew && selectedDocument?.id === document.id;
                return (
                  <button
                    key={document.id}
                    type="button"
                    onClick={() => selectDocument(document)}
                    className={`block w-full px-4 py-3 text-left transition-colors ${active ? "bg-accent/70" : "hover:bg-accent/40"}`}
                  >
                    <div className="truncate text-sm font-medium">{document.title ?? "Untitled document"}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Updated {relativeTime(document.updatedAt)} • rev {document.latestRevisionNumber}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-4">
        {documents.length === 0 && !creatingNew ? (
          <div className="rounded-lg border border-dashed border-border bg-card">
            <EmptyState
              icon={FileText}
              message="No company documents yet. Create your first canonical document here."
              action="Create document"
              onAction={startNewDocument}
            />
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Document title"
                  className="min-w-[220px] flex-1"
                />
                <Button
                  type="button"
                  onClick={() => saveDocument.mutate()}
                  disabled={!draftDirty || saveDocument.isPending}
                >
                  <Save className="mr-1.5 h-4 w-4" />
                  {saveDocument.isPending ? "Saving..." : creatingNew ? "Create" : "Save"}
                </Button>
                {!creatingNew && selectedDocument ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => deleteDocument.mutate()}
                    disabled={deleteDocument.isPending}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" />
                    {deleteDocument.isPending ? "Deleting..." : "Delete"}
                  </Button>
                ) : null}
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                {creatingNew
                  ? "New document"
                  : selectedDocument
                    ? `Revision ${selectedDocument.latestRevisionNumber} • updated ${relativeTime(selectedDocument.updatedAt)}`
                    : "Select a document"}
              </div>
              <div className="mt-4 rounded-md border border-border">
                <MarkdownEditor
                  value={draft.body}
                  onChange={(value) => setDraft((current) => ({ ...current, body: value }))}
                  placeholder="Write the document body in Markdown..."
                  className="min-h-[380px]"
                  contentClassName="min-h-[340px] px-4 py-3"
                />
              </div>
            </div>

            {selectedDocument && !creatingNew ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-medium">Revision History</h2>
                </div>
                <div className="mt-3 space-y-3">
                  {revisions.slice(0, 8).map((revision) => {
                    const isCurrent = revision.id === selectedDocument.latestRevisionId;
                    return (
                      <div key={revision.id} className="rounded-md border border-border px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium">rev {revision.revisionNumber}</span>
                          <span className="text-muted-foreground">{relativeTime(revision.createdAt)}</span>
                          {isCurrent ? <span className="text-xs text-primary">Current</span> : null}
                        </div>
                        {revision.changeSummary ? (
                          <div className="mt-1 text-xs text-muted-foreground">{revision.changeSummary}</div>
                        ) : null}
                        {!isCurrent ? (
                          <div className="mt-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => restoreRevision.mutate(revision.id)}
                              disabled={restoreRevision.isPending}
                            >
                              Restore
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {!creatingNew && selectedDocument ? (
              <div className="rounded-lg border border-border bg-card p-4">
                <h2 className="text-sm font-medium">Rendered Preview</h2>
                <div className="mt-3 rounded-md border border-border px-4 py-3">
                  <MarkdownBody className="prose prose-slate max-w-none text-sm dark:prose-invert">
                    {draft.body}
                  </MarkdownBody>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
