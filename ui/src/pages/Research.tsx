import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Microscope, Search as SearchIcon } from "lucide-react";
import type { ResearchDocument } from "@paperclipai/shared";
import { researchDocumentsApi } from "../api/researchDocuments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ALL_STARTERS = "__all__";

function researchDocumentHref(doc: ResearchDocument): string {
  const issueRef = doc.issueIdentifier ?? doc.issueId;
  return `/issues/${issueRef}#document-${encodeURIComponent(doc.key)}`;
}

export function Research() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [startedBy, setStartedBy] = useState<string>(ALL_STARTERS);

  useEffect(() => {
    setBreadcrumbs([{ label: "Research" }]);
  }, [setBreadcrumbs]);

  const { data: documents, isLoading } = useQuery({
    queryKey: queryKeys.researchDocuments.list(selectedCompanyId!),
    queryFn: () => researchDocumentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const starters = useMemo(() => {
    const labels = new Set<string>();
    for (const doc of documents ?? []) labels.add(doc.startedByLabel);
    return [...labels].sort((a, b) => a.localeCompare(b));
  }, [documents]);

  const filteredDocuments = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (documents ?? []).filter((doc) => {
      if (startedBy !== ALL_STARTERS && doc.startedByLabel !== startedBy) return false;
      if (!query) return true;
      const haystack =
        `${doc.title ?? ""} ${doc.issueTitle ?? ""} ${doc.excerpt} ${doc.issueIdentifier ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [documents, search, startedBy]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Microscope} message="Select a company to view research documents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if ((documents ?? []).length === 0) {
    return (
      <EmptyState
        icon={Microscope}
        message="No research documents yet. When an agent records findings in a task's research document, they show up here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search research..."
            className="pl-9"
            aria-label="Search research documents"
          />
        </div>
        <Select value={startedBy} onValueChange={setStartedBy}>
          <SelectTrigger className="w-[220px]" aria-label="Filter by who started the research">
            <SelectValue placeholder="Started by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STARTERS}>Started by anyone</SelectItem>
            {starters.map((label) => (
              <SelectItem key={label} value={label}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filteredDocuments.length === 0 ? (
        <EmptyState icon={SearchIcon} message="No research documents match your filters." />
      ) : (
        <div className="border border-border">
          {filteredDocuments.map((doc) => (
            <EntityRow
              key={doc.documentId}
              identifier={doc.issueIdentifier ?? undefined}
              title={doc.title || doc.issueTitle || "Untitled research"}
              subtitle={doc.excerpt || undefined}
              to={researchDocumentHref(doc)}
              leading={<Microscope className="h-4 w-4 text-muted-foreground" />}
              trailing={
                <span className="flex flex-col items-end gap-0.5 text-right">
                  <span className="text-xs text-muted-foreground">{doc.startedByLabel}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(doc.updatedAt)}</span>
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
