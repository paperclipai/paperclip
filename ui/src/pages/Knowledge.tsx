import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Globe2, Plus } from "lucide-react";
import type { CreateKnowledgeItem, KnowledgeItem } from "@paperclipai/shared";
import { knowledgeApi } from "../api/knowledge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { getKnowledgeLibraryAuxiliaryText } from "../lib/knowledge-library";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { KnowledgeLibraryCard } from "../components/KnowledgeLibraryCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { KnowledgeDeleteDialog } from "../components/KnowledgeDeleteDialog";
import { KnowledgeEditorDialog } from "../components/KnowledgeEditorDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type DraftKind = "note" | "url";

function buildPayload(
  kind: DraftKind,
  values: {
    title: string;
    summary: string;
    body: string;
    sourceUrl: string;
  }
): CreateKnowledgeItem {
  if (kind === "url") {
    return {
      title: values.title.trim(),
      kind: "url",
      summary: values.summary.trim() ? values.summary.trim() : undefined,
      sourceUrl: values.sourceUrl.trim(),
    };
  }

  return {
    title: values.title.trim(),
    kind: "note",
    summary: values.summary.trim() ? values.summary.trim() : undefined,
    body: values.body.trim(),
  };
}

export function Knowledge() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<DraftKind>("note");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [body, setBody] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [editingItem, setEditingItem] = useState<KnowledgeItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<KnowledgeItem | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge" }]);
  }, [setBreadcrumbs]);

  const knowledgeQuery = useQuery({
    queryKey: queryKeys.knowledge.list(selectedCompanyId!),
    queryFn: () => knowledgeApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createKnowledge = useMutation({
    mutationFn: (payload: CreateKnowledgeItem) =>
      knowledgeApi.create(selectedCompanyId!, payload),
    onSuccess: async () => {
      setTitle("");
      setSummary("");
      setBody("");
      setSourceUrl("");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.knowledge.list(selectedCompanyId!),
      });
      pushToast({ title: "Knowledge item created", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title:
          error instanceof Error
            ? error.message
            : "Failed to create knowledge item",
        tone: "error",
      });
    },
  });

  const canSubmit = useMemo(() => {
    if (!title.trim()) return false;
    if (kind === "note") return body.trim().length > 0;
    return sourceUrl.trim().length > 0;
  }, [body, kind, sourceUrl, title]);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={BookOpen}
        message="Select a company to manage shared knowledge."
      />
    );
  }

  if (knowledgeQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <>
      <div className="space-y-6">
        <div className="grid gap-6 pt-3 xl:grid-cols-[minmax(320px,420px)_minmax(0,1fr)] xl:items-start">
          <Card className="gap-0 self-start py-0">
            <CardHeader className="border-b pt-6 pb-5">
              <CardTitle className="text-sm font-semibold">
                Create knowledge
              </CardTitle>
              <CardDescription>
                Shared notes and reference links that can be attached to future
                issues.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4 py-6">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={kind === "note" ? "default" : "outline"}
                  onClick={() => setKind("note")}
                >
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Note
                </Button>
                <Button
                  size="sm"
                  variant={kind === "url" ? "default" : "outline"}
                  onClick={() => setKind("url")}
                >
                  <Globe2 className="mr-1.5 h-3.5 w-3.5" />
                  URL
                </Button>
              </div>

              <div className="space-y-3">
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Title"
                />
                <Input
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  placeholder="Summary (optional)"
                />
                {kind === "note" ? (
                  <Textarea
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                    placeholder="Write the reusable note..."
                    className="min-h-40"
                  />
                ) : (
                  <Input
                    value={sourceUrl}
                    onChange={(event) => setSourceUrl(event.target.value)}
                    placeholder="https://example.com/reference"
                  />
                )}
              </div>

              <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
                Asset-backed knowledge is already supported by the API. This
                first UI keeps creation focused on notes and URLs.
              </div>
            </CardContent>

            <CardFooter className="justify-end border-t py-4">
              <Button
                disabled={!canSubmit || createKnowledge.isPending}
                onClick={() =>
                  createKnowledge.mutate(
                    buildPayload(kind, { title, summary, body, sourceUrl })
                  )
                }
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {createKnowledge.isPending ? "Creating..." : "Create Knowledge"}
              </Button>
            </CardFooter>
          </Card>

          <section className="space-y-5">
            <div className="flex items-end justify-between gap-3 pt-1">
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold">Company library</h2>
                <p className="text-xs text-muted-foreground">
                  Reusable context for future issue runs.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {(knowledgeQuery.data ?? []).length} items
              </span>
            </div>

            {knowledgeQuery.error && (
              <p className="text-sm text-destructive">
                {knowledgeQuery.error.message}
              </p>
            )}

            {!knowledgeQuery.data || knowledgeQuery.data.length === 0 ? (
              <EmptyState icon={BookOpen} message="No shared knowledge yet." />
            ) : (
              <div className="space-y-3">
                {knowledgeQuery.data.map((item) => {
                  const auxiliaryText = getKnowledgeLibraryAuxiliaryText(item);
                  const descriptionText = item.summary ?? auxiliaryText;

                  return (
                    <KnowledgeLibraryCard
                      key={item.id}
                      item={item}
                      descriptionText={descriptionText}
                      updatedLabel={`Updated ${timeAgo(item.updatedAt)}`}
                      onEdit={() => setEditingItem(item)}
                      onDelete={() => setDeletingItem(item)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </div>

      <KnowledgeEditorDialog
        item={editingItem}
        open={!!editingItem}
        onOpenChange={(open) => {
          if (!open) setEditingItem(null);
        }}
      />
      <KnowledgeDeleteDialog
        item={deletingItem}
        open={!!deletingItem}
        onOpenChange={(open) => {
          if (!open) setDeletingItem(null);
        }}
      />
    </>
  );
}
