import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Globe,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type { MailDomain } from "@paperclipai/shared";
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
  const [selectedZones, setSelectedZones] = useState<Set<string>>(new Set());

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
    mutationFn: async (names: string[]) => {
      const results = await Promise.allSettled(names.map((name) => mailApi.attachDomain(companyId!, name)));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: ({ ok, failed }) => {
      setSelectedZones(new Set());
      pushToast({
        tone: failed ? "warn" : "success",
        title: failed
          ? `Attached ${ok}, ${failed} failed`
          : `Attached ${ok} domain${ok === 1 ? "" : "s"}; DNS configured`,
      });
      invalidate([queryKeys.mail.domains(companyId!)]);
    },
    onError: (e) => toastError(e, "Failed to attach domains"),
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
  const attachedNames = new Set(domains.map((d) => d.domain));

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
              <Globe className="h-4 w-4" /> Attach domains
            </CardTitle>
            <CardDescription>
              Select the domains from your Cloudflare account to configure for email, then attach
              them all at once.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {zonesQuery.isError ? (
              <div className="text-sm text-destructive">
                Failed to load zones. Check that the token has Zone:DNS:Edit access.
              </div>
            ) : zonesQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading zones…
              </div>
            ) : (zonesQuery.data ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No zones found in this account.</div>
            ) : (
              (() => {
                const zones = zonesQuery.data ?? [];
                const needle = zoneFilter.trim().toLowerCase();
                const filtered = needle ? zones.filter((z) => z.name.toLowerCase().includes(needle)) : zones;
                const selectableVisible = filtered.filter((z) => !attachedNames.has(z.name));
                const allVisibleSelected =
                  selectableVisible.length > 0 && selectableVisible.every((z) => selectedZones.has(z.name));
                const toggle = (name: string) =>
                  setSelectedZones((prev) => {
                    const next = new Set(prev);
                    if (next.has(name)) next.delete(name);
                    else next.add(name);
                    return next;
                  });
                const toggleAll = () =>
                  setSelectedZones((prev) => {
                    const next = new Set(prev);
                    if (allVisibleSelected) selectableVisible.forEach((z) => next.delete(z.name));
                    else selectableVisible.forEach((z) => next.add(z.name));
                    return next;
                  });
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
                    <div className="rounded-md border">
                      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                        <Checkbox
                          checked={allVisibleSelected}
                          onCheckedChange={toggleAll}
                          disabled={selectableVisible.length === 0}
                          aria-label="Select all"
                        />
                        <span>Domain</span>
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        {filtered.map((zone) => {
                          const already = attachedNames.has(zone.name);
                          return (
                            <label
                              key={zone.id}
                              className={`flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 ${
                                already ? "opacity-60" : "cursor-pointer hover:bg-accent/40"
                              }`}
                            >
                              <Checkbox
                                checked={selectedZones.has(zone.name)}
                                disabled={already}
                                onCheckedChange={() => toggle(zone.name)}
                              />
                              <span className="font-mono">{zone.name}</span>
                              {already && (
                                <Badge variant="outline" className="ml-auto text-muted-foreground">
                                  Attached
                                </Badge>
                              )}
                            </label>
                          );
                        })}
                        {filtered.length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">No match.</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{selectedZones.size} selected</span>
                      <Button
                        size="sm"
                        disabled={selectedZones.size === 0 || attachMutation.isPending}
                        onClick={() => attachMutation.mutate([...selectedZones])}
                      >
                        {attachMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Plus className="h-3.5 w-3.5" />
                        )}
                        Attach selected
                      </Button>
                    </div>
                  </>
                );
              })()
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Attached domains</CardTitle>
          <CardDescription>
            DNS records (MX/SPF/DKIM/DMARC) published on each zone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {domainsQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load domains.</div>
          ) : domains.length === 0 ? (
            <div className="text-sm text-muted-foreground">No domains attached yet.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {domains.map((domain) => (
                <MailDomainRow
                  key={domain.id}
                  domain={domain}
                  onVerify={() => verifyMutation.mutate(domain.id)}
                  onRemove={() => {
                    if (
                      window.confirm(
                        `Detach ${domain.domain}? This removes its mail DNS records (MX/SPF/DKIM/DMARC) from Cloudflare.`,
                      )
                    ) {
                      removeMutation.mutate(domain.id);
                    }
                  }}
                  busy={verifyMutation.isPending || removeMutation.isPending}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MailDomainRow({
  domain,
  onVerify,
  onRemove,
  busy,
}: {
  domain: MailDomain;
  onVerify: () => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const statusVariant =
    domain.status === "active" ? "default" : domain.status === "failed" ? "destructive" : "secondary";
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm">{domain.domain}</span>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant}>{domain.status}</Badge>
          <Button size="sm" variant="ghost" onClick={onVerify} disabled={busy} title="Re-publish & verify DNS">
            <RefreshCw className="h-3.5 w-3.5" /> Verify
          </Button>
          <Button size="sm" variant="outline" onClick={onRemove} disabled={busy} title="Detach this domain">
            <Trash2 className="h-3.5 w-3.5" /> Detach
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <RecordFlag label="MX" ok={domain.mxConfigured} />
        <RecordFlag label="SPF" ok={domain.spfConfigured} />
        <RecordFlag label="DKIM" ok={Boolean(domain.dkimPublicKey)} />
        <RecordFlag label="DMARC" ok={domain.dmarcConfigured} />
      </div>
      {domain.lastError && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" /> {domain.lastError}
        </div>
      )}
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
