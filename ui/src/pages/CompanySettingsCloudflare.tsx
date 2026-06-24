import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Globe,
  Link2,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { mailApi } from "../api/mail";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function CompanySettingsCloudflare() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [apiToken, setApiToken] = useState("");
  const [zoneFilter, setZoneFilter] = useState("");
  const [detachTarget, setDetachTarget] = useState<{ id: string; domain: string } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Cloudflare" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId;

  const connectionQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.cloudflare(companyId) : ["mail", "cloudflare", "none"],
    queryFn: () => mailApi.getCloudflareConnection(companyId!),
    enabled: Boolean(companyId),
  });
  const connection = connectionQuery.data ?? null;
  const connected = connection?.status === "active";

  const zonesQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.cloudflareZones(companyId) : ["mail", "zones", "none"],
    queryFn: () => mailApi.listZones(companyId!),
    enabled: Boolean(companyId) && connected,
  });

  const domainsQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.domains(companyId) : ["mail", "domains", "none"],
    queryFn: () => mailApi.listDomains(companyId!),
    enabled: Boolean(companyId),
  });

  const toastError = (e: unknown, fallback: string) =>
    pushToast({ tone: "error", title: e instanceof ApiError ? e.message : fallback });

  const invalidate = (keys: ReadonlyArray<readonly unknown[]>) => {
    for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
  };

  const connectMutation = useMutation({
    mutationFn: () => mailApi.connectCloudflare(companyId!, apiToken.trim()),
    onSuccess: () => {
      setApiToken("");
      pushToast({ tone: "success", title: "Cloudflare connected" });
      invalidate([queryKeys.mail.cloudflare(companyId!), queryKeys.mail.cloudflareZones(companyId!)]);
    },
    onError: (e) => toastError(e, "Failed to connect Cloudflare"),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => mailApi.disconnectCloudflare(companyId!),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Cloudflare disconnected" });
      invalidate([queryKeys.mail.cloudflare(companyId!)]);
    },
    onError: (e) => toastError(e, "Failed to disconnect"),
  });

  const attachMutation = useMutation({
    mutationFn: (name: string) => mailApi.attachDomain(companyId!, name),
    onSuccess: (domain) => {
      pushToast({
        tone: domain.status === "failed" ? "error" : "success",
        title: domain.status === "failed" ? `${domain.domain}: DNS publish failed` : `${domain.domain} attached`,
      });
      invalidate([queryKeys.mail.domains(companyId!)]);
    },
    onError: (e) => toastError(e, "Failed to attach domain"),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: string) => mailApi.verifyDomain(companyId!, id),
    onSuccess: () => invalidate([queryKeys.mail.domains(companyId!)]),
    onError: (e) => toastError(e, "Failed to verify domain"),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => mailApi.removeDomain(companyId!, id),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Domain detached" });
      invalidate([queryKeys.mail.domains(companyId!)]);
    },
    onError: (e) => toastError(e, "Failed to detach domain"),
  });

  if (!companyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  }

  const domains = domainsQuery.data ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Cloudflare</h1>
        <p className="text-sm text-muted-foreground">
          Connect your Cloudflare account and manage the domains agents use for email, all in one
          place. Attaching a domain configures its DNS foundation (MX/SPF/DKIM/DMARC); sending and
          receiving land in later phases.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4" /> Cloudflare
          </CardTitle>
          <CardDescription>
            Paste an API token scoped to <code className="rounded bg-muted px-1">Zone:DNS:Edit</code>. It
            is verified and stored encrypted; the raw token is never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {connectionQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load the Cloudflare connection.</div>
          ) : connectionQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : connected ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                Connected{connection?.cfAccountId ? ` · account ${connection.cfAccountId}` : ""}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                Disconnect
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Cloudflare API token"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
              <Button
                onClick={() => connectMutation.mutate()}
                disabled={!apiToken.trim() || connectMutation.isPending}
              >
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Connect
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {connected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" /> Domains
            </CardTitle>
            <CardDescription>
              Check a domain to attach it for email (publishes its MX/SPF/DKIM/DMARC). Uncheck to
              detach and remove those records from Cloudflare.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {zonesQuery.isError ? (
              <div className="text-sm text-destructive">
                Failed to load zones. Check that the token has Zone:DNS:Edit access.
              </div>
            ) : zonesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading domains…
              </div>
            ) : (zonesQuery.data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No domains found in this account.</div>
            ) : (
              (() => {
                const zones = zonesQuery.data ?? [];
                const needle = zoneFilter.trim().toLowerCase();
                const filtered = needle ? zones.filter((z) => z.name.toLowerCase().includes(needle)) : zones;
                const byName = new Map(domains.map((d) => [d.domain, d]));
                return (
                  <>
                    {zones.length > 8 && (
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          className="pl-7"
                          placeholder="Filter domains…"
                          value={zoneFilter}
                          onChange={(e) => setZoneFilter(e.target.value)}
                        />
                      </div>
                    )}
                    <div className="overflow-hidden rounded-md border">
                      <div className="max-h-96 overflow-y-auto">
                        {filtered.map((zone) => {
                          const attached = byName.get(zone.name);
                          const isAttached = Boolean(attached);
                          const busy =
                            (attachMutation.isPending && attachMutation.variables === zone.name) ||
                            (removeMutation.isPending && attached != null && removeMutation.variables === attached.id);
                          const statusVariant =
                            attached?.status === "active"
                              ? "default"
                              : attached?.status === "failed"
                                ? "destructive"
                                : "secondary";
                          return (
                            <div key={zone.id} className="border-b last:border-b-0">
                              <div className="flex items-center gap-2.5 px-3 py-2">
                                <Checkbox
                                  checked={isAttached}
                                  disabled={busy}
                                  aria-label={isAttached ? `Detach ${zone.name}` : `Attach ${zone.name}`}
                                  onCheckedChange={() => {
                                    if (isAttached && attached) {
                                      setDetachTarget({ id: attached.id, domain: zone.name });
                                    } else {
                                      attachMutation.mutate(zone.name);
                                    }
                                  }}
                                />
                                <span className="font-mono text-sm">{zone.name}</span>
                                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                                {attached && (
                                  <Badge variant={statusVariant} className="ml-auto">
                                    {attached.status}
                                  </Badge>
                                )}
                              </div>
                              {attached && (
                                <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pl-9">
                                  <RecordFlag label="MX" ok={attached.mxConfigured} />
                                  <RecordFlag label="SPF" ok={attached.spfConfigured} />
                                  <RecordFlag label="DKIM" ok={Boolean(attached.dkimPublicKey)} />
                                  <RecordFlag label="DMARC" ok={attached.dmarcConfigured} />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="ml-auto h-7"
                                    disabled={busy}
                                    onClick={() => verifyMutation.mutate(attached.id)}
                                    title="Re-publish & verify DNS"
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" /> Verify
                                  </Button>
                                  {attached.lastError && (
                                    <span className="flex w-full items-center gap-1.5 text-xs text-destructive">
                                      <AlertTriangle className="h-3.5 w-3.5" /> {attached.lastError}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {filtered.length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">No match.</div>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()
            )}
          </CardContent>
        </Card>
      )}

      <AlertDialog open={detachTarget !== null} onOpenChange={(open) => !open && setDetachTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Detach {detachTarget?.domain}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes its mail DNS records (MX/SPF/DKIM/DMARC) from Cloudflare. You can re-attach
              it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (detachTarget) removeMutation.mutate(detachTarget.id);
                setDetachTarget(null);
              }}
            >
              Detach
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RecordFlag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <Badge variant={ok ? "outline" : "secondary"} className={ok ? "text-emerald-600" : "text-muted-foreground"}>
      {label} {ok ? "✓" : "—"}
    </Badge>
  );
}
