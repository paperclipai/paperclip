import { ArrowDown, ArrowUp, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, harnessPoolConfigSchema, type HarnessPool, type HarnessPoolConfigV2 } from "@paperclipai/shared";
import { harnessPoolsApi } from "@/api/harness-pools";
import { aiConnectionsApi } from "@/api/ai-connections";
import { aiConnectionPoolsApi } from "@/api/ai-connection-pools";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

import { HarnessPoolMemberFields, type HarnessPoolMemberDraft } from "./HarnessPoolMemberFields";

type PoolDraft = Omit<HarnessPoolConfigV2, "members"> & { members: HarnessPoolMemberDraft[] };
const emptyPool = (name: string): PoolDraft => ({ schemaVersion: 2, kind: "harness_pool", name, enabled: true, mode: "failover", members: [] });

export function HarnessPoolSettings({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId) });
  const allowed = accounts.data?.canManageConnections === true;
  const pools = useQuery({ queryKey: ["harness-pools", companyId], queryFn: () => harnessPoolsApi.list(companyId), enabled: allowed });
  const legacy = useQuery({ queryKey: ["ai-connection-pools", companyId], queryFn: () => aiConnectionPoolsApi.list(companyId), enabled: allowed });
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const poolEntries = useMemo(() => (pools.data ?? []).map(pool => ({ pool, searchName: pool.name.toLocaleLowerCase() })), [pools.data]);
  const searchQuery = search.trim().toLocaleLowerCase();
  const visiblePools = poolEntries.filter(entry => entry.searchName.includes(searchQuery));
  function clearSearch() { setSearch(""); searchRef.current?.focus(); }
  const [editing, setEditing] = useState<HarnessPool>();
  const [draft, setDraft] = useState<PoolDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archiveRequested, setArchiveRequested] = useState(false);
  const [conversion, setConversion] = useState<HarnessPool>();
  const inspection = useQuery({ queryKey: ["harness-pool-inspection", companyId, editing?.id], queryFn: () => harnessPoolsApi.inspect(companyId, editing!.id), enabled: Boolean(editing) });
  const inspectionReady = inspection.isSuccess && !inspection.isFetching;
  async function refresh() {
    await Promise.all([client.invalidateQueries({ queryKey: ["harness-pool-choices", companyId] }), client.invalidateQueries({ queryKey: ["harness-pools", companyId] }), client.invalidateQueries({ queryKey: ["ai-connection-pools", companyId] }), client.invalidateQueries({ queryKey: ["harness-pool-inspection", companyId] })]);
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (failure) { setError(describeError(failure).body); } finally { setBusy(false); }
  }
  function start(name: string) { setEditing(undefined); setDraft(emptyPool(name)); setArchiveRequested(false); setError(""); }
  function updateMember(id: string, patch: Partial<HarnessPoolMemberDraft>) {
    setDraft(current => current && ({ ...current, members: current.members.map(member => member.id === id ? { ...member, ...patch } : member) }));
  }
  function move(index: number, delta: number) {
    setDraft(current => { if (!current) return current; const members = [...current.members]; [members[index], members[index + delta]] = [members[index + delta]!, members[index]!]; return { ...current, members }; });
  }
  const loadError = accounts.error ?? pools.error ?? legacy.error;
  return <section className="space-y-4" aria-label="Harness pools">
    <div className="space-y-2"><h1 className="text-lg font-semibold">Pools</h1><p className="text-sm text-muted-foreground">Manage shared harness settings and fallback order for your agents.</p></div>
    {loadError ? <p role="alert" className="text-sm text-destructive">{describeError(loadError).body} <Button variant="outline" onClick={() => { void accounts.refetch(); void pools.refetch(); void legacy.refetch(); }}>Retry</Button></p> : accounts.isPending || (allowed && pools.isPending) ? <p>Loading pools…</p> : !allowed ? <p className="text-sm text-muted-foreground">Connection management permission is required.</p> : <>
      <div className="flex min-h-(--sz-480px) flex-col md:flex-row">
      <aside aria-label="Pools" className="flex max-h-(--sz-480px) min-h-0 flex-col border-b border-border bg-background md:max-h-(--sz-720px) md:w-72 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex shrink-0 items-center gap-2 px-3 pb-3 pt-5">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input ref={searchRef} aria-label="Search pools" placeholder="Search pools" value={search} disabled={busy}
              onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); clearSearch(); } }}
              className="h-9 pl-8 pr-8 text-xs md:text-xs" />
            {search && <Button variant="ghost" size="icon-xs" aria-label="Clear pool search" disabled={busy} className="absolute right-1 top-1/2 -translate-y-1/2" onClick={clearSearch}><X aria-hidden="true" className="size-3" /></Button>}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Add pool" disabled={busy} onClick={() => start("")}><Plus aria-hidden="true" className="size-4" /></Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3 scrollbar-auto-hide">
          <nav aria-label="Pool list" className="flex flex-col gap-1">{visiblePools.map(({ pool }) =>
            <Button key={pool.id} variant="ghost" aria-label={`${pool.name} · ${pool.members.length} members${pool.enabled ? "" : " · disabled"}`}
              className={`h-auto w-full justify-start whitespace-normal rounded-md px-2.5 py-3 text-left ${editing?.id === pool.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`}
              aria-pressed={editing?.id === pool.id} disabled={busy}
              onClick={() => { const { id: _id, companyId: _company, revision: _revision, ...config } = pool; setEditing(pool); setDraft(config); setArchiveRequested(false); setError(""); }}>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-sm font-medium">{pool.name}</span><span className="truncate text-xs text-muted-foreground">{pool.members.length} members{pool.enabled ? "" : " · disabled"}</span></span>
            </Button>)}</nav>
          {!pools.data?.length ? <p className="px-2 py-6 text-sm text-muted-foreground">No pools yet. Add a pool to share harness settings between agents.</p>
            : !visiblePools.length && <div className="flex flex-col items-start gap-2 px-2 py-6"><p role="status" className="text-sm font-medium">No pools found</p><p className="text-xs text-muted-foreground">Try another pool name.</p><Button variant="outline" size="sm" onClick={clearSearch} disabled={busy}>Clear search</Button></div>}
        </div>
      </aside>
      <div className="min-w-0 flex-1 py-5 md:pl-6">
      {!draft && <p className="text-sm text-muted-foreground">Select a pool to edit, or add a pool.</p>}
      {draft && <div className="space-y-6">
        <label className="block space-y-2"><span className="text-sm">Pool name</span><Input aria-label="Pool name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} disabled={busy} /></label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} disabled={busy} onCheckedChange={checked => setDraft({ ...draft, enabled: checked === true })} />Enabled</label>
        <div className="space-y-6">{draft.members.map((member, index) => <section key={member.id} data-pool-member={member.id} aria-labelledby={`pool-member-${member.id}`} className="space-y-3">
          <header className="flex items-center justify-between gap-3">
            <h3 id={`pool-member-${member.id}`} className="text-sm font-medium">Member {index + 1}</h3>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" aria-label="Move up" title="Move up" disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" className="size-4" /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Move down" title="Move down" disabled={busy || index === draft.members.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" className="size-4" /></Button>
            </div>
          </header>
          <HarnessPoolMemberFields companyId={companyId} member={member} readOnly={busy} onChange={patch => { if (!busy) updateMember(member.id, patch); }} />
          {editing && <p className="text-xs text-muted-foreground">{inspection.data?.members[member.id]?.reason ?? "Availability not checked"}{inspection.data?.members[member.id]?.retryAt && <> · until {new Date(inspection.data.members[member.id]!.retryAt!).toLocaleString()}</>}</p>}
          <footer className="flex justify-end"><Button variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => setDraft({ ...draft, members: draft.members.filter(item => item.id !== member.id) })}><Trash2 aria-hidden="true" className="size-4" />Remove member</Button></footer>
        </section>)}</div>
        <Button variant="outline" disabled={busy || draft.members.length >= 100} onClick={() => setDraft({ ...draft, members: [...draft.members, { id: crypto.randomUUID(), harness: { type: "codex" }, runner: "paperclip", model: "" }] })}>Add member</Button>
        {editing && <><p className="text-sm text-muted-foreground">Used by: {inspection.data ? inspection.data.usedBy.map(agent => agent.name).join(", ") || "No agents" : inspection.error ? "Inspection unavailable" : "Loading affected agents…"}</p>{inspection.error && <p role="alert" className="text-sm text-destructive">{describeError(inspection.error).body} <Button variant="outline" onClick={() => void inspection.refetch()}>Retry inspection</Button></p>}</>}
        <div className="flex items-center justify-between gap-2"><Button variant="outline" disabled={busy} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancel</Button><Button disabled={busy} onClick={() => void action(async () => { const config = harnessPoolConfigSchema.parse(draft); const saved = await harnessPoolsApi.save(companyId, { id: editing?.id, expectedRevision: editing?.revision, config }); setEditing(saved); setDraft(config); await refresh(); })}>{busy ? "Saving…" : "Save pool"}</Button></div>
        {editing && <Button variant="outline" disabled={busy || !inspectionReady} onClick={() => setArchiveRequested(true)}>Archive pool</Button>}
        {archiveRequested && editing && <div className="space-y-2"><p className="text-sm">Archive {editing.name}? Agents using it will need another pool for new work.</p><Button variant="outline" disabled={busy} onClick={() => setArchiveRequested(false)}>Keep pool</Button><Button disabled={busy || !inspectionReady} onClick={() => void action(async () => { if (!inspectionReady) return; await harnessPoolsApi.archive(companyId, editing.id, editing.revision); setDraft(undefined); setEditing(undefined); setArchiveRequested(false); await refresh(); })}>Confirm archive</Button></div>}
      </div>}
      </div>
      </div>
      {legacy.data?.filter(pool => pool.pluginKey === BUILTIN_AI_FAILOVER_ROUTER_KEY && pool.mode === "failover").map(pool => <Button key={pool.id} variant="outline" disabled={busy} onClick={() => void action(async () => { setConversion(await harnessPoolsApi.convert(companyId, pool.id, pool.revision, true)); })}>Preview conversion: {pool.name}</Button>)}
      {conversion && <div className="space-y-2"><p className="text-sm">Convert {conversion.name} with {conversion.members.length} ordered members? Existing agents and active sessions keep their settings. Select Pool explicitly on each agent.</p><Button variant="outline" disabled={busy} onClick={() => setConversion(undefined)}>Cancel conversion</Button><Button disabled={busy} onClick={() => void action(async () => { await harnessPoolsApi.convert(companyId, conversion.id, conversion.revision, false); setConversion(undefined); await refresh(); })}>Convert pool</Button></div>}
    </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
