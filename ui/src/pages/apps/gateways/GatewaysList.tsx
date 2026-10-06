import { useTranslation } from "@/i18n";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ErrorState, RelativeTime } from "@/pages/tools/shared";
import { CopyableGatewayUrl } from "./CopyableGatewayUrl";
import { NewGatewayDialog, gatewaysQueryKey } from "./NewGatewayDialog";
import { gatewayTabHref } from "./gateway-tabs";
import {
  activeTokenCount,
  allowedToolsLabel,
  deriveGatewayApps,
  expiringTokenCount,
  formatScope,
  isGatewayOn,
  latestTokenActivity,
} from "./gateway-helpers";

export function GatewaysList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      { label: t("pages.apps.subNav.gateways") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

  const gatewaysQuery = useQuery({
    queryKey: gatewaysQueryKey(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGateways(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.profiles(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listProfiles(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const profileById = useMemo(
    () => new Map((profilesQuery.data?.profiles ?? []).map((profile) => [profile.id, profile])),
    [profilesQuery.data],
  );
  const agentNames = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );
  const projectNames = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name])),
    [projectsQuery.data],
  );

  const toggleMutation = useMutation({
    mutationFn: ({ gateway }: { gateway: ToolMcpGatewayWithTokens }) =>
      toolsApi.updateGateway(selectedCompanyId!, gateway.id, {
        status: isGatewayOn(gateway) ? "disabled" : "active",
      }),
    onSuccess: async (gateway) => {
      pushToast({
        title: gateway.status === "active" ? t("localizationApps.gatewayOn275") : t("localizationApps.gatewayOff276"),
        body:
          gateway.status === "active"
            ? t("localizationApps.gatewayExposingTools", { name: gateway.name })
            : t("localizationApps.gatewayTurnedOff", { name: gateway.name }),
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: gatewaysQueryKey(selectedCompanyId!) });
    },
    onError: (error) =>
      pushToast({
        title: t("localizationApps.couldnTUpdateTheGateway279"),
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      }),
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">{t("localizationApps.selectAnOrganizationToManageGateways280")}</div>;
  }

  const gateways = gatewaysQuery.data?.gateways ?? [];
  const term = search.trim().toLowerCase();
  const filtered = term
    ? gateways.filter((gateway) => {
        const scope = formatScope(gateway, projectNames, agentNames).toLowerCase();
        return (
          gateway.name.toLowerCase().includes(term) ||
          gateway.displaySlug.toLowerCase().includes(term) ||
          scope.includes(term)
        );
      })
    : gateways;

  return (
    <div className="max-w-5xl space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{t("nav.apps")}</h1>
        <p className="text-sm text-muted-foreground">{t("localizationApps.aGatewayIsOneSafeMCPEndpointThatExposesOnlyTh310")}</p>
      </header>

      {gatewaysQuery.isLoading ? (
        <div className="space-y-3 pt-2">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-52 w-full" />
        </div>
      ) : gatewaysQuery.isError ? (
        <ErrorState error={gatewaysQuery.error} onRetry={() => gatewaysQuery.refetch()} />
      ) : gateways.length === 0 ? (
        <EmptyGateways onCreate={() => setCreating(true)} />
      ) : (
        <div className="space-y-4 pt-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("localizationApps.searchByNameAppOrOwner311")}
                className="pl-9"
                aria-label={t("localizationApps.searchGateways312")}
              />
            </div>
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />{t("localizationApps.newGateway289")}</Button>
          </div>

          {(() => {
            const rows = filtered.map((gateway) => {
              const profile = profileById.get(gateway.profileId);
              const apps = deriveGatewayApps(
                profile,
                applicationsQuery.data?.applications ?? [],
                connectionsQuery.data?.connections ?? [],
              );
              return {
                gateway,
                profile,
                scope: formatScope(gateway, projectNames, agentNames),
                appsLabel: `${t("localizationApps.appCount", { count: apps.length })}${
                  profile ? ` · ${allowedToolsLabel(profile)}` : ""
                }`,
                active: activeTokenCount(gateway),
                expiring: expiringTokenCount(gateway),
                lastUsed: latestTokenActivity(gateway),
                href: gatewayTabHref(gateway.id, "overview"),
              };
            });
            const toggle = (gateway: ToolMcpGatewayWithTokens) => (
              <ToggleSwitch
                checked={isGatewayOn(gateway)}
                disabled={toggleMutation.isPending}
                onClick={(event) => event.stopPropagation()}
                onCheckedChange={() => toggleMutation.mutate({ gateway })}
                aria-label={isGatewayOn(gateway) ? t("localizationApps.turnGatewayOff", { name: gateway.name }) : t("localizationApps.turnGatewayOn", { name: gateway.name })}
              />
            );
            const empty = (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t("localizationApps.noGatewaysMatch", { query: search.trim() })}
              </div>
            );
            return (
              <>
                {/* Desktop / tablet: full table. */}
                <div className="hidden overflow-x-auto rounded-lg border border-border sm:block">
                  <table className="w-full min-w-(--sz-40rem) text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40 text-left text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className="whitespace-nowrap px-4 py-2.5">{t("localizationApps.gateway316")}</th>
                        <th className="whitespace-nowrap px-4 py-2.5">{t("localizationSkills.scope118")}</th>
                        <th className="whitespace-nowrap px-4 py-2.5">{t("nav.apps")}</th>
                        <th className="whitespace-nowrap px-4 py-2.5">{t("pages.userProfile.tokens")}</th>
                        <th className="whitespace-nowrap px-4 py-2.5">{t("pages.apps.connections.columnLastUsed")}</th>
                        <th className="whitespace-nowrap px-4 py-2.5 text-right">{t("pages.instanceSettings.on")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ gateway, scope, appsLabel, active, expiring, lastUsed, href }) => (
                        <tr
                          key={gateway.id}
                          onClick={() => navigate(href)}
                          className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-muted/30"
                        >
                          <td className="w-64 max-w-64 whitespace-nowrap px-4 py-3">
                            <div className="font-medium text-foreground">{gateway.name}</div>
                            <CopyableGatewayUrl endpointPath={gateway.endpointPath} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{scope}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{appsLabel}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {t("localizationApps.activeCount", { count: active })}{expiring > 0 ? t("localizationApps.expiringCount", { count: expiring }) : ""}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                            {lastUsed ? <RelativeTime value={lastUsed} /> : "—"}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex justify-end">{toggle(gateway)}</div>
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={6}>{empty}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: stacked cards so the On toggle stays reachable and thumb-sized. */}
                <div className="space-y-3 sm:hidden">
                  {rows.map(({ gateway, scope, appsLabel, active, expiring, lastUsed, href }) => (
                    <div
                      key={gateway.id}
                      onClick={() => navigate(href)}
                      className="cursor-pointer rounded-lg border border-border p-4 transition-colors hover:bg-muted/30"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-foreground">{gateway.name}</div>
                          <CopyableGatewayUrl endpointPath={gateway.endpointPath} />
                        </div>
                        <div className="shrink-0">{toggle(gateway)}</div>
                      </div>
                      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <MobileField label={t("localizationSkills.scope118")} value={scope} />
                        <MobileField label={t("nav.apps")} value={appsLabel} />
                        <MobileField
                          label={t("pages.userProfile.tokens")}
                          value={`${t("localizationApps.activeCount", { count: active })}${expiring > 0 ? t("localizationApps.expiringCount", { count: expiring }) : ""}`}
                        />
                        <MobileField
                          label={t("pages.apps.connections.columnLastUsed")}
                          value={lastUsed ? <RelativeTime value={lastUsed} /> : "—"}
                        />
                      </dl>
                    </div>
                  ))}
                  {rows.length === 0 ? (
                    <div className="rounded-lg border border-border">{empty}</div>
                  ) : null}
                </div>
              </>
            );
          })()}

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="text-sm font-semibold text-foreground">{t("localizationApps.whyAGateway318")}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t("localizationApps.youPickWhichAppsGoThroughItWhoCanUseItAndHowR319")}</p>
          </div>
        </div>
      )}

      <NewGatewayDialog
        companyId={selectedCompanyId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(gatewayId) => navigate(gatewayTabHref(gatewayId, "overview"))}
      />
    </div>
  );
}

/** One label:value pair inside a mobile stacked card. */
function MobileField({ label, value }: { label: string; value: ReactNode }) {
  useTranslation();
  return (
    <div className="min-w-0">
      <dt className="text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-foreground">{value}</dd>
    </div>
  );
}

function EmptyGateways({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-dashed border-border p-12 text-center">
      <h2 className="text-lg font-semibold text-foreground">{t("localizationApps.noGatewaysYet320")}</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{t("localizationApps.groupYourConnectedAppsIntoOneSafeEndpointYouC321")}</p>
      <Button className="mt-5" onClick={onCreate}>
        <Plus className="mr-1.5 h-4 w-4" />{t("localizationApps.newGateway289")}</Button>
    </div>
  );
}
