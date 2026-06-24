import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Inbox, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { MailAddress, MailDomain } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { mailApi } from "../api/mail";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function CompanySettingsMail() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [domainId, setDomainId] = useState("");
  const [localPart, setLocalPart] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Mail" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId;

  const domainsQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.domains(companyId) : ["mail", "domains", "none"],
    queryFn: () => mailApi.listDomains(companyId!),
    enabled: Boolean(companyId),
  });
  const addressesQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.addresses(companyId) : ["mail", "addresses", "none"],
    queryFn: () => mailApi.listAddresses(companyId!),
    enabled: Boolean(companyId),
  });
  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });
  const reverseDnsQuery = useQuery({
    queryKey: companyId ? queryKeys.mail.reverseDns(companyId) : ["mail", "reverse-dns", "none"],
    queryFn: () => mailApi.getReverseDns(companyId!),
    enabled: Boolean(companyId),
  });

  const toastError = (e: unknown, fallback: string) =>
    pushToast({ tone: "error", title: e instanceof ApiError ? e.message : fallback });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.mail.addresses(companyId!) });

  const createMutation = useMutation({
    mutationFn: () => mailApi.createAddress(companyId!, { domainId, localPart: localPart.trim(), agentId: null }),
    onSuccess: (address) => {
      setLocalPart("");
      pushToast({ tone: "success", title: `${address.address} created` });
      invalidate();
    },
    onError: (e) => toastError(e, "Failed to create address"),
  });
  const removeMutation = useMutation({
    mutationFn: (id: string) => mailApi.removeAddress(companyId!, id),
    onSuccess: () => {
      pushToast({ tone: "success", title: "Address deleted" });
      invalidate();
    },
    onError: (e) => toastError(e, "Failed to delete address"),
  });
  const recheckRdnsMutation = useMutation({
    mutationFn: () => mailApi.getReverseDns(companyId!, true),
    onSuccess: (data) =>
      queryClient.setQueryData(queryKeys.mail.reverseDns(companyId!), data),
    onError: (e) => toastError(e, "Failed to check reverse DNS"),
  });

  if (!companyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company.</div>;
  }

  const domains = (domainsQuery.data ?? []).filter((d) => d.status !== "failed");
  const addresses = addressesQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const byAgent = new Map<string, MailAddress[]>();
  const shared: MailAddress[] = [];
  for (const a of addresses) {
    if (a.agentId) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a]);
    else shared.push(a);
  }
  const receptionReady = domains.some((d: MailDomain) => d.mxConfigured);
  const canCreate = Boolean(domainId && localPart.trim()) && !createMutation.isPending;

  const rdns = reverseDnsQuery.data;
  const rdnsTone: Record<string, { label: string; cls: string }> = {
    ok: { label: "OK", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600" },
    mismatch: { label: "Mismatch", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600" },
    missing: { label: "Missing", cls: "border-destructive/30 bg-destructive/10 text-destructive" },
    unconfigured: { label: "Not set up", cls: "border-border bg-muted text-muted-foreground" },
    error: { label: "Error", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600" },
  };
  const rdnsBadge = rdns ? rdnsTone[rdns.status] ?? rdnsTone.error : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Mail</h1>
        <p className="text-sm text-muted-foreground">
          Every agent automatically gets <code className="rounded bg-muted px-1">handle@domain</code>{" "}
          on each attached domain. Attach domains under Domain.
        </p>
      </div>

      <div
        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
          receptionReady ? "text-emerald-600" : "text-muted-foreground"
        }`}
      >
        <Inbox className="h-4 w-4" />
        {receptionReady
          ? "Reception is wired: at least one domain has its MX published."
          : "No domain has its MX published yet. Attach/verify a domain under Domain (the server needs MAIL_HOSTNAME set)."}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" /> Reverse DNS (sending)
              </CardTitle>
              <CardDescription>
                Outbound mail needs the sending IP's PTR to match the server hostname (FCrDNS),
                or Gmail and others flag it as spam. This record lives at your host, not Cloudflare.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={recheckRdnsMutation.isPending}
              onClick={() => recheckRdnsMutation.mutate()}
            >
              {recheckRdnsMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Recheck
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {reverseDnsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Checking…</div>
          ) : reverseDnsQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load reverse DNS status.</div>
          ) : rdns && rdnsBadge ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${rdnsBadge.cls}`}
                >
                  {rdnsBadge.label}
                </span>
                <span className="text-sm text-muted-foreground">{rdns.message}</span>
              </div>
              {rdns.ip && (
                <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
                  <span className="text-muted-foreground">Sending IP</span>
                  <span className="font-mono">{rdns.ip}</span>
                  <span className="text-muted-foreground">Current PTR</span>
                  <span className="font-mono">{rdns.ptr ?? "(none)"}</span>
                  <span className="text-muted-foreground">Expected PTR</span>
                  <span className="font-mono">{rdns.hostname ?? "(MAIL_HOSTNAME not set)"}</span>
                </div>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AtSign className="h-4 w-4" /> Agent mailboxes
          </CardTitle>
          <CardDescription>Each agent's address on the attached domains.</CardDescription>
        </CardHeader>
        <CardContent>
          {addressesQuery.isError ? (
            <div className="text-sm text-destructive">Failed to load addresses.</div>
          ) : agents.length === 0 ? (
            <div className="text-sm text-muted-foreground">No agents yet.</div>
          ) : (
            <div className="overflow-hidden rounded-md border">
              {agents.map((agent) => {
                const mine = byAgent.get(agent.id) ?? [];
                return (
                  <div
                    key={agent.id}
                    className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                  >
                    <span className="w-32 shrink-0 truncate font-medium">{agent.name}</span>
                    {mine.length === 0 ? (
                      <span className="text-muted-foreground">no address yet (attach a domain)</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {mine.map((a) => (
                          <Badge key={a.id} variant="outline" className="font-mono font-normal">
                            {a.address}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shared addresses</CardTitle>
          <CardDescription>Catch-all and extra addresses not tied to an agent.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {shared.length > 0 && (
            <div className="overflow-hidden rounded-md border">
              {shared.map((address) => (
                <div
                  key={address.id}
                  className="flex items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="font-mono">{address.address}</span>
                  {address.kind === "catch_all" && <Badge variant="secondary">catch-all</Badge>}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={removeMutation.isPending}
                    title="Delete address"
                    onClick={() => removeMutation.mutate(address.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {!showAdvanced ? (
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setShowAdvanced(true)}
            >
              Add a catch-all or extra address
            </button>
          ) : domains.length === 0 ? (
            <div className="text-sm text-muted-foreground">Attach a domain under Domain first.</div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={domainId} onValueChange={setDomainId}>
                <SelectTrigger className="sm:w-52">
                  <SelectValue placeholder="Domain" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.domain}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="sm:flex-1"
                placeholder="local part (or * for catch-all)"
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
              />
              <Button disabled={!canCreate} onClick={() => createMutation.mutate()}>
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Add
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
