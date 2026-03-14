import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Plus, Save, Search, Trash2 } from "lucide-react";
import { knowledgeApi } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type DraftDocument = {
  title: string;
  category: string;
  tagsText: string;
  content: string;
};

const EMPTY_DRAFT: DraftDocument = {
  title: "",
  category: "",
  tagsText: "",
  content: "",
};

function parseTags(tagsText: string) {
  return Array.from(new Set(tagsText
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => tag.length > 0)));
}

function buildDraft(document: {
  title: string;
  category: string | null;
  tags: string[];
  content: string;
}): DraftDocument {
  return {
    title: document.title,
    category: document.category ?? "",
    tagsText: document.tags.join(", "),
    content: document.content,
  };
}

export function KnowledgeBase() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [draft, setDraft] = useState<DraftDocument>(EMPTY_DRAFT);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge Base" }]);
  }, [setBreadcrumbs]);

  const { data: documents, isLoading, error } = useQuery({
    queryKey: queryKeys.knowledge.list(selectedCompanyId!, search.trim()),
    queryFn: () => knowledgeApi.list(selectedCompanyId!, search.trim()),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    if (!documents || isCreatingNew) return;
    if (documents.length === 0) {
      setSelectedDocumentId(null);
      return;
    }
    const selectedStillVisible = selectedDocumentId
      ? documents.some((document) => document.id === selectedDocumentId)
      : false;
    if (!selectedStillVisible) {
      setSelectedDocumentId(documents[0]!.id);
    }
  }, [documents, isCreatingNew, selectedDocumentId]);

  const selectedDocument = useMemo(
    () => documents?.find((document) => document.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );

  useEffect(() => {
    if (isCreatingNew) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    if (selectedDocument) {
      setDraft(buildDraft(selectedDocument));
    }
  }, [isCreatingNew, selectedDocumentId]);

  const invalidateKnowledge = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.list(selectedCompanyId!, search.trim()) });
  };

  const createDocument = useMutation({
    mutationFn: () => knowledgeApi.create(selectedCompanyId!, {
      title: draft.title.trim(),
      category: draft.category.trim() || null,
      tags: parseTags(draft.tagsText),
      content: draft.content.trim(),
    }),
    onSuccess: async (document) => {
      setSaveError(null);
      setIsCreatingNew(false);
      setSelectedDocumentId(document.id);
      await invalidateKnowledge();
    },
    onError: (mutationError) => {
      setSaveError(mutationError instanceof Error ? mutationError.message : "Failed to create knowledge document");
    },
  });

  const updateDocument = useMutation({
    mutationFn: () => knowledgeApi.update(selectedDocumentId!, {
      title: draft.title.trim(),
      category: draft.category.trim() || null,
      tags: parseTags(draft.tagsText),
      content: draft.content.trim(),
    }),
    onSuccess: async () => {
      setSaveError(null);
      await invalidateKnowledge();
    },
    onError: (mutationError) => {
      setSaveError(mutationError instanceof Error ? mutationError.message : "Failed to update knowledge document");
    },
  });

  const deleteDocument = useMutation({
    mutationFn: () => knowledgeApi.remove(selectedDocumentId!),
    onSuccess: async () => {
      setSaveError(null);
      setSelectedDocumentId(null);
      await invalidateKnowledge();
    },
    onError: (mutationError) => {
      setSaveError(mutationError instanceof Error ? mutationError.message : "Failed to delete knowledge document");
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpen} message="Select a company to view its knowledge base." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const isSaving = createDocument.isPending || updateDocument.isPending;

  function handleBeginCreate() {
    setSaveError(null);
    setSelectedDocumentId(null);
    setIsCreatingNew(true);
    setDraft(EMPTY_DRAFT);
  }

  function handleSelectDocument(documentId: string) {
    setSaveError(null);
    setIsCreatingNew(false);
    setSelectedDocumentId(documentId);
  }

  function handleSave() {
    if (draft.title.trim().length === 0 || draft.content.trim().length === 0) {
      setSaveError("Title and content are required.");
      return;
    }
    if (isCreatingNew) {
      createDocument.mutate();
      return;
    }
    if (!selectedDocumentId) {
      setSaveError("Select a document before saving.");
      return;
    }
    updateDocument.mutate();
  }

  function handleDelete() {
    if (!selectedDocumentId || !selectedDocument) return;
    if (!window.confirm(`Delete knowledge document \"${selectedDocument.title}\"?`)) return;
    deleteDocument.mutate();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <section className="border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search knowledge"
              className="pl-8"
            />
          </div>
          <Button size="sm" variant="outline" onClick={handleBeginCreate}>
            <Plus className="mr-1 h-4 w-4" />
            New
          </Button>
        </div>

        {error && <p className="px-3 py-2 text-sm text-destructive">{error.message}</p>}

        <div className="max-h-[70vh] overflow-y-auto">
          {documents && documents.length > 0 ? (
            documents.map((document) => {
              const active = !isCreatingNew && document.id === selectedDocumentId;
              return (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => handleSelectDocument(document.id)}
                  className={`flex w-full flex-col gap-1 border-b border-border px-3 py-3 text-left transition-colors ${active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{document.title}</span>
                    {document.category && (
                      <span className="shrink-0 text-xs text-muted-foreground">{document.category}</span>
                    )}
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {document.content.trim().slice(0, 140) || "No content yet."}
                  </p>
                  {document.tags.length > 0 && (
                    <p className="text-xs text-muted-foreground">#{document.tags.join(" #")}</p>
                  )}
                </button>
              );
            })
          ) : (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              {search.trim().length > 0
                ? "No documents match this search."
                : "No knowledge documents yet. Capture architecture, process, and decisions here."}
            </div>
          )}
        </div>
      </section>

      <section className="border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <h1 className="text-sm font-semibold">
              {isCreatingNew ? "New knowledge document" : selectedDocument?.title ?? "Knowledge document"}
            </h1>
            <p className="text-xs text-muted-foreground">
              Keep durable company context here so future agent work can reuse decisions instead of rediscovering them.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!isCreatingNew && selectedDocumentId && (
              <Button size="sm" variant="ghost" onClick={handleDelete} disabled={deleteDocument.isPending}>
                <Trash2 className="mr-1 h-4 w-4" />
                Delete
              </Button>
            )}
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              <Save className="mr-1 h-4 w-4" />
              {isCreatingNew ? "Create" : "Save"}
            </Button>
          </div>
        </div>

        <div className="space-y-4 px-4 py-4">
          {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Title</span>
              <Input
                value={draft.title}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                placeholder="Architecture decisions"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Category</span>
              <Input
                value={draft.category}
                onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}
                placeholder="architecture"
              />
            </label>
          </div>

          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Tags</span>
            <Input
              value={draft.tagsText}
              onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
              placeholder="database, auth, onboarding"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Content</span>
            <Textarea
              value={draft.content}
              onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
              placeholder="Capture the decision, why it was made, and what future changes must respect."
              className="min-h-[420px]"
            />
          </label>
        </div>
      </section>
    </div>
  );
}