import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { MarkdownBody } from "../components/MarkdownBody";
import { Telescope } from "lucide-react";

// ---- RSS section -----------------------------------------------------------

function RssSection() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["instance", "katya-rss-latest"],
    queryFn: () => heartbeatsApi.katyaRssLatest(),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">RSS Intelligence</h2>
        {data?.date && (
          <span className="text-[11px] text-muted-foreground">{data.date}</span>
        )}
      </div>
      <div className="p-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground animate-pulse">Loading feed…</p>
        )}
        {error && (
          <p className="text-sm text-destructive">Failed to load RSS feed.</p>
        )}
        {!isLoading && !error && !data?.content && (
          <p className="text-sm text-muted-foreground">No RSS digest available yet.</p>
        )}
        {data?.content && (
          <div className="prose-sm max-w-none">
            <MarkdownBody>{data.content}</MarkdownBody>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- placeholder sections --------------------------------------------------

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40">
      <div className="px-4 py-3 border-b border-dashed border-border">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      <div className="p-6 flex items-center justify-center">
        <p className="text-sm text-muted-foreground text-center">{description}</p>
      </div>
    </div>
  );
}

// ---- page ------------------------------------------------------------------

export function Intelligence() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Intelligence" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Telescope className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Intelligence</h1>
      </div>

      <RssSection />

      <PlaceholderSection
        title="Competitor Activity"
        description="Competitor monitoring coming soon. This section will surface signals from tracked competitor domains and social accounts."
      />

      <PlaceholderSection
        title="Opportunities"
        description="Opportunity detection coming soon. This section will highlight inbound signals, trending topics, and outreach windows identified by Katya."
      />
    </div>
  );
}
