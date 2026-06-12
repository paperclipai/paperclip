import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import type { AppGalleryEntry, ToolAppAttentionItem } from "@paperclipai/shared";
import { humanizeConnectionDisplayName } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "./AppLogo";
import { ReviewQueueCard } from "./ReviewQueueCard";

/**
 * Needs-attention page (M9, PAP-10859) over `GET /tools/apps/attention`.
 * Surfaces apps with a bad key, brand-new actions to review, or requests
 * waiting for the user's OK — plus the full Ask-first review queue.
 */
export function AppsAttention() {
  const navigate = useNavigate();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: "Needs attention" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const attentionQuery = useQuery({
    queryKey: queryKeys.apps.attention(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listAppsAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const apps = attentionQuery.data?.apps ?? [];
  const logoByName = useMemo(() => {
    const map = new Map<string, AppGalleryEntry>();
    for (const entry of galleryQuery.data?.apps ?? []) map.set(entry.name.toLowerCase(), entry);
    return map;
  }, [galleryQuery.data]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }

  return (
    <div className="max-w-3xl space-y-6 pb-12">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Needs attention</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Apps that need a moment from you. Everything else keeps working.
        </p>
      </header>

      <ReviewQueueCard emptyState="hidden" heading="Waiting for your OK" />

      {attentionQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : apps.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
            <ShieldAlert className="h-6 w-6 text-emerald-500 dark:text-emerald-400" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">Nothing needs attention.</p>
          <p className="text-sm text-muted-foreground">All your apps are healthy.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {apps.map((app) => (
            <AttentionRow
              key={app.connection.id}
              app={app}
              logoUrl={logoByName.get(app.connection.name.toLowerCase())?.logoUrl}
              onOpen={() => {
                const profile = app.newToolsPendingProfiles[0];
                navigate(
                  profile
                    ? `/apps/advanced/profiles/${profile.profileId}?review=new-tools`
                    : `/apps/${app.connection.id}`,
                );
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AttentionRow({
  app,
  logoUrl,
  onOpen,
}: {
  app: ToolAppAttentionItem;
  logoUrl?: string | null;
  onOpen: () => void;
}) {
  const reasons = reasonSentences(app);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-4">
      <AppLogo name={humanizeConnectionDisplayName(app.connection)} logoUrl={logoUrl} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-foreground">
          {humanizeConnectionDisplayName(app.connection)}
        </div>
        <ul className="mt-1 space-y-0.5 text-sm text-amber-800 dark:text-amber-200">
          {reasons.map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
      </div>
      <Button size="sm" onClick={onOpen}>
        {app.healthNeedsAttention ? "Reconnect" : "Review"}
      </Button>
    </div>
  );
}

function reasonSentences(app: ToolAppAttentionItem): string[] {
  const out: string[] = [];
  if (app.healthNeedsAttention) {
    out.push("The key stopped working — reconnect to fix it.");
  }
  if (app.quarantinedCatalogEntryCount > 0) {
    const n = app.quarantinedCatalogEntryCount;
    out.push(`${n} new ${n === 1 ? "action" : "actions"} to review.`);
  }
  if (app.pendingActionRequestCount > 0) {
    const n = app.pendingActionRequestCount;
    out.push(`${n} ${n === 1 ? "action is" : "actions are"} waiting for your OK.`);
  }
  if (app.newToolsPendingReviewCount > 0) {
    const n = app.newToolsPendingReviewCount;
    out.push(`${n} new ${n === 1 ? "tool needs" : "tools need"} profile review.`);
  }
  return out.length > 0 ? out : ["Needs a look."];
}
