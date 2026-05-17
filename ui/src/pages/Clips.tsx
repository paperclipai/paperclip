import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  Package,
  Repeat,
  ShieldAlert,
  Sparkles,
  Upload,
} from "lucide-react";
import type {
  ClipSharePreviewResult,
  ClipType,
  ClipVisibility,
  PublicClip,
} from "@paperclipai/shared";
import { clipsApi } from "../api/clips";
import { agentsApi } from "../api/agents";
import { routinesApi } from "../api/routines";
import { companySkillsApi } from "../api/companySkills";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ShareSource = {
  id: string;
  type: ClipType;
  label: string;
  description: string;
};

const visibilityLabels: Record<ClipVisibility, string> = {
  private_share: "Private link",
  unlisted: "Unlisted",
  public: "Public review",
};

function asPreviewRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function getPreviewPlan(preview: unknown) {
  const record = asPreviewRecord(preview);
  return asPreviewRecord(record.plan);
}

function getPreviewArray<T = Record<string, unknown>>(preview: unknown, key: string): T[] {
  const value = getPreviewPlan(preview)[key];
  return Array.isArray(value) ? value as T[] : [];
}

function formatCount(value: number, singular: string, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function clipRevisionLabel(clip: PublicClip) {
  const revision = clip.currentRevision?.revisionNumber;
  return revision ? `revision ${revision}` : "no public revision";
}

function safetyTone(clip: PublicClip) {
  if (clip.moderationState === "warning" || clip.moderationState === "under_review") return "text-amber-600";
  if (clip.moderationState === "limited" || clip.moderationState === "blocked") return "text-destructive";
  return "text-muted-foreground";
}

export function Clips() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [importUrl, setImportUrl] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareSource, setShareSource] = useState<ShareSource | null>(null);
  const [shareDraft, setShareDraft] = useState({
    title: "",
    summary: "",
    slug: "",
    visibility: "unlisted" as ClipVisibility,
    revisionNote: "",
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Clips" }]);
  }, [setBreadcrumbs]);

  const { data: publicClips, isLoading: clipsLoading } = useQuery({
    queryKey: queryKeys.clips.publicList({ limit: 18 }),
    queryFn: () => clipsApi.listPublic({ limit: 18 }),
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: routines } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: skills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId!),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const shareSources = useMemo<ShareSource[]>(() => {
    const sources: ShareSource[] = [];
    if (selectedCompany) {
      sources.push({
        id: "company",
        type: "bundle",
        label: `${selectedCompany.name} bundle`,
        description: "Share the current company as a bundled starter package.",
      });
      sources.push({
        id: "company",
        type: "team",
        label: `${selectedCompany.name} team`,
        description: "Share the org team and selected skills as a team clip.",
      });
    }
    for (const agent of agents ?? []) {
      sources.push({
        id: agent.id,
        type: "agent",
        label: agent.name,
        description: agent.capabilities ?? agent.title ?? agent.role,
      });
    }
    for (const skill of skills ?? []) {
      sources.push({
        id: skill.id,
        type: "skill",
        label: skill.name,
        description: skill.description ?? skill.key,
      });
    }
    for (const routine of routines ?? []) {
      sources.push({
        id: routine.id,
        type: "routine",
        label: routine.title,
        description: routine.description ?? "Recurring workflow with safe trigger review on import.",
      });
    }
    return sources;
  }, [agents, routines, selectedCompany, skills]);

  const sharePreviewMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId || !shareSource) throw new Error("Select a source first.");
      return clipsApi.sharePreview(selectedCompanyId, {
        source: { type: shareSource.type, id: shareSource.id },
        title: shareDraft.title || undefined,
        summary: shareDraft.summary || undefined,
        slug: shareDraft.slug || undefined,
        visibility: shareDraft.visibility,
        revisionNote: shareDraft.revisionNote || null,
      });
    },
    onError: (error) => {
      pushToast({
        title: "Share preview failed",
        body: error instanceof Error ? error.message : "Paperclip could not build the clip preview.",
        tone: "error",
      });
    },
  });

  const publishMutation = useMutation({
    mutationFn: (preview: ClipSharePreviewResult) => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      return clipsApi.publish(selectedCompanyId, preview.publishRequest);
    },
    onSuccess: (result) => {
      pushToast({
        title: "Clip published",
        body: `${result.clip.title} is available as ${result.clip.visibility}.`,
        tone: "success",
      });
      setShareOpen(false);
      sharePreviewMutation.reset();
      void queryClient.invalidateQueries({ queryKey: queryKeys.clips.publicList({ limit: 18 }) });
    },
    onError: (error) => {
      pushToast({
        title: "Publish failed",
        body: error instanceof Error ? error.message : "Paperclip could not publish this clip.",
        tone: "error",
      });
    },
  });

  const importPreviewMutation = useMutation({
    mutationFn: (urlOverride?: string) => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      const url = (urlOverride ?? importUrl).trim();
      return clipsApi.importPreview(selectedCompanyId, {
        url,
        collisionStrategy: "rename",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Import preview failed",
        body: error instanceof Error ? error.message : "Paperclip could not resolve that clip.",
        tone: "error",
      });
    },
  });

  const importMutation = useMutation({
    mutationFn: () => {
      if (!selectedCompanyId) throw new Error("Select a company first.");
      return clipsApi.importClip(selectedCompanyId, {
        url: importUrl.trim(),
        collisionStrategy: "rename",
        selectedOptions: { routineTriggers: "review_required" },
      });
    },
    onSuccess: (result) => {
      pushToast({
        title: "Clip imported",
        body: `${result.clip.title} was imported with routine triggers still review-gated.`,
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Import failed",
        body: error instanceof Error ? error.message : "Paperclip could not import this clip.",
        tone: "error",
      });
    },
  });

  function openShare(source: ShareSource) {
    setShareSource(source);
    setShareDraft({
      title: source.label,
      summary: source.description.slice(0, 240) || `Portable ${source.type} shared from Paperclip.`,
      slug: source.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80),
      visibility: "unlisted",
      revisionNote: "Initial app share.",
    });
    sharePreviewMutation.reset();
    publishMutation.reset();
    setShareOpen(true);
  }

  const activePreview = importPreviewMutation.data;
  const importAgentPlans = getPreviewArray(activePreview?.preview, "agentPlans");
  const importProjectPlans = getPreviewArray(activePreview?.preview, "projectPlans");
  const importIssuePlans = getPreviewArray(activePreview?.preview, "issuePlans");

  if (!selectedCompanyId) {
    return <EmptyState icon={Package} message="Select a company to browse and import clips." />;
  }

  if (clipsLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Clips</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Publish reusable teams, agents, skills, and routines, or import a clip after a safety preview.
          </p>
        </div>
        <Button onClick={() => shareSources[0] && openShare(shareSources[0])} disabled={shareSources.length === 0}>
          <Upload className="mr-2 h-4 w-4" />
          Share
        </Button>
      </div>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Download className="h-4 w-4 text-muted-foreground" />
            Import from URL
          </div>
          <div className="rounded-md border border-border bg-card p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={importUrl}
                onChange={(event) => setImportUrl(event.target.value)}
                placeholder="https://paperclip.ing/clips/support-triage or support-triage"
              />
              <Button
                variant="outline"
                onClick={() => importPreviewMutation.mutate(undefined)}
                disabled={!importUrl.trim() || importPreviewMutation.isPending}
              >
                <FileSearch className="mr-2 h-4 w-4" />
                Dry Run
              </Button>
            </div>
            {activePreview ? (
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-medium">{activePreview.clip.title}</div>
                    <div className="mt-1 break-all text-xs text-muted-foreground">
                      {clipRevisionLabel(activePreview.clip)} · {activePreview.source.manifestChecksum}
                    </div>
                  </div>
                  <PlanRows title="Creates and updates" rows={[...importAgentPlans, ...importProjectPlans, ...importIssuePlans]} />
                  {(asPreviewRecord(activePreview.preview).warnings as string[] | undefined)?.length ? (
                    <WarningList warnings={asPreviewRecord(activePreview.preview).warnings as string[]} />
                  ) : null}
                </div>
                <SafetyPanel preview={activePreview} />
                <div className="xl:col-span-2 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-muted-foreground">
                    Import is blocked if preview errors exist. Recurring and webhook triggers stay disabled until reviewed.
                  </div>
                  <Button
                    onClick={() => importMutation.mutate()}
                    disabled={importMutation.isPending || ((asPreviewRecord(activePreview.preview).errors as unknown[] | undefined)?.length ?? 0) > 0}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    Import Clip
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            Share from app
          </div>
          <div className="rounded-md border border-border bg-card">
            {shareSources.slice(0, 6).map((source) => (
              <button
                key={`${source.type}:${source.id}`}
                className="flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-accent/40"
                onClick={() => openShare(source)}
              >
                <SourceIcon type={source.type} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{source.label}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{source.description}</span>
                </span>
                <Copy className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          Public catalog
        </div>
        {publicClips && publicClips.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {publicClips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} onImport={() => {
                setImportUrl(clip.slug);
                importPreviewMutation.mutate(clip.slug);
              }} />
            ))}
          </div>
        ) : (
          <EmptyState icon={Package} message="No public clips are available yet. Publish an unlisted clip from this app to start." />
        )}
      </section>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Share clip</DialogTitle>
            <DialogDescription>
              Review dependencies, redaction, visibility, and the public preview before publishing.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
            <div className="space-y-3">
              <LabeledInput label="Title" value={shareDraft.title} onChange={(value) => setShareDraft((prev) => ({ ...prev, title: value }))} />
              <LabeledInput label="Slug" value={shareDraft.slug} onChange={(value) => setShareDraft((prev) => ({ ...prev, slug: value }))} />
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Summary</span>
                <Textarea value={shareDraft.summary} onChange={(event) => setShareDraft((prev) => ({ ...prev, summary: event.target.value }))} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Revision note</span>
                <Textarea value={shareDraft.revisionNote} onChange={(event) => setShareDraft((prev) => ({ ...prev, revisionNote: event.target.value }))} />
              </label>
            </div>
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Visibility</span>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={shareDraft.visibility}
                  onChange={(event) => setShareDraft((prev) => ({ ...prev, visibility: event.target.value as ClipVisibility }))}
                >
                  {Object.entries(visibilityLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => sharePreviewMutation.mutate()}
                disabled={sharePreviewMutation.isPending || !shareSource}
              >
                <FileSearch className="mr-2 h-4 w-4" />
                Build Preview
              </Button>
              {sharePreviewMutation.data ? <ShareReview preview={sharePreviewMutation.data} /> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShareOpen(false)}>Cancel</Button>
            <Button
              onClick={() => sharePreviewMutation.data && publishMutation.mutate(sharePreviewMutation.data)}
              disabled={!sharePreviewMutation.data || publishMutation.isPending}
            >
              <Upload className="mr-2 h-4 w-4" />
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SourceIcon({ type }: { type: ClipType }) {
  const className = "mt-0.5 h-4 w-4 shrink-0 text-muted-foreground";
  if (type === "routine") return <Repeat className={className} />;
  if (type === "skill") return <Sparkles className={className} />;
  if (type === "agent" || type === "team") return <Package className={className} />;
  return <ClipboardCheck className={className} />;
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ShareReview({ preview }: { preview: ClipSharePreviewResult }) {
  return (
    <div className="space-y-3 rounded-md border border-border px-3 py-3 text-sm">
      <div>
        <div className="font-medium">{preview.source.label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{preview.source.type} · immutable revision</div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Metric label="Dependencies" value={preview.dependencyCounts.adapters + preview.dependencyCounts.skills + preview.dependencyCounts.permissions} />
        <Metric label="Redactions" value={preview.redactionSummary.redacted + preview.redactionSummary.omitted} />
      </div>
      {preview.dangerousCapabilities.length > 0 ? (
        <div className="flex gap-2 text-xs text-amber-600">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{preview.dangerousCapabilities.join(", ")}</span>
        </div>
      ) : (
        <div className="flex gap-2 text-xs text-muted-foreground">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>No dangerous capabilities detected in the manifest preview.</span>
        </div>
      )}
      {preview.warnings.length > 0 ? <WarningList warnings={preview.warnings.slice(0, 3)} /> : null}
    </div>
  );
}

function SafetyPanel({ preview }: { preview: { safety: { dangerousCapabilities: string[]; requiredSecrets: string[]; permissions: string[]; routineTriggersEnabledByDefault: boolean; webhookSecretsRegenerated: boolean } } }) {
  return (
    <div className="rounded-md border border-border px-3 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        Safety review
      </div>
      <div className="mt-3 space-y-2 text-xs">
        <SafetyRow label="Secrets" value={preview.safety.requiredSecrets.length ? preview.safety.requiredSecrets.join(", ") : "none required"} warn={preview.safety.requiredSecrets.length > 0} />
        <SafetyRow label="Permissions" value={preview.safety.permissions.length ? preview.safety.permissions.join(", ") : "none requested"} warn={preview.safety.permissions.length > 0} />
        <SafetyRow label="Dangerous" value={preview.safety.dangerousCapabilities.length ? preview.safety.dangerousCapabilities.join(", ") : "none detected"} warn={preview.safety.dangerousCapabilities.length > 0} />
        <SafetyRow label="Routines" value={preview.safety.routineTriggersEnabledByDefault ? "triggers would enable" : "triggers disabled for review"} warn={preview.safety.routineTriggersEnabledByDefault} />
        <SafetyRow label="Webhooks" value={preview.safety.webhookSecretsRegenerated ? "secrets regenerated" : "manual review required"} warn={!preview.safety.webhookSecretsRegenerated} />
      </div>
    </div>
  );
}

function SafetyRow({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("min-w-0", warn ? "text-amber-600" : "text-foreground")}>{value}</span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <div className="font-medium tabular-nums">{value}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}

function PlanRows({ title, rows }: { title: string; rows: Record<string, unknown>[] }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {rows.length > 0 ? (
        <div className="rounded-md border border-border">
          {rows.slice(0, 8).map((row, index) => (
            <div key={`${String(row.slug ?? index)}:${index}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0">
              <span className="text-xs uppercase text-muted-foreground">{String(row.action ?? "create")}</span>
              <span className="truncate">{String(row.plannedName ?? row.plannedTitle ?? row.slug ?? "Imported object")}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          No creates or updates in this preview.
        </div>
      )}
    </div>
  );
}

function WarningList({ warnings }: { warnings: string[] }) {
  return (
    <div className="space-y-1.5">
      {warnings.map((warning, index) => (
        <div key={`${warning}:${index}`} className="flex gap-2 text-xs text-amber-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}
    </div>
  );
}

function ClipCard({ clip, onImport }: { clip: PublicClip; onImport: () => void }) {
  return (
    <div className="flex min-h-[12rem] flex-col rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{clip.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {clip.type} · @{clip.creator.handle} · {clipRevisionLabel(clip)}
          </div>
        </div>
        <span className={cn("text-xs", safetyTone(clip))}>{clip.moderationState}</span>
      </div>
      <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">{clip.summary}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
        <Metric label="imports" value={clip.metrics.importCount} />
        <Metric label="votes" value={clip.metrics.voteScore} />
        <Metric label="proof" value={clip.metrics.successfulFirstRunCount} />
      </div>
      <div className="mt-auto flex items-center justify-between pt-4">
        <span className="text-xs text-muted-foreground">
          {formatCount(clip.dependencies?.length ?? 0, "dependency", "dependencies")}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onImport}>
            <FileSearch className="mr-1.5 h-3.5 w-3.5" />
            Preview
          </Button>
          <Button asChild size="sm" variant="ghost">
            <a href={`/api/public/clips/${encodeURIComponent(clip.slug)}/manifest`} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
