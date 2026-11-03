import { t, useTranslation } from "@/i18n";
import { AlertCircle, Check, FileText, LoaderCircle } from 'lucide-react';
import type { SkillSourceCandidate, SkillSourceScanProgress } from '@paperclipai/shared';
import { formatBytes } from '@/lib/issue-output';
import { GithubIcon } from '@/components/icons/github-icon';

export type FoundSkill = Pick<SkillSourceCandidate, 'path' | 'name' | 'description' | 'fileCount' | 'error'>;
export function SkillImportProgress({ repository, progress, found = [], importing = false, count = 0 }: {
  repository: string;
  progress?: SkillSourceScanProgress | null;
  found?: FoundSkill[];
  importing?: boolean;
  count?: number;
}) {
  useTranslation();
  const phase = progress?.phase ?? 'connecting';
  const step = phase === 'connecting' || phase === 'downloading' ? 0 : phase === 'listing' ? 1 : 2;
  const download = phase === 'downloading' ? progress?.download : undefined;
  const total = progress?.totalSkills;
  const checking = !importing && phase === 'checking' && total != null;
  const title = importing ? t("oct5Core.importingSkills", { count })
    : checking ? t("oct5Core.foundSkills", { count: total })
    : phase === 'downloading' ? download?.stage === 'resolving' ? t("oct5Core.s0348") : t("oct5Core.s0349")
    : phase === 'listing' ? t("oct5Core.s0350") : t("oct5Core.s0351");
  const detail = importing ? t("oct5Core.s0352")
    : checking ? t("oct5Core.checkedOutOf", { count: progress?.checkedSkills ?? 0, total })
    : phase === 'downloading' ? download ? `${t(download.stage === "resolving" ? "oct5Core.percentPrepared" : "oct5Core.percentReceived", { percent: download.percent })}${download.receivedBytes ? ` · ${formatBytes(download.receivedBytes)}` : ""}` : t("oct5Core.s0353")
    : phase === 'listing' ? t("oct5Core.s0354") : t("oct5Core.s0355");
  const recent = found.slice(-5);
  return <section className="skill-import-enter flex min-w-0 flex-col gap-5" aria-label={importing ? t("oct5Core.s0356") : t("oct5Core.s0357")}>
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <GithubIcon className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={repository}>{repository}</span>
    </div>
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted"><LoaderCircle className="size-5 motion-safe:animate-spin text-muted-foreground" aria-hidden /></span>
        <div className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        </div>
      </div>
      {!importing && download ? <progress className="skill-import-progress h-1 w-full" value={download.percent} max={100} aria-label={download.stage === 'resolving' ? t("oct5Core.s0348") : t("oct5Core.s0358")} /> : checking && total > 0
        ? <progress className="skill-import-progress h-1 w-full" value={progress?.checkedSkills ?? 0} max={total} aria-label={t("oct5Core.s0359")} />
        : <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={importing ? t("oct5Core.s0360") : t("oct5Core.s0361")}><div className="skill-import-sweep h-full rounded-full bg-foreground/30" /></div>}
      {!importing && <ol className="flex items-center justify-between gap-2 text-xs text-muted-foreground" aria-label={t("oct5Core.s0362")}>
        {[t("oct5Core.s0096"), t("oct5Core.s0347"), t("oct5Core.s0363")].map((label, index) => <li key={index} className={`flex items-center gap-1.5 ${index === step ? 'text-foreground' : ''}`} aria-current={index === step ? 'step' : undefined}>
          {index < step ? <Check className="size-3" aria-hidden /> : <span className={`size-1.5 rounded-full ${index === step ? 'bg-foreground motion-safe:animate-pulse' : 'bg-muted-foreground/40'}`} />}{label}
        </li>)}
      </ol>}
    </div>
    <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>{importing ? t("oct5Core.s0364") : t("oct5Core.s0365")}</span>
        {recent.length > 0 && <span className="tabular-nums">{importing ? t("oct5Core.selectedCount", { count }) : t("oct5Core.checkedCount", { count: progress?.checkedSkills ?? found.length })}</span>}
      </div>
      {recent.length > 0 ? <ul className="divide-y divide-border" aria-label={importing ? t("oct5Core.s0366") : t("oct5Core.s0367")}>
        {recent.map(skill => <li key={skill.path} className="skill-import-enter flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          {skill.error ? <AlertCircle className="size-4 shrink-0 text-destructive" aria-label={t("oct5Core.s0368")} />
            : importing ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2"><span className="truncate text-sm font-medium">{skill.name}</span><span className="shrink-0 text-xs text-muted-foreground">{t("oct5Core.files", { count: skill.fileCount })}</span></div>
            <p className={`truncate text-xs ${skill.error ? 'text-destructive' : 'text-muted-foreground'}`} title={skill.error ?? skill.path}>{skill.error ?? skill.path}</p>
          </div>
        </li>)}
      </ul> : <div className="flex flex-col gap-3 px-3 py-4" aria-hidden="true">
        {["w-2/3", "w-1/2", "w-3/4"].map(width => <div key={width} className="flex items-center gap-3 motion-safe:animate-pulse"><FileText className="size-4 text-muted-foreground/40" /><span className={`${width} h-2 rounded-full bg-muted`} /></div>)}
      </div>}
      <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={progress?.currentPath ?? undefined}>{importing ? t("oct5Core.s0369") : progress?.currentPath ?? t("oct5Core.s0370")}</span>
        {checking && progress?.totalFiles != null && <span className="shrink-0 tabular-nums">{t("oct5Core.filesChecked", { checked: progress.checkedFiles, total: progress.totalFiles })}</span>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">{importing ? t("oct5Core.s0371") : t("oct5Core.s0372")}</p>
  </section>;
}
