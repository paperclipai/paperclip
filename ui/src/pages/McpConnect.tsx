import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Globe, Paperclip } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import type { McpConnection, McpConnectionRequest } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { api } from "../api/client";

// Bundle known-origin icons so opening consent never contacts a client-selected site.
// Client-supplied names never select branding.
function ClientOrigin({ origin }: { origin: string }) {
  useTranslation();
  const [failed, setFailed] = useState(false);
  let favicon: string | undefined;
  try {
    const url = new URL(origin);
    if (url.origin === "https://claude.ai") favicon = "/brands/claude-color.svg";
    else if (["https://chatgpt.com", "https://chat.openai.com", "https://openai.com"].includes(url.origin)) favicon = "/brands/codex-color.svg";
  } catch { /* An unavailable origin keeps the neutral site icon. */ }
  return <div className="flex items-center gap-2 text-sm text-muted-foreground">
    {favicon && !failed ? <img src={favicon} alt="" className="size-4 shrink-0 object-contain" referrerPolicy="no-referrer" crossOrigin="anonymous" onError={() => setFailed(true)} /> : <Globe className="size-4 shrink-0" aria-hidden="true" />}
    <bdi className="min-w-0 break-all">{origin}</bdi>
  </div>;
}

export function McpConnectPage() {
  useTranslation();
  const { id = "" } = useParams();
  return <McpConnectRequest key={id} id={id} />;
}

export function McpDevicePage({ initialCode }: { initialCode?: string } = {}) {
  useTranslation();
  const [code, setCode] = useState(initialCode ?? new URLSearchParams(window.location.search).get("user_code") ?? "");
  const [submitted, setSubmitted] = useState(code);
  if (submitted) return <McpConnectRequest key={submitted} id={submitted} device onEditCode={() => setSubmitted("")} />;
  return <div className="mx-auto max-w-xl py-10"><Card className="space-y-4 p-6"><div className="flex items-center gap-3"><Paperclip className="size-8 shrink-0" /><h1 className="min-w-0 text-xl font-semibold">{t("oct6Beta.copy177")}</h1></div>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); setSubmitted(code.trim()); }}>
      <label htmlFor="device-code" className="text-sm">{t("oct6Beta.copy178")}</label>
      <Input id="device-code" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required maxLength={12} />
      <div className="flex justify-end"><Button type="submit">{t("oct5Core.continue")}</Button></div>
    </form></Card></div>;
}

function McpConnectRequest({ id, device = false, onEditCode }: { id: string; device?: boolean; onEditCode?: () => void }) {
  useTranslation();
  const [companyId, setCompanyId] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(true);
  const [deviceResult, setDeviceResult] = useState<"approved" | "denied" | null>(null);
  const request = useQuery({ queryKey: [device ? "mcp-device" : "mcp-request", id], queryFn: () => api.get<McpConnectionRequest>(device ? `/mcp/device?user_code=${encodeURIComponent(id)}` : `/mcp/requests/${encodeURIComponent(id)}`), retry: false });
  const data = request.data;
  const selectedCompanyId = data?.requestedCompanyId ?? (companyId || data?.companies[0]?.id || "");
  // Pin the default once loaded so a refetch cannot silently switch organizations.
  useEffect(() => {
    if (!companyId && !data?.requestedCompanyId && data?.companies[0]) setCompanyId(data.companies[0].id);
  }, [companyId, data]);
  const clientName = data?.clientName.trim();
  const assistantName = clientName && !/^(assistant|mcp client)$/i.test(clientName) ? clientName : "your assistant";
  const clientOrigin = data?.clientOrigin || data?.redirectOrigin;
  const company = data?.companies.find((item) => item.id === selectedCompanyId);
  const allowWrites = Boolean(data?.requestedWrite && company?.canWrite && writeEnabled);
  const consent = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.post<{ redirectUrl?: string; status?: "approved" | "denied" }>(device ? "/mcp/device/consent" : `/mcp/requests/${encodeURIComponent(id)}/consent`, { decision, companyId: selectedCompanyId || undefined, allowWrites: decision === "approve" && allowWrites, ...(device ? { userCode: id } : {}) }),
    onSuccess: ({ redirectUrl, status }) => { if (device && status) setDeviceResult(status); else if (redirectUrl) window.location.assign(redirectUrl); },
  });
  if (deviceResult) return <div className="mx-auto max-w-xl py-10"><Card className="block space-y-4 p-6"><Paperclip className="size-8" /><h1 className="text-xl font-semibold">{deviceResult === "approved" ? t("oct6Beta.copy179") : t("localizationConnections.connectionDeclined212")}</h1><p className="text-sm">{deviceResult === "approved" ? t("oct6Beta.copy180") : t("oct6Beta.copy181")}</p><Button variant="outline" asChild><Link to="/">{t("oct6Beta.copy182")}</Link></Button></Card></div>;
  const returnPath = device ? `/mcp-device?user_code=${encodeURIComponent(id)}` : `/mcp-connect/${id}`;
  return <div className="mx-auto max-w-xl py-10">
    <Card className="block space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Paperclip className="size-8 shrink-0 text-foreground" role="img" aria-label="Paperclip" />
        <h1 className="min-w-0 break-words text-xl font-semibold"><Trans i18nKey="oct6Beta.connectClient" values={{ name: assistantName }} components={{ client: <bdi /> }} /></h1>
      </div>
      {clientOrigin && <ClientOrigin key={clientOrigin} origin={clientOrigin} />}
      {!device && data?.redirectOrigin && data.redirectOrigin !== clientOrigin && <ClientOrigin key={data.redirectOrigin} origin={data.redirectOrigin} />}
      {device && <p className="text-sm">{t("oct6Beta.copy183")} <strong className="font-mono">{id.toUpperCase()}</strong></p>}
      {request.isPending && <p className="text-sm text-muted-foreground">{t("oct6Beta.copy184")}</p>}
      {request.error && <p className="text-sm text-destructive">{request.error.message} {t("oct6Beta.copy185")}</p>}
      {device && request.error && <Button variant="outline" onClick={onEditCode}>{t("oct6Beta.copy186")}</Button>}
      {data && <>
        {data.requiresSignIn ? <Button asChild><Link to={`/auth?next=${encodeURIComponent(returnPath)}`}>{t("localizationAccessBootstrap.signInCreate")}</Link></Button> : <>
          {data.requestedCompanyId ? <div className="flex items-center gap-4 rounded-md border border-border p-4">
            {company && <CompanyPatternIcon companyName={company.name} logoUrl={company.logoUrl} className="size-14 shrink-0 rounded-lg text-xl" />}
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">{t("oct5Core.s0298")}</p>
              {company ? <p className="break-words text-lg font-semibold">{company.name}</p> : <p className="text-sm text-destructive">{t("oct6Beta.copy187")}</p>}
            </div>
          </div> : <fieldset className="space-y-2" disabled={consent.isPending}>
            <legend className="mb-2 text-sm font-medium">{t("oct5Core.s0298")}</legend>
            {data.companies.map((item) => <label key={item.id} className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
              <input type="radio" name="company" aria-label={item.name} value={item.id} checked={selectedCompanyId === item.id} onChange={() => setCompanyId(item.id)} />
              <CompanyPatternIcon companyName={item.name} logoUrl={item.logoUrl} className="size-12 shrink-0 rounded-lg" />
              <span className="min-w-0 break-words font-medium">{item.name}</span>
            </label>)}
            {!data.companies.length && <p className="text-sm text-muted-foreground">{t("oct6Beta.copy188")}</p>}
          </fieldset>}
          <p className="text-sm">{t("oct6Beta.copy189")}</p>
          {data.requestedWrite && <label htmlFor="mcp-allow-writes" className="flex items-start gap-3 text-sm leading-6">
            <span className="flex h-6 shrink-0 items-center">
              <Checkbox id="mcp-allow-writes" checked={allowWrites} disabled={!company?.canWrite || consent.isPending} onCheckedChange={(checked) => setWriteEnabled(checked === true)} />
            </span>
            <span>{t("oct6Beta.copy190")}</span>
          </label>}
          {company && !company.canWrite && <p className="text-sm text-muted-foreground">{t("oct6Beta.copy191")}</p>}
          {consent.error && <p className="text-sm text-destructive">{consent.error.message}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="outline" disabled={consent.isPending} onClick={() => consent.mutate("deny")}>{t("oct5Core.s0345")}</Button>
            <Button className="h-auto min-h-10 min-w-0 shrink whitespace-normal" disabled={!company || consent.isPending} onClick={() => consent.mutate("approve")}>{consent.isPending ? t("sep13Connections.connecting") : t("oct6Beta.copy192")}</Button>
          </div>
        </>}
      </>}
    </Card>
  </div>;
}

export function AssistantConnectionsPage() {
  useTranslation();
  const connections = useQuery({ queryKey: ["mcp-connections"], queryFn: () => api.get<McpConnection[]>("/mcp/connections"), retry: false });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/mcp/connections/${id}`), onSuccess: () => { void connections.refetch(); } });
  return <div className="mx-auto max-w-xl space-y-4 py-10">
    <h1 className="text-xl font-semibold">{t("oct6Beta.copy193")}</h1>
    <p className="text-sm text-muted-foreground">{t("oct6Beta.copy194")}</p>
    {connections.isPending && <p className="text-sm">{t("oct6Beta.copy042")}</p>}
    {(connections.error || revoke.error) && <p className="text-sm text-destructive">{(connections.error ?? revoke.error)?.message}</p>}
    {connections.data?.length === 0 && <p className="text-sm">{t("oct6Beta.copy195")}</p>}
    {connections.data?.map((connection) => <Card key={connection.id} className="block space-y-2 p-4">
      <h2 className="font-medium">{connection.clientName}</h2>
      <p className="text-sm text-muted-foreground">{t("oct6Beta.copy196")} {connection.companyName}</p>
      <p className="text-sm">{connection.scopes.includes("paperclip:write") ? t("oct6Beta.copy197") : t("localizationPlugins.ui_Read_only")}</p>
      {connection.revokedAt ? <p className="text-sm text-muted-foreground">{t("sep13Connections.status_revoked")}</p> : <Button variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate(connection.id)}>{t("oct6Beta.copy198")}</Button>}
    </Card>)}
    <Link className="text-sm underline" to="/">{t("oct6Beta.copy182")}</Link>
  </div>;
}
