import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search, X } from "lucide-react";
import type { Agent, CompanyDocumentSummary } from "@paperclipai/shared";
import { buildDocumentReferenceHref } from "@paperclipai/shared";
import { documentsApi } from "../api/documents";
import { queryKeys } from "../lib/queryKeys";
import { useIssueLinkedDocuments } from "../hooks/useIssueLinkedDocuments";
import { DocumentRow, type DocumentOwner } from "./documents/DocumentRow";
import { hasOpenDocumentFeedback } from "./documents/DocumentFeedbackCounts";
import { EmptyState } from "./EmptyState";
import { PageSkeleton } from "./PageSkeleton";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/** Find the inline issue-document key for a company document linked to this issue. */
function issueDocumentKeyFor(doc: CompanyDocumentSummary, issueId: string): string | null {
  const link = doc.backlinks.find(
    (backlink) => backlink.targetType === "issue" && backlink.targetId === issueId,
  );
  return link?.issueDocumentKey ?? null;
}

function isPlanDocument(doc: CompanyDocumentSummary, issueId: string): boolean {
  return issueDocumentKeyFor(doc, issueId) === "plan";
}

export interface IssueDocumentsTabProps {
  issueId: string;
  companyId: string;
  issueIdentifier: string | null;
  agentMap?: ReadonlyMap<string, Pick<Agent, "id" | "name">>;
}

/**
 * "Documents" tab on the issue detail. Surfaces every company document linked to the
 * issue (its inline issue documents plus cross-linked company docs), reusing the
 * library `DocumentRow`. The plan document is pinned to the top; the header has a
 * search scoped to this issue and an "Add document" control (link existing / create new).
 */
export function IssueDocumentsTab({ issueId, companyId, issueIdentifier, agentMap }: IssueDocumentsTabProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);

  const { documents, isLoading } = useIssueLinkedDocuments(companyId, issueId, { search });

  const ownerById = useMemo(() => {
    const map = new Map<string, DocumentOwner>();
    if (agentMap) {
      for (const agent of agentMap.values()) map.set(agent.id, { name: agent.name });
    }
    return map;
  }, [agentMap]);

  const sortedDocuments = useMemo(() => {
    return [...documents].sort((a, b) => {
      const aPlan = isPlanDocument(a, issueId);
      const bPlan = isPlanDocument(b, issueId);
      if (aPlan && !bPlan) return -1;
      if (!aPlan && bPlan) return 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [documents, issueId]);

  const linkExisting = useMutation({
    mutationFn: (documentId: string) =>
      documentsApi.createLink(companyId, documentId, { targetType: "issue", targetId: issueId }),
    onSuccess: () => {
      setLinkPickerOpen(false);
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search this issue's documents..."
            aria-label="Search issue documents"
            className="h-9 pl-9 pr-9 text-sm"
          />
          {search.length > 0 ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear document search"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 shrink-0">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add document
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => setLinkPickerOpen(true)}>
              Link existing document…
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href="#document-new">Create new document in Chat</a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : sortedDocuments.length === 0 ? (
        search.length > 0 ? (
          <EmptyState icon={FileText} message="No linked documents match this search." />
        ) : (
          <EmptyState
            icon={FileText}
            message="Only the plan document is linked. Add a spec, brief, or report to keep more context here."
            action="Add document"
            onAction={() => setLinkPickerOpen(true)}
          />
        )
      ) : (
        <div className="overflow-hidden rounded-md border border-border">
          {sortedDocuments.map((doc) => {
            const key = issueDocumentKeyFor(doc, issueId);
            return (
              <DocumentRow
                key={doc.id}
                document={doc}
                to={buildDocumentReferenceHref(doc.id, key ?? issueIdentifier)}
                identifier={key ?? undefined}
                owner={doc.ownerAgentId ? ownerById.get(doc.ownerAgentId) ?? null : null}
              />
            );
          })}
        </div>
      )}

      <LinkExistingDocumentPicker
        open={linkPickerOpen}
        onOpenChange={setLinkPickerOpen}
        companyId={companyId}
        linkedIds={new Set(documents.map((doc) => doc.id))}
        onSelect={(documentId) => linkExisting.mutate(documentId)}
        pending={linkExisting.isPending}
      />
    </div>
  );
}

function LinkExistingDocumentPicker({
  open,
  onOpenChange,
  companyId,
  linkedIds,
  onSelect,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  linkedIds: Set<string>;
  onSelect: (documentId: string) => void;
  pending: boolean;
}) {
  const { data: allDocuments } = useQuery({
    queryKey: queryKeys.documents.list(companyId, { picker: true }),
    queryFn: () => documentsApi.list(companyId, { limit: 100 }),
    enabled: open && Boolean(companyId),
  });

  const candidates = useMemo(
    () => (allDocuments ?? []).filter((doc) => !linkedIds.has(doc.id)),
    [allDocuments, linkedIds],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search company documents to link..." />
      <CommandList>
        <CommandEmpty>No documents found.</CommandEmpty>
        <CommandGroup heading="Documents">
          {candidates.map((doc) => (
            <CommandItem
              key={doc.id}
              value={`${doc.title ?? "Untitled document"} ${doc.id}`}
              disabled={pending}
              onSelect={() => onSelect(doc.id)}
            >
              <FileText className="mr-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{doc.title ?? "Untitled document"}</span>
              {hasOpenDocumentFeedback(doc.feedbackCounts) ? (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              ) : null}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
