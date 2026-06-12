import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { Navigate, useNavigate, useParams } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppLogo } from "./AppLogo";
import { connectionAddress, connectionTransportLabel, DangerZone } from "./AppDetail";

export function AppNotConnected() {
  const { applicationId = "" } = useParams<{ applicationId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const application = useMemo(
    () => (applicationsQuery.data?.applications ?? []).find((app) => app.id === applicationId),
    [applicationsQuery.data, applicationId],
  );
  const appConnections = useMemo(
    () => (connectionsQuery.data?.connections ?? []).filter((c) => c.applicationId === applicationId),
    [connectionsQuery.data, applicationId],
  );
  const activeConnection = appConnections.find((c) => c.status !== "archived") ?? null;
  const previousConnection = useMemo(() => latestArchivedConnection(appConnections), [appConnections]);

  const appName = application?.name ?? "App";
  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Apps", href: "/apps" },
      { label: appName },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name, appName]);

  const remove = useMutation({
    mutationFn: () => toolsApi.updateApplication(applicationId, { status: "archived" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__") });
      pushToast({
        title: "App removed",
        body: `${appName} no longer shows in your apps. You can connect it again any time.`,
        tone: "success",
      });
      navigate("/apps");
    },
    onError: (error) => {
      pushToast({
        title: "Couldn’t remove the app",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage apps.</div>;
  }
  if (applicationsQuery.isLoading || connectionsQuery.isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!application) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6 text-sm text-muted-foreground">
        <p>This app doesn’t exist anymore.</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/apps")}>Back to apps</Button>
      </div>
    );
  }
  if (activeConnection) {
    return <Navigate to={`/apps/${activeConnection.id}`} replace />;
  }

  const gallery = galleryQuery.data?.apps ?? [];
  const logoUrl =
    (application.applicationKey ? gallery.find((entry) => entry.key === application.applicationKey)?.logoUrl : undefined) ??
    gallery.find((entry) => entry.name.toLowerCase() === application.name.toLowerCase())?.logoUrl;

  const previousAddress = previousConnection ? connectionAddress(previousConnection) : null;
  const usableLink = previousAddress && /^https?:\/\//i.test(previousAddress) ? previousAddress : null;
  const connectParams = new URLSearchParams({ applicationId: application.id, name: application.name });
  if (usableLink) connectParams.set("link", usableLink);
  const connectHref = `/apps/connect?${connectParams.toString()}`;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex flex-wrap items-center gap-4">
        <AppLogo name={application.name} logoUrl={logoUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-tight">{application.name}</h1>
            <span className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
              Not connected
            </span>
          </div>
          {application.description && (
            <p className="mt-1 text-sm text-muted-foreground">{application.description}</p>
          )}
        </div>
      </header>

      <section className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-foreground">
              {previousConnection ? "Reconnect this app" : "Connect this app"}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {previousConnection
                ? "We kept the previous setup — you’ll only need to enter the key again."
                : "Agents can’t use it until it’s connected."}
            </p>
          </div>
          <Button onClick={() => navigate(connectHref)}>
            {previousConnection ? "Reconnect" : "Connect"}
          </Button>
        </div>
      </section>

      {previousConnection && (
        <section className="rounded-xl border border-border bg-card px-5 py-4">
          <h2 className="text-sm font-bold text-foreground">Previous setup</h2>
          {previousConnection.healthMessage && (
            <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Last error: {previousConnection.healthMessage}
            </p>
          )}
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted-foreground">Address</dt>
            <dd className="break-all font-mono text-foreground">{previousAddress}</dd>
            <dt className="text-muted-foreground">Connection type</dt>
            <dd className="text-foreground">{connectionTransportLabel(previousConnection.transport)}</dd>
            <dt className="text-muted-foreground">Last used</dt>
            <dd className="text-foreground">
              {previousConnection.lastUsedAt ? timeAgo(previousConnection.lastUsedAt) : "Never"}
            </dd>
          </dl>
        </section>
      )}

      <DangerZone appName={application.name} removing={remove.isPending} onRemove={() => remove.mutate()} />
    </div>
  );
}

function latestArchivedConnection(connections: ToolConnection[]): ToolConnection | null {
  const archived = connections.filter((c) => c.status === "archived");
  if (archived.length === 0) return null;
  return archived.reduce((latest, connection) => {
    const latestTime = new Date(latest.updatedAt ?? latest.createdAt ?? 0).getTime();
    const connectionTime = new Date(connection.updatedAt ?? connection.createdAt ?? 0).getTime();
    return connectionTime > latestTime ? connection : latest;
  });
}
