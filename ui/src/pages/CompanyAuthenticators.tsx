import { useEffect, useMemo, useState } from "react";
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

export function CompanyAuthenticators() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: string }>>({});

  useEffect(() => setBreadcrumbs([
    { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
    { label: "Settings", href: "/company/settings" },
    { label: "Authenticators" },
  ]), [selectedCompany?.name, setBreadcrumbs]);

  const list = useQuery({ queryKey: ["authenticators", selectedCompanyId], queryFn: () => authenticatorsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const agents = useQuery({ queryKey: ["agents", selectedCompanyId], queryFn: () => agentsApi.list(selectedCompanyId!), enabled: !!selectedCompanyId });
  const agentById = useMemo(() => new Map((agents.data ?? []).map((agent) => [agent.id, agent])), [agents.data]);
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

  return <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
    <div><h1 className="text-lg font-semibold">Authenticators</h1><p className="text-sm text-muted-foreground">Company-scoped TOTP codes. Agents receive only the current six-digit code, never the seed.</p></div>
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div><h2 className="font-medium">Add authenticator</h2><p className="text-xs text-muted-foreground">Paste a Base32 setup key or an otpauth:// URI. The seed is encrypted after saving.</p></div>
      <div className="grid gap-3 md:grid-cols-2"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Google Workspace — Chrysler" /><Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Setup key or otpauth:// URI" type="password" /></div>
      <div className="grid gap-2 md:grid-cols-2">{(agents.data ?? []).map((agent) => <label key={agent.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><Checkbox checked={agentIds.has(agent.id)} onCheckedChange={(checked) => setAgentIds((current) => { const next = new Set(current); if (checked) next.add(agent.id); else next.delete(agent.id); return next; })} /><span>{agent.name}</span><span className="ml-auto text-xs text-muted-foreground">{agent.role}</span></label>)}</div>
      <Button onClick={() => create.mutate()} disabled={!name.trim() || !secret.trim() || create.isPending}>{create.isPending ? "Saving…" : "Save authenticator"}</Button>
    </section>
    <section className="divide-y rounded-lg border border-border">{(list.data ?? []).map((authenticator) => <div key={authenticator.id} className="flex flex-wrap items-center gap-3 p-4"><KeyRound className="h-4 w-4 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="font-medium">{authenticator.name}</div><div className="text-xs text-muted-foreground">{authenticator.agentIds.map((id) => agentById.get(id)?.name ?? id.slice(0, 8)).join(", ") || "No agents bound"}</div></div>{codes[authenticator.id] ? <code className="rounded bg-muted px-3 py-1 font-mono text-lg tracking-[0.25em]">{codes[authenticator.id].code}</code> : null}<Button variant="outline" size="sm" onClick={() => generate.mutate(authenticator.id)}><RefreshCw className="mr-1 h-3.5 w-3.5" />Current code</Button></div>)}{list.data?.length === 0 ? <div className="p-8 text-center text-sm text-muted-foreground">No authenticators saved for this company.</div> : null}</section>
  </div>;
}
