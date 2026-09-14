import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, Share2 } from "lucide-react";
import type { RuntimeService, RuntimeServiceShare } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { ApiError } from "../api/client";
import { formatDateTime } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type ShareInput = { requestId: string; endpointName: string; expiresAt: string };
export function RuntimeServiceSharing({ service, disabled }: { service: RuntimeService; disabled?: boolean }) {
  const client = useQueryClient(); const id = useId();
  const key = ["runtime-services", service.companyId, "shares", service.id];
  const endpoints = service.endpoints.filter((endpoint) => endpoint.url);
  const [open, setOpen] = useState(false); const [endpoint, setEndpoint] = useState(endpoints[0]?.name ?? "");
  const [hours, setHours] = useState("24"); const [request, setRequest] = useState<ShareInput | null>(null);
  const [feedback, setFeedback] = useState("");
  const submitting = useRef(false);
  const shares = useQuery({ queryKey: key, queryFn: ({ signal }) => runtimeServicesApi.shares(service.companyId, service.id, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }),
    refetchInterval: 10_000, refetchIntervalInBackground: false, retry: 1,
    structuralSharing: (previous, incoming) => {
      const old = new Map(((previous ?? []) as RuntimeServiceShare[]).map((share) => [share.id, share]));
      return (incoming as RuntimeServiceShare[]).map((share) => old.get(share.id)?.revokedAt ? old.get(share.id)! : share);
    },
  });
  const refresh = () => { submitting.current = false; void client.invalidateQueries({ queryKey: key }); };
  const publish = (updated: RuntimeServiceShare) => client.setQueryData<RuntimeServiceShare[]>(key, (current = []) => current.some((share) => share.id === updated.id) ? current.map((share) => share.id === updated.id ? updated : share) : [...current, updated]);
  const create = useMutation({ mutationFn: (input: ShareInput) => runtimeServicesApi.createShare(service.companyId, service.id, input, { signal: AbortSignal.timeout(20_000) }),
    retry: false, onSuccess: (share) => { publish(share); setRequest(null); setOpen(false); setFeedback("Share link created."); },
    onError: (error) => { if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) setRequest(null); }, onSettled: refresh });
  const revoke = useMutation({ mutationFn: (shareId: string) => runtimeServicesApi.revokeShare(service.companyId, service.id, shareId, { signal: AbortSignal.timeout(20_000) }),
    retry: false, onSuccess: (share) => { publish(share); setFeedback("Share link revoked. Existing viewers lose access."); }, onSettled: refresh });
  // A lost mutation response is uncertain only until an authoritative list
  // confirms that exact share was revoked. Revocation is irreversible.
  const revokeConfirmed = revoke.isError && shares.data?.some((share) => share.id === revoke.variables && share.revokedAt);
  const status = revokeConfirmed ? "Share link revoked. Existing viewers lose access." : feedback;
  useEffect(() => {
    if (!revokeConfirmed) return;
    revoke.reset();
    setFeedback("Share link revoked. Existing viewers lose access.");
  }, [revokeConfirmed, revoke.reset]);
  const busy = create.isPending || revoke.isPending;
  const revokeLink = (shareId: string) => { if (!disabled && !submitting.current) { submitting.current = true; revoke.mutate(shareId); } };
  return <section aria-label="Preview sharing" className="flex min-w-0 flex-col gap-3 border-t border-border pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">Preview sharing</h2><Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => setOpen(!open)}><Share2 aria-hidden="true" />Share preview</Button></div>
    <p className="text-xs text-muted-foreground">Previews are private. A share link lets anyone holding it use that app until it expires or you revoke it.</p>
    {open && <form aria-label="Create preview share" className="flex flex-col gap-3" onSubmit={(event) => {
      event.preventDefault(); if (submitting.current || disabled) return; submitting.current = true;
      const input = request ?? { requestId: crypto.randomUUID(), endpointName: endpoint, expiresAt: new Date(Date.now() + Number(hours) * 3600_000).toISOString() };
      setRequest(input); create.mutate(input);
    }}>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-endpoint`}>App endpoint</Label><select id={`${id}-endpoint`} className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={endpoint} disabled={!!request || disabled} onChange={(event) => setEndpoint(event.target.value)}>{endpoints.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}</select></div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-expiry`}>Link expires after</Label><select id={`${id}-expiry`} className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={hours} disabled={!!request || disabled} onChange={(event) => setHours(event.target.value)}><option value="1">1 hour</option><option value="24">24 hours</option><option value="168">7 days</option></select></div>
      <Button type="submit" size="sm" className="self-start" disabled={disabled || busy || !endpoint}>{create.isPending && <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />}{create.isPending ? "Creating link…" : request ? "Retry same request" : "Create share link"}</Button>
      {create.isError && <p className="text-xs text-destructive" role="alert">{request ? "Could not confirm link creation. Retry the same request to avoid creating another link." : create.error.message}</p>}
    </form>}
    {shares.isPending && <p role="status" className="text-xs text-muted-foreground">Loading share links…</p>}
    {shares.isError && <div className="flex flex-wrap items-center gap-2" role="alert"><p className="text-xs text-destructive">Share links could not be refreshed.</p><Button size="xs" variant="outline" onClick={() => void shares.refetch()}>Retry sharing</Button></div>}
    {shares.data?.map((share) => <div key={share.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{share.endpointName} · {share.revokedAt ? "Revoked" : !share.url ? "Expired" : `Expires ${formatDateTime(share.expiresAt)}`}</p>
      {share.url && <><Input readOnly aria-label={`${share.endpointName} share link`} value={share.url} /><div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={async () => { try { await copyTextToClipboard(share.url!); setFeedback("Share link copied."); } catch { setFeedback("Could not copy. Select the link above and copy it."); } }}><Copy aria-hidden="true" />Copy link</Button><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => revokeLink(share.id)}>{revoke.isPending && revoke.variables === share.id ? "Revoking…" : "Revoke link"}</Button></div></>}
    </div>)}
    {revoke.isError && !revokeConfirmed && <div className="flex flex-col gap-2" role="alert"><p className="text-xs text-destructive">Could not confirm revocation. {revoke.error.message}</p><Button size="sm" variant="outline" className="self-start" disabled={disabled || busy} onClick={() => revokeLink(revoke.variables)}>Retry revocation</Button></div>}
    {status && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{status}</p>}
  </section>;
}
