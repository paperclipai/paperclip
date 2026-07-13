import { memo, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Expand, Grid2X2, List, LoaderCircle, MonitorUp, Plus, Settings2, Trash2, WifiOff } from "lucide-react";
import type { LiveRunForIssue } from "../api/heartbeats";
import { heartbeatsApi } from "../api/heartbeats";
import { useBrowserStream, type BrowserStreamStatus } from "../components/LiveBrowserPreview";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "../lib/router";
import { cn } from "../lib/utils";

function elapsedLabel(value: string | null, now: number) {
  if (!value) return "Starting";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusPresentation(status: BrowserStreamStatus) {
  if (status === "live") return { label: "Live", icon: null, className: "bg-emerald-400/15 text-emerald-300" };
  if (status === "disconnected") return { label: "Reconnecting", icon: WifiOff, className: "bg-amber-400/15 text-amber-200" };
  return { label: "Waiting for browser", icon: LoaderCircle, className: "bg-white/10 text-slate-300" };
}

interface BrowserTileProps {
  run: LiveRunForIssue;
  now: number;
  compact: boolean;
  onExpand: (run: LiveRunForIssue) => void;
}

const BrowserTile = memo(function BrowserTile({ run, now, compact, onExpand }: BrowserTileProps) {
  const { status, frame } = useBrowserStream(run.id);
  const isActive = run.status === "queued" || run.status === "running";
  const presentation = !isActive && !frame
    ? { label: "Session ended", icon: null, className: "bg-white/10 text-slate-300" }
    : statusPresentation(status);
  const StatusIcon = presentation.icon;

  return (
    <article className={cn("overflow-hidden border border-white/10 bg-slate-950 text-slate-100 shadow-sm", compact ? "rounded-xl" : "rounded-2xl")}>
      <div className="relative aspect-video min-h-44 bg-[radial-gradient(circle_at_center,rgba(14,165,233,0.10),transparent_58%)]">
        {frame ? (
          <img src={frame} alt={`${run.agentName} live browser viewport`} className="h-full w-full object-contain" />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-400">
            <MonitorUp className="size-8 text-sky-300/70" />
            <span className="text-sm">The agent has not opened a browser yet</span>
          </div>
        )}
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide backdrop-blur", presentation.className)}>
            {status === "live" ? <span className="size-1.5 animate-pulse rounded-full bg-emerald-300" /> : StatusIcon ? <StatusIcon className={cn("size-3", status === "waiting" && "animate-spin")} /> : null}
            {presentation.label}
          </span>
        </div>
        <Button type="button" variant="secondary" size="icon-sm" className="absolute right-3 top-3 bg-slate-900/75 text-white hover:bg-slate-800" onClick={() => onExpand(run)} aria-label={`Expand ${run.agentName} browser`}>
          <Expand className="size-4" />
        </Button>
      </div>
      <div className="flex items-start justify-between gap-3 border-t border-white/10 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{run.agentName}</span>
            <span className="shrink-0 text-xs text-slate-500">{elapsedLabel(run.startedAt ?? run.createdAt, now)}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-400">
            {run.issueIdentifier ? `${run.issueIdentifier} · ` : ""}{run.issueTitle ?? "Active agent run"}
          </p>
        </div>
        {run.issueId ? (
          <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-slate-400 hover:bg-white/10 hover:text-white">
            <Link to={`/issues/${run.issueIdentifier ?? run.issueId}`} aria-label="Open linked issue"><ExternalLink className="size-4" /></Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
});

function ExpandedBrowser({ run }: { run: LiveRunForIssue }) {
  const { status, frame } = useBrowserStream(run.id);
  const presentation = statusPresentation(status);
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-slate-950">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-slate-100">
        <div><p className="font-semibold">{run.agentName}</p><p className="text-xs text-slate-400">{run.issueIdentifier ?? "Independent browser session"}</p></div>
        <span className={cn("rounded-full px-2.5 py-1 text-xs", presentation.className)}>{presentation.label}</span>
      </div>
      <div className="flex aspect-video max-h-[75vh] items-center justify-center bg-black">
        {frame ? <img src={frame} alt={`${run.agentName} expanded browser viewport`} className="h-full w-full object-contain" /> : <p className="text-sm text-slate-400">Waiting for this agent to open agent-browser…</p>}
      </div>
    </div>
  );
}

function BrowserProfilesDialog({ companyId, open, onOpenChange }: { companyId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const queryKey = ["browser-profiles", companyId] as const;
  const { data, isLoading } = useQuery({ queryKey, queryFn: () => heartbeatsApi.browserProfiles(companyId), enabled: open });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const createProfile = useMutation({
    mutationFn: () => heartbeatsApi.createBrowserProfile(companyId, name.trim()),
    onSuccess: () => { setName(""); void refresh(); },
  });
  const assignProfile = useMutation({
    mutationFn: ({ projectId, profileId }: { projectId: string; profileId: string }) => heartbeatsApi.assignBrowserProfile(companyId, projectId, profileId),
    onSuccess: () => { void refresh(); },
  });
  const deleteProfile = useMutation({
    mutationFn: (profileId: string) => heartbeatsApi.deleteBrowserProfile(companyId, profileId),
    onSuccess: () => { void refresh(); },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" aria-describedby={undefined}>
        <div><DialogTitle>Browser profiles</DialogTitle><p className="mt-1 text-sm text-muted-foreground">Every project uses Default unless you assign another saved login.</p></div>
        {isLoading ? <div className="flex min-h-40 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div> : (
          <div className="space-y-6">
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Profiles</h3>
              <div className="divide-y rounded-xl border">
                {data?.profiles.map((profile) => (
                  <div key={profile.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{profile.name}</p><p className="truncate text-xs text-muted-foreground">{profile.isDefault ? "Company default" : "Saved cookies and login state"}</p></div>
                    {!profile.isDefault ? <Button variant="ghost" size="icon-sm" disabled={deleteProfile.isPending} onClick={() => deleteProfile.mutate(profile.id)} aria-label={`Delete ${profile.name}`}><Trash2 className="size-4" /></Button> : null}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="New profile name" onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) createProfile.mutate(); }} />
                <Button disabled={!name.trim() || createProfile.isPending} onClick={() => createProfile.mutate()}><Plus className="mr-1.5 size-4" />Add profile</Button>
              </div>
            </section>
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Project assignments</h3>
              {data?.projects.length ? <div className="divide-y rounded-xl border">
                {data.projects.map((project) => (
                  <div key={project.id} className="flex items-center justify-between gap-4 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm">{project.name}</span>
                    <Select value={project.profileId} onValueChange={(profileId) => assignProfile.mutate({ projectId: project.id, profileId })} disabled={assignProfile.isPending}>
                      <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                      <SelectContent>{data.profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                ))}
              </div> : <p className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No projects yet.</p>}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Browsers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [expanded, setExpanded] = useState<LiveRunForIssue | null>(null);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => setBreadcrumbs([{ label: "Browsers" }]), [setBreadcrumbs]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { data: runs = [], isLoading } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "browser-workspace"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { minCount: 50, limit: 50, browserOnly: true }),
    enabled: !!selectedCompanyId,
    refetchInterval: 3_000,
  });
  const orderedRuns = useMemo(() => {
    const sorted = [...runs].sort((a, b) => new Date(b.startedAt ?? b.createdAt).getTime() - new Date(a.startedAt ?? a.createdAt).getTime());
    const latestByIssue = new Map<string, LiveRunForIssue>();
    for (const run of sorted) {
      const key = run.issueId ?? run.id;
      if (!latestByIssue.has(key)) latestByIssue.set(key, run);
    }
    return [...latestByIssue.values()];
  }, [runs]);
  const activeRunCount = orderedRuns.filter((run) => run.status === "queued" || run.status === "running").length;

  return (
    <div className="mx-auto w-full max-w-[1800px] px-5 py-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="flex items-center gap-2"><MonitorUp className="size-5 text-sky-500" /><h1 className="text-2xl font-semibold tracking-tight">Browsers</h1></div><p className="mt-1 text-sm text-muted-foreground">Live, issue-owned browser sessions. Idle sessions close after one hour.</p></div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground"><strong className="font-semibold text-foreground">{activeRunCount}</strong> active · {orderedRuns.length} recent</span>
          <div className="flex rounded-lg border bg-muted/30 p-1">
            <Button variant={layout === "grid" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setLayout("grid")} aria-label="Grid view"><Grid2X2 className="size-4" /></Button>
            <Button variant={layout === "list" ? "secondary" : "ghost"} size="icon-sm" onClick={() => setLayout("list")} aria-label="List view"><List className="size-4" /></Button>
          </div>
          <Button variant="outline" onClick={() => setProfilesOpen(true)}><Settings2 className="mr-1.5 size-4" />Profiles</Button>
        </div>
      </header>

      {isLoading ? <div className="flex min-h-72 items-center justify-center text-muted-foreground"><LoaderCircle className="mr-2 size-5 animate-spin" />Loading active sessions…</div> : orderedRuns.length === 0 ? (
        <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed bg-muted/15 text-center"><MonitorUp className="mb-4 size-10 text-muted-foreground/60" /><h2 className="font-semibold">No active browser sessions</h2><p className="mt-1 max-w-md text-sm text-muted-foreground">When an agent starts working, its isolated browser will appear here automatically.</p></div>
      ) : (
        <div className={cn("grid gap-5", layout === "grid" ? "grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3" : "mx-auto max-w-5xl grid-cols-1")}>
          {orderedRuns.map((run) => <BrowserTile key={run.id} run={run} now={now} compact={layout === "list"} onExpand={setExpanded} />)}
        </div>
      )}

      <Dialog open={!!expanded} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[1500px] bg-slate-950/95 p-3" aria-describedby={undefined}>
          <DialogTitle className="sr-only">Expanded live browser</DialogTitle>
          {expanded ? <ExpandedBrowser run={expanded} /> : null}
        </DialogContent>
      </Dialog>
      {selectedCompanyId ? <BrowserProfilesDialog companyId={selectedCompanyId} open={profilesOpen} onOpenChange={setProfilesOpen} /> : null}
    </div>
  );
}
