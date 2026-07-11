import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Github, KeyRound, Loader2, PlugZap, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { githubConnectionsApi } from "@/api/githubConnections";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";

export function CompanyGithub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("github.com");
  const [secretId, setSecretId] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setBreadcrumbs([{ label: "Company Settings" }, { label: "GitHub" }]), [setBreadcrumbs]);

  const connectionsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.githubConnections.list(selectedCompanyId) : ["github-connections", "disabled"],
    queryFn: () => githubConnectionsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "disabled"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const activeSecrets = useMemo(() => (secretsQuery.data ?? []).filter((secret) => secret.status === "active"), [secretsQuery.data]);

  const refresh = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.githubConnections.list(selectedCompanyId) });
  };

  const createConnection = useMutation({
    mutationFn: () => githubConnectionsApi.create(selectedCompanyId!, { name: name.trim(), hostname: hostname.trim(), secretId }),
    onSuccess: async (connection) => {
      setName("");
      setSecretId("");
      setMessage(`${connection.name} added. Test it, then bind it from a project workspace.`);
      await refresh();
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Could not add GitHub connection."),
  });

  const testConnection = useMutation({
    mutationFn: (connectionId: string) => githubConnectionsApi.test(selectedCompanyId!, connectionId),
    onSuccess: async (result) => {
      setMessage(result.message);
      await refresh();
    },
    onError: async (error) => {
      setMessage(error instanceof Error ? error.message : "Connection test failed.");
      await refresh();
    },
  });

  const updateConnection = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => githubConnectionsApi.update(selectedCompanyId!, id, { enabled }),
    onSuccess: refresh,
    onError: (error) => setMessage(error instanceof Error ? error.message : "Could not update connection."),
  });

  const removeConnection = useMutation({
    mutationFn: (connectionId: string) => githubConnectionsApi.remove(selectedCompanyId!, connectionId),
    onSuccess: async () => {
      setMessage("GitHub connection removed. Bound projects now use no GitHub credential.");
      await refresh();
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Could not remove connection."),
  });

  if (!selectedCompanyId) return <div className="p-6 text-sm text-muted-foreground">Select a company first.</div>;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="relative border-b border-border bg-gradient-to-br from-zinc-950 via-zinc-900 to-slate-900 px-6 py-7 text-white">
          <div className="pointer-events-none absolute -right-12 -top-20 h-48 w-48 rounded-full bg-violet-500/20 blur-3xl" />
          <div className="relative flex items-start gap-4">
            <div className="rounded-2xl border border-white/10 bg-white/10 p-3"><Github className="h-6 w-6" /></div>
            <div>
              <div className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">Native integration</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">GitHub connections</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-300">
                Keep several GitHub identities at company level, then choose the right one per project. Private clones, <code className="rounded bg-white/10 px-1">gh</code>, and ordinary <code className="rounded bg-white/10 px-1">git push</code> use the project&apos;s selection automatically.
              </p>
            </div>
          </div>
        </div>

        <form
          className="grid gap-4 p-6 md:grid-cols-[1fr_1fr_1.35fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() && hostname.trim() && secretId) createConnection.mutate();
          }}
        >
          <label className="space-y-1.5 text-sm"><span className="font-medium">Connection name</span><input className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ade personal" /></label>
          <label className="space-y-1.5 text-sm"><span className="font-medium">GitHub host</span><input className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono outline-none focus:ring-2 focus:ring-ring" value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="github.com" /></label>
          <label className="space-y-1.5 text-sm"><span className="font-medium">Token secret</span><select className="w-full rounded-lg border border-border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" value={secretId} onChange={(event) => setSecretId(event.target.value)}><option value="">Select an encrypted company secret</option>{activeSecrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}</select></label>
          <Button type="submit" disabled={!name.trim() || !hostname.trim() || !secretId || createConnection.isPending}>{createConnection.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PlugZap className="mr-2 h-4 w-4" />}Add</Button>
        </form>
        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground"><KeyRound className="h-3.5 w-3.5" />Tokens remain encrypted in Company Secrets. <Link className="font-medium text-foreground underline underline-offset-4" to="/company/settings/secrets">Manage secrets</Link></div>
      </div>

      {message ? <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">{message}</div> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {(connectionsQuery.data ?? []).map((connection) => (
          <div key={connection.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <div className="rounded-xl bg-muted p-2.5"><Github className="h-5 w-5" /></div>
                <div className="min-w-0"><h2 className="truncate font-semibold">{connection.name}</h2><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{connection.hostname}</p></div>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${connection.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground"}`}>{connection.enabled ? "Active" : "Disabled"}</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Secret</div><div className="mt-1 truncate font-medium">{connection.secretName}</div></div>
              <div className="rounded-xl bg-muted/50 p-3"><div className="text-xs text-muted-foreground">Bound projects</div><div className="mt-1 font-medium">{connection.projectCount}</div></div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm">
              {connection.lastTestStatus === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : connection.lastTestStatus === "error" ? <XCircle className="h-4 w-4 text-destructive" /> : <ShieldCheck className="h-4 w-4 text-muted-foreground" />}
              <span className="text-muted-foreground">{connection.lastTestMessage ?? "Not tested yet"}</span>
              {connection.accountLogin ? <span className="ml-auto font-mono text-xs">@{connection.accountLogin}</span> : null}
            </div>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
              <Button variant="outline" size="sm" disabled={!connection.enabled || testConnection.isPending} onClick={() => testConnection.mutate(connection.id)}>{testConnection.isPending && testConnection.variables === connection.id ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}Test connection</Button>
              <Button variant="outline" size="sm" disabled={updateConnection.isPending} onClick={() => updateConnection.mutate({ id: connection.id, enabled: !connection.enabled })}>{connection.enabled ? "Disable" : "Enable"}</Button>
              <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:text-destructive" disabled={removeConnection.isPending} onClick={() => { if (window.confirm(`Remove ${connection.name}? Projects using it will be unbound.`)) removeConnection.mutate(connection.id); }}><Trash2 className="mr-2 h-3.5 w-3.5" />Remove</Button>
            </div>
          </div>
        ))}
      </div>

      {!connectionsQuery.isLoading && (connectionsQuery.data ?? []).length === 0 ? <div className="rounded-2xl border border-dashed border-border px-6 py-12 text-center"><Github className="mx-auto h-8 w-8 text-muted-foreground" /><h2 className="mt-3 font-semibold">No GitHub connections yet</h2><p className="mt-1 text-sm text-muted-foreground">Add the credentials you use for different accounts or organizations.</p></div> : null}
    </div>
  );
}
