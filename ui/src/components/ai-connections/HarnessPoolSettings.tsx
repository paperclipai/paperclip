import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HARNESS_POOL_TEMPLATES, BUILTIN_AI_FAILOVER_ROUTER_KEY, harnessPoolConfigSchema, type HarnessPool, type HarnessPoolConfigV2, type HarnessPoolMemberV2, type AiManagedConnectionSummary } from "@paperclipai/shared";
import { harnessPoolsApi } from "@/api/harness-pools";
import { aiConnectionsApi } from "@/api/ai-connections";
import { aiConnectionPoolsApi } from "@/api/ai-connection-pools";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

function newMember(account: AiManagedConnectionSummary): HarnessPoolMemberV2 {
  const harness = account.provider === "anthropic" ? "claude_code" : account.provider === "openai" ? "codex" : account.provider === "xai" ? "grok" : "opencode";
  return { id: crypto.randomUUID(), harness: { type: harness }, connection: { mode: account.ownership === "shared" ? "shared" : "delegated", provider: account.provider, method: account.method, connectionId: account.id, grantId: account.grantId }, model: "" };
}
const emptyPool = (name: string): HarnessPoolConfigV2 => ({ schemaVersion: 2, kind: "harness_pool", name, enabled: true, mode: "failover", members: [] });

export function HarnessPoolSettings({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ["pool-accounts", companyId], queryFn: () => aiConnectionsApi.list(companyId) });
  const allowed = accounts.data?.canManageConnections === true;
  const pools = useQuery({ queryKey: ["harness-pools", companyId], queryFn: () => harnessPoolsApi.list(companyId), enabled: allowed });
  const legacy = useQuery({ queryKey: ["ai-connection-pools", companyId], queryFn: () => aiConnectionPoolsApi.list(companyId), enabled: allowed });
  const [editing, setEditing] = useState<HarnessPool>();
  const [draft, setDraft] = useState<HarnessPoolConfigV2>();
  const [accountId, setAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archiveRequested, setArchiveRequested] = useState(false);
  const [conversion, setConversion] = useState<HarnessPool>();
  const inspection = useQuery({ queryKey: ["harness-pool-inspection", companyId, editing?.id], queryFn: () => harnessPoolsApi.inspect(companyId, editing!.id), enabled: Boolean(editing) });
  const visibleAccounts = accounts.data?.connections ?? [];
  const accountNames = new Map(visibleAccounts.map(account => [account.id, account.name]));
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: ["harness-pool-choices", companyId] }), client.invalidateQueries({ queryKey: ["harness-pools", companyId] }), client.invalidateQueries({ queryKey: ["ai-connection-pools", companyId] }), client.invalidateQueries({ queryKey: ["harness-pool-inspection", companyId] })]);
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(describeError(failure).body); } finally { setBusy(false); }
  }
  function start(name: string) { setEditing(undefined); setDraft(emptyPool(name)); setArchiveRequested(false); setError(""); }
  function updateMember(id: string, patch: Partial<HarnessPoolMemberV2>) {
    setDraft(current => current && ({ ...current, members: current.members.map(member => member.id === id ? { ...member, ...patch } : member) }));
  }
  function move(index: number, delta: number) {
    setDraft(current => { if (!current) return current; const members = [...current.members]; [members[index], members[index + delta]] = [members[index + delta]!, members[index]!]; return { ...current, members }; });
  }
  const loadError = accounts.error ?? pools.error ?? legacy.error;
  return <section className="max-w-2xl space-y-4" aria-label="Harness pools">
    <div className="space-y-2"><h2 className="text-base font-semibold">Harness pools</h2><p className="text-sm text-muted-foreground">Share ordered harness, model and account configurations between agents. Requires an enabled Paperclip Runner. Healthy task sessions keep their current member; unavailable members wait or fail over safely.</p></div>
    {loadError ? <p role="alert" className="text-sm text-destructive">{describeError(loadError).body} <Button variant="outline" onClick={() => { void accounts.refetch(); void pools.refetch(); void legacy.refetch(); }}>Retry</Button></p> : accounts.isPending || (allowed && pools.isPending) ? <p>Loading pools…</p> : !allowed ? <p className="text-sm text-muted-foreground">Connection management permission is required.</p> : <>
      <div className="flex flex-wrap gap-2">{HARNESS_POOL_TEMPLATES.map(name => <Button key={name} variant="outline" disabled={busy} onClick={() => start(name)}>{name}</Button>)}<Button variant="outline" disabled={busy} onClick={() => start("New pool")}>New pool</Button></div>
      <div className="space-y-2">{pools.data?.map(pool => <Button key={pool.id} variant="outline" disabled={busy} onClick={() => { const { id: _id, companyId: _company, revision: _revision, ...config } = pool; setEditing(pool); setDraft(config); setArchiveRequested(false); setError(""); }}>{pool.name} · {pool.members.length} members{pool.enabled ? "" : " · disabled"}</Button>)}</div>
      {draft && <div className="space-y-4 rounded-lg border border-border p-4">
        <label className="block space-y-2"><span className="text-sm">Pool name</span><Input aria-label="Pool name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} disabled={busy} /></label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} disabled={busy} onCheckedChange={checked => setDraft({ ...draft, enabled: checked === true })} />Enabled</label>
        <div className="space-y-3">{draft.members.map((member, index) => <div key={member.id} className="space-y-2 rounded-md border border-border p-3">
          <p className="text-sm">{index + 1}. {accountNames.get(member.connection.connectionId) ?? "Unavailable account"}</p>
          <label className="block text-sm">Harness<NativeSelect aria-label="Member harness" value={member.harness.type} disabled={busy} onChange={event => updateMember(member.id, { harness: { type: event.target.value as HarnessPoolMemberV2["harness"]["type"] } })}>{["claude_code", "codex", "grok", "opencode"].map(type => <option key={type} value={type}>{type === "claude_code" ? "Claude Code" : type}</option>)}</NativeSelect></label>
          <Input aria-label="Model" placeholder="Model ID" value={member.model} disabled={busy} onChange={event => updateMember(member.id, { model: event.target.value })} />
          <Input aria-label="Effort" placeholder="Effort (optional)" value={member.effort ?? ""} disabled={busy} onChange={event => updateMember(member.id, { effort: event.target.value || undefined })} />
          {editing && <p className="text-xs text-muted-foreground">{inspection.data?.members[member.id]?.reason ?? "Availability not checked"}{inspection.data?.members[member.id]?.retryAt && <> · until {new Date(inspection.data.members[member.id]!.retryAt!).toLocaleString()}</>}</p>}
          <div className="flex gap-2"><Button variant="outline" disabled={busy || index === 0} onClick={() => move(index, -1)}>Move up</Button><Button variant="outline" disabled={busy || index === draft.members.length - 1} onClick={() => move(index, 1)}>Move down</Button><Button variant="outline" disabled={busy} onClick={() => setDraft({ ...draft, members: draft.members.filter(item => item.id !== member.id) })}>Remove member</Button></div>
        </div>)}</div>
        <NativeSelect aria-label="Account to add" value={accountId || visibleAccounts[0]?.id || ""} disabled={busy} onChange={event => setAccountId(event.target.value)}>{visibleAccounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</NativeSelect>
        <Button variant="outline" disabled={busy || !visibleAccounts.length || draft.members.length >= 100} onClick={() => { const account = visibleAccounts.find(item => item.id === (accountId || visibleAccounts[0]?.id)); if (account) setDraft({ ...draft, members: [...draft.members, newMember(account)] }); }}>Add member</Button>
        {editing && <><p className="text-sm text-muted-foreground">Used by: {inspection.data?.usedBy.map(agent => agent.name).join(", ") || "No agents"}</p>{inspection.error && <p role="alert" className="text-sm text-destructive">{describeError(inspection.error).body}</p>}</>}
        <div className="flex items-center justify-between gap-2"><Button variant="outline" disabled={busy} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancel</Button><Button disabled={busy} onClick={() => void action(async () => { const config = harnessPoolConfigSchema.parse(draft); const saved = await harnessPoolsApi.save(companyId, { id: editing?.id, expectedRevision: editing?.revision, config }); setEditing(saved); setDraft(config); await refresh(); })}>{busy ? "Saving…" : "Save pool"}</Button></div>
        {editing && <Button variant="outline" disabled={busy} onClick={() => setArchiveRequested(true)}>Archive pool</Button>}
        {archiveRequested && editing && <div className="space-y-2"><p className="text-sm">Archive {editing.name}? Agents using it will need another pool for new work.</p><Button variant="outline" disabled={busy} onClick={() => setArchiveRequested(false)}>Keep pool</Button><Button disabled={busy} onClick={() => void action(async () => { await harnessPoolsApi.archive(companyId, editing.id, editing.revision); setDraft(undefined); setEditing(undefined); setArchiveRequested(false); await refresh(); })}>Confirm archive</Button></div>}
      </div>}
      {legacy.data?.filter(pool => pool.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY && pool.mode === "failover").map(pool => <Button key={pool.id} variant="outline" disabled={busy} onClick={() => void action(async () => { setConversion(await harnessPoolsApi.convert(companyId, pool.id, pool.revision, true)); })}>Preview conversion: {pool.name}</Button>)}
      {conversion && <div className="space-y-2"><p className="text-sm">Convert {conversion.name} with {conversion.members.length} ordered members? Existing agents and active sessions keep their settings. Select Pool explicitly on each agent.</p><Button variant="outline" disabled={busy} onClick={() => setConversion(undefined)}>Cancel conversion</Button><Button disabled={busy} onClick={() => void action(async () => { await harnessPoolsApi.convert(companyId, conversion.id, conversion.revision, false); setConversion(undefined); await refresh(); })}>Convert pool</Button></div>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
