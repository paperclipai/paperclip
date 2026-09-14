import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, LockKeyhole, Share2 } from "lucide-react";
import type { RuntimeService, RuntimeServiceShare } from "@paperclipai/shared";
import { runtimeServicesApi } from "../api/runtime-services";
import { ApiError } from "../api/client";
import { formatDateTime } from "../lib/utils";
import { copyTextToClipboard } from "../lib/clipboard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

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
  return <section aria-label="Preview sharing" className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-sm font-semibold">Preview sharing</h2><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><LockKeyhole className="size-3" aria-hidden="true" />Private by default</p></div><Button variant="outline" size="sm" disabled={disabled || busy} onClick={() => setOpen(!open)}><Share2 aria-hidden="true" />Share preview</Button></div>
    <p className="text-xs text-muted-foreground">Anyone with a share link can use the app until the link expires or you revoke it.</p>
    {open && <form aria-label="Create preview share" className="grid grid-cols-1 gap-4 rounded-md bg-muted/30 p-4 sm:grid-cols-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-(--motion-duration-fast)" onSubmit={(event) => {
      event.preventDefault(); if (submitting.current || disabled) return; submitting.current = true;
      const input = request ?? { requestId: crypto.randomUUID(), endpointName: endpoint, expiresAt: new Date(Date.now() + Number(hours) * 3600_000).toISOString() };
      setRequest(input); create.mutate(input);
    }}>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-endpoint`}>App endpoint</Label><Select value={endpoint} disabled={!!request || disabled} onValueChange={setEndpoint}><SelectTrigger className="w-full" id={`${id}-endpoint`}><SelectValue /></SelectTrigger><SelectContent>{endpoints.map((e) => <SelectItem key={e.name} value={e.name}>{e.name}</SelectItem>)}</SelectContent></Select></div>
      <div className="flex flex-col gap-1.5"><Label htmlFor={`${id}-expiry`}>Link expires after</Label><Select value={hours} disabled={!!request || disabled} onValueChange={setHours}><SelectTrigger className="w-full" id={`${id}-expiry`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="1">1 hour</SelectItem><SelectItem value="24">24 hours</SelectItem><SelectItem value="168">7 days</SelectItem></SelectContent></Select></div>
      <Button type="submit" size="sm" className="justify-self-start sm:col-span-2" disabled={disabled || busy || !endpoint}>{create.isPending && <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />}{create.isPending ? "Creating link…" : request ? "Retry same request" : "Create share link"}</Button>
      {create.isError && <p className="text-xs text-destructive sm:col-span-2" role="alert">{request ? "Could not confirm link creation. Retry the same request to avoid creating another link." : create.error.message}</p>}
    </form>}
    {shares.isPending && <p role="status" className="text-xs text-muted-foreground">Loading share links…</p>}
    {shares.isError && <div className="flex flex-wrap items-center gap-2" role="alert"><p className="text-xs text-destructive">Share links could not be refreshed.</p><Button size="xs" variant="outline" onClick={() => void shares.refetch()}>Retry sharing</Button></div>}
    {shares.data?.map((share) => <div key={share.id} className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{share.endpointName} · {share.revokedAt ? "Revoked" : !share.url ? "Expired" : `Expires ${formatDateTime(share.expiresAt)}`}</p>
      {share.url && <><Input className="font-mono text-xs" readOnly aria-label={`${share.endpointName} share link`} value={share.url} /><div className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" onClick={async () => { try { await copyTextToClipboard(share.url!); setFeedback("Share link copied."); } catch { setFeedback("Could not copy. Select the link above and copy it."); } }}><Copy aria-hidden="true" />Copy link</Button><Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => revokeLink(share.id)}>{revoke.isPending && revoke.variables === share.id ? "Revoking…" : "Revoke link"}</Button></div></>}
    </div>)}
    {revoke.isError && !revokeConfirmed && <div className="flex flex-col gap-2" role="alert"><p className="text-xs text-destructive">Could not confirm revocation. {revoke.error.message}</p><Button size="sm" variant="outline" className="self-start" disabled={disabled || busy} onClick={() => revokeLink(revoke.variables)}>Retry revocation</Button></div>}
    {status && <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{status}</p>}
  </section>;
}
