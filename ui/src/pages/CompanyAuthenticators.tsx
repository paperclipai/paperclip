import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw } from "lucide-react";
import { authenticatorsApi } from "@/api/authenticators";
import { agentsApi } from "@/api/agents";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";

type BarcodeDetectorLike = new (input: { formats: string[] }) => {
  detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>>;
};

async function readAuthenticatorQr(file: File) {
  const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorLike }).BarcodeDetector;
  if (!Detector) throw new Error("QR screenshot scanning is not supported by this browser. Paste the setup key instead.");
  const bitmap = await createImageBitmap(file);
  try {
    const results = await new Detector({ formats: ["qr_code"] }).detect(bitmap);
    const value = results[0]?.rawValue?.trim();
    if (!value?.startsWith("otpauth://")) throw new Error("No TOTP authenticator QR code was found in that image.");
    return value;
  } finally {
    bitmap.close();
  }
}

export function CompanyAuthenticators() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: string }>>({});
  const [now, setNow] = useState(Date.now());

  useEffect(() => setBreadcrumbs([
    { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
    { label: "Settings", href: "/company/settings" },
    { label: "Authenticators" },
  ]), [selectedCompany?.name, setBreadcrumbs]);

  const list = useQuery({ queryKey: ["authenticators", selectedCompanyId], queryFn: () => authenticatorsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const agents = useQuery({ queryKey: ["agents", selectedCompanyId], queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const create = useMutation({
    mutationFn: () => authenticatorsApi.create(selectedCompanyId!, { name, secret, agentIds: [...agentIds] }),
    onSuccess: async () => {
      setName(""); setSecret(""); setAgentIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ["authenticators", selectedCompanyId] });
      pushToast({ title: "Authenticator saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save authenticator", body: error instanceof Error ? error.message : "Unknown error", tone: "error" }),
  });
  const generate = useMutation({
    mutationFn: async (id: string) => ({ id, result: await authenticatorsApi.currentCode(id) }),
    onSuccess: ({ id, result }) => setCodes((current) => ({ ...current, [id]: result })),
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const expired = Object.entries(codes).find(([, result]) => Date.parse(result.expiresAt) <= now);
    if (expired && !generate.isPending) generate.mutate(expired[0]);
  }, [codes, generate, now]);

  const bindAgents = useMutation({
    mutationFn: ({ id, agentIds: nextAgentIds }: { id: string; agentIds: string[] }) => authenticatorsApi.bindAgents(id, nextAgentIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["authenticators", selectedCompanyId] });
      pushToast({ title: "Authenticator assignments updated", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not update assignments", body: error instanceof Error ? error.message : "Unknown error", tone: "error" }),
  });

  return <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
    <div><h1 className="text-lg font-semibold">Authenticators</h1><p className="text-sm text-muted-foreground">Company-scoped TOTP codes. Agents receive only the current six-digit code, never the seed.</p></div>
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div><h2 className="font-medium">Add authenticator</h2><p className="text-xs text-muted-foreground">Paste a Base32 setup key or an otpauth:// URI. The seed is encrypted after saving.</p></div>
      <div className="grid gap-3 md:grid-cols-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Google Workspace — Chrysler" /><Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Setup key or otpauth:// URI" type="password" /></div>
      <label className="block rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Import QR screenshot</span>
        <span className="ml-2">PNG, JPEG, or WebP</span>
        <input className="mt-2 block w-full text-xs" type="file" accept="image/png,image/jpeg,image/webp" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            setSecret(await readAuthenticatorQr(file));
            pushToast({ title: "Authenticator QR recognized", tone: "success" });
          } catch (error) {
            pushToast({ title: "Could not read QR screenshot", body: error instanceof Error ? error.message : "Unknown error", tone: "error" });
          } finally {
            event.target.value = "";
          }
        }} />
      </label>
      <div className="grid gap-2 md:grid-cols-2">{(agents.data ?? []).map((agent) => <label key={agent.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><Checkbox checked={agentIds.has(agent.id)} onCheckedChange={(checked) => setAgentIds((current) => { const next = new Set(current); if (checked) next.add(agent.id); else next.delete(agent.id); return next; })} /><span>{agent.name}</span><span className="ml-auto text-xs text-muted-foreground">{agent.role}</span></label>)}</div>
      <Button onClick={() => create.mutate()} disabled={!name.trim() || !secret.trim() || create.isPending}>{create.isPending ? "Saving…" : "Save authenticator"}</Button>
    </section>
    <section className="divide-y rounded-lg border border-border">{(list.data ?? []).map((authenticator) => {
      const result = codes[authenticator.id];
      const secondsRemaining = result ? Math.max(0, Math.ceil((Date.parse(result.expiresAt) - now) / 1_000)) : null;
      return <div key={authenticator.id} className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3"><KeyRound className="h-4 w-4 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="font-medium">{authenticator.name}</div><div className="text-xs text-muted-foreground">{authenticator.issuer || "Authenticator"}{authenticator.accountName ? ` · ${authenticator.accountName}` : ""}</div></div>{result ? <div className="flex items-center gap-2"><code className="rounded bg-muted px-3 py-1 font-mono text-lg tracking-[0.25em]">{result.code}</code><span className="w-7 text-xs tabular-nums text-muted-foreground">{secondsRemaining}s</span></div> : null}<Button variant="outline" size="sm" onClick={() => generate.mutate(authenticator.id)}><RefreshCw className="mr-1 h-3.5 w-3.5" />{result ? "Refresh" : "Show live code"}</Button></div>
        <div><div className="mb-2 text-xs font-medium text-muted-foreground">Assigned agents</div><div className="flex flex-wrap gap-2">{(agents.data ?? []).map((agent) => {
          const assigned = authenticator.agentIds.includes(agent.id);
          return <label key={agent.id} className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"><Checkbox checked={assigned} onCheckedChange={(checked) => {
            const next = checked ? [...authenticator.agentIds, agent.id] : authenticator.agentIds.filter((id) => id !== agent.id);
            bindAgents.mutate({ id: authenticator.id, agentIds: next });
          }} /><span>{agent.name}</span></label>;
        })}</div></div>
      </div>;
    })}{list.data?.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No authenticators saved for this company.</div> : null}</section>
  </div>;
}
