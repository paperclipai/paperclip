import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { knowledgeApi } from "../api/knowledge";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { FolderKanban, Library } from "lucide-react";

export function Knowledge() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedEntryId = searchParams.get("entry") ?? "";

  useEffect(() => {
    setBreadcrumbs([{ label: "Knowledge", href: "/knowledge" }]);
  }, [setBreadcrumbs]);

  const listQuery = useQuery({
    queryKey: queryKeys.knowledge.list(selectedCompanyId ?? ""),
    queryFn: () => knowledgeApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const detailQuery = useQuery({
    queryKey: queryKeys.knowledge.detail(selectedEntryId),
    queryFn: () => knowledgeApi.get(selectedEntryId),
    enabled: Boolean(selectedEntryId),
  });

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return <EmptyState icon={FolderKanban} message="Create a company before opening the knowledge library." />;
    }
    return <EmptyState icon={FolderKanban} message="Select a company to open the knowledge library." />;
  }

  const entries = listQuery.data ?? [];
  const selectedEntry = detailQuery.data ?? entries.find((entry) => entry.id === selectedEntryId) ?? entries[0] ?? null;

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(15,23,42,0.05),transparent_45%),linear-gradient(135deg,rgba(255,255,255,0.02),rgba(15,23,42,0.04))] p-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Library className="h-4 w-4" />
            <span className="text-sm">Durable knowledge</span>
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Knowledge library</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Published results and briefings that should survive beyond issue threads and become company memory.
            </p>
          </div>
        </div>
      </section>

      {listQuery.isLoading ? <PageSkeleton variant="list" /> : null}
      {listQuery.error ? <p className="text-sm text-destructive">{listQuery.error.message}</p> : null}

      {!listQuery.isLoading && !listQuery.error ? (
        <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
          <section className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">Entries</h2>
                <p className="text-sm text-muted-foreground">Published knowledge artifacts for the active company.</p>
              </div>
              <Badge variant="outline">{entries.length}</Badge>
            </div>
            <div className="space-y-3">
              {entries.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  No knowledge entries yet.
                </p>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setSearchParams((current) => {
                      const next = new URLSearchParams(current);
                      next.set("entry", entry.id);
                      return next;
                    })}
                    className="block w-full rounded-xl border border-border/70 bg-background px-4 py-3 text-left transition-colors hover:bg-accent/20"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{entry.title}</span>
                        <Badge variant="outline">{entry.kind.replace(/_/g, " ")}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{entry.summary ?? "No summary provided."}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card p-4">
            {!selectedEntry ? (
              <p className="text-sm text-muted-foreground">Select a knowledge entry to inspect the published artifact.</p>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{selectedEntry.kind.replace(/_/g, " ")}</Badge>
                    <Badge variant="outline">{selectedEntry.status}</Badge>
                    {selectedEntry.sourceRecordId ? (
                      <Link to={`/briefings/records/${selectedEntry.sourceRecordId}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
                        Open source record
                      </Link>
                    ) : null}
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">{selectedEntry.title}</h2>
                    <p className="text-sm text-muted-foreground">{selectedEntry.summary ?? "No summary provided."}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-border/70 bg-background p-4">
                  {selectedEntry.bodyMd?.trim() ? (
                    <MarkdownBody>{selectedEntry.bodyMd}</MarkdownBody>
                  ) : (
                    <p className="text-sm text-muted-foreground">No body content has been published yet.</p>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
