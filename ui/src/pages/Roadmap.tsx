import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { roadmapApi } from "../api/roadmap";
import { EmptyState } from "../components/EmptyState";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";

export function Roadmap() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Roadmap" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.roadmap,
    queryFn: () => roadmapApi.get(),
  });

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <EmptyState
        icon={Flag}
        message={error instanceof Error ? error.message : "Failed to load roadmap."}
      />
    );
  }

  if (!data) {
    return <EmptyState icon={Flag} message="Roadmap is not available yet." />;
  }

  const { roadmap, index } = data;
  const hasItems = roadmap.sections.some((section) => section.items.length > 0);

  return (
    <div className="space-y-4">
      <section className="border border-border bg-card p-4 md:p-5">
        <h2 className="text-lg font-semibold">{roadmap.title}</h2>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="font-mono">{roadmap.path}</span>
          {roadmap.status && <span>Status: {roadmap.status}</span>}
          {roadmap.owner && <span>Owner: {roadmap.owner}</span>}
          {roadmap.lastUpdated && <span>Updated: {roadmap.lastUpdated}</span>}
        </div>
        {roadmap.contract.length > 0 && (
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-foreground/90">
            {roadmap.contract.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
        )}
      </section>

      {hasItems ? (
        roadmap.sections.map((section) => (
          <section key={section.title} className="border border-border bg-card p-4 md:p-5">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{section.title}</h3>
            <div className="mt-3 space-y-3">
              {section.items.map((item) => (
                <article key={item.id} className="border border-border bg-background p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{item.id}</span>
                    <h4 className="text-sm font-semibold">{item.title}</h4>
                  </div>
                  {item.fields.length > 0 && (
                    <dl className="mt-3 grid gap-1 text-sm">
                      {item.fields.map((field) => (
                        <div key={`${item.id}:${field.key}`} className="flex flex-wrap gap-2">
                          <dt className="font-medium text-foreground/90">{field.key}:</dt>
                          <dd className="text-muted-foreground">{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))
      ) : (
        <EmptyState icon={Flag} message="Roadmap items are not defined yet." />
      )}

      <section className="border border-border bg-card p-4 md:p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Roadmap Index</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Source: <span className="font-mono">{index.path}</span>
        </p>
        {index.links.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {index.links.map((link) => (
              <li key={`${link.label}:${link.path}`} className="text-muted-foreground">
                <span className="font-medium text-foreground/90">{link.label}</span>
                <span className="mx-2 text-border">-</span>
                <span className="font-mono text-xs">{link.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="border border-border bg-card p-4 md:p-5">
        <summary className="cursor-pointer text-sm font-medium">View raw roadmap markdown</summary>
        <div className="mt-4">
          <MarkdownBody>{roadmap.markdown}</MarkdownBody>
        </div>
      </details>
    </div>
  );
}
