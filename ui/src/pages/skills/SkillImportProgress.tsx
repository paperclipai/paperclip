import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
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
  const { t: translateAgentPage } = useTranslation("agents");
  const phase = progress?.phase ?? 'connecting';
  const step = phase === 'connecting' || phase === 'downloading' ? 0 : phase === 'listing' ? 1 : 2;
  const download = phase === 'downloading' ? progress?.download : undefined;
  const total = progress?.totalSkills;
  const checking = !importing && phase === 'checking' && total != null;
  const title = importing ? translateAgentPage("agents:importing_fdc431_count", { value1: count, count: count })
    : checking ? translateAgentPage("agents:found_count", { value1: total, count: total })
    : phase === 'downloading' ? download?.stage === 'resolving' ? translateAgentPage("agents:preparing_repository") : translateAgentPage("agents:downloading_repository")
    : phase === 'listing' ? translateAgentPage("agents:finding_skills") : translateAgentPage("agents:opening_repository");
  const detail = importing ? translateAgentPage("agents:checking_package_files_and_saving_local_copies")
    : checking ? translateAgentPage("agents:of_checked", { value1: progress?.checkedSkills ?? 0, value2: total })
    : phase === 'downloading' ? download ? (download.stage === 'resolving' ? finalPagesT("final-pages:percent_prepared_bytes_be170d", { percent: download.percent, bytes: download.receivedBytes ? ` · ${formatBytes(download.receivedBytes)}` : '' }) : finalPagesT("final-pages:percent_received_bytes_bef0f9", { percent: download.percent, bytes: download.receivedBytes ? ` · ${formatBytes(download.receivedBytes)}` : '' })) : translateAgentPage("agents:receiving_the_repository_from_github")
    : phase === 'listing' ? translateAgentPage("agents:searching_every_folder_for_skill_md") : translateAgentPage("agents:connecting_to_github_and_resolving_the_branch");
  const recent = found.slice(-5);
  return <section className="skill-import-enter flex min-w-0 flex-col gap-5" aria-label={importing ? translateAgentPage("agents:import_progress") : translateAgentPage("agents:repository_scan_progress")}>
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
      {!importing && download ? <progress className="skill-import-progress h-1 w-full" value={download.percent} max={100} aria-label={download.stage === 'resolving' ? translateAgentPage("agents:preparing_repository") : translateAgentPage("agents:repository_download")} /> : checking && total > 0
        ? <progress className="skill-import-progress h-1 w-full" value={progress?.checkedSkills ?? 0} max={total} aria-label={translateAgentPage("agents:skills_checked")} />
        : <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={importing ? translateAgentPage("agents:saving_skill_snapshots") : translateAgentPage("agents:scanning_repository")}><div className="skill-import-sweep h-full rounded-full bg-foreground/30" /></div>}
      {!importing && <ol className="flex items-center justify-between gap-2 text-xs text-muted-foreground" aria-label={translateAgentPage("agents:scan_stages")}>
        {[translateAgentPage("agents:download"), translateAgentPage("agents:find_skills"), translateAgentPage("agents:check_files")].map((label, index) => <li key={label} className={`flex items-center gap-1.5 ${index === step ? 'text-foreground' : ''}`} aria-current={index === step ? 'step' : undefined}>
          {index < step ? <Check className="size-3" aria-hidden /> : <span className={`size-1.5 rounded-full ${index === step ? 'bg-foreground motion-safe:animate-pulse' : 'bg-muted-foreground/40'}`} />}{label}
        </li>)}
      </ol>}
    </div>
    <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>{importing ? translateAgentPage("agents:selected_skills") : translateAgentPage("agents:recently_checked")}</span>
        {recent.length > 0 && <span className="tabular-nums">{importing ? translateAgentPage("agents:selected_deace8", { value1: count }) : translateAgentPage("agents:checked", { value1: progress?.checkedSkills ?? found.length })}</span>}
      </div>
      {recent.length > 0 ? <ul className="divide-y divide-border" aria-label={importing ? translateAgentPage("agents:skills_being_imported") : translateAgentPage("agents:skills_checked_so_far")}>
        {recent.map(skill => <li key={skill.path} className="skill-import-enter flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          {skill.error ? <AlertCircle className="size-4 shrink-0 text-destructive" aria-label={translateAgentPage("agents:validation_issue")} />
            : importing ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2"><span className="truncate text-sm font-medium">{skill.name}</span><span className="shrink-0 text-xs text-muted-foreground">{translateAgentPage("agents:count_file", { count: skill.fileCount })}</span></div>
            <p className={`truncate text-xs ${skill.error ? 'text-destructive' : 'text-muted-foreground'}`} title={skill.error ?? skill.path}>{skill.error ?? skill.path}</p>
          </div>
        </li>)}
      </ul> : <div className="flex flex-col gap-3 px-3 py-4" aria-hidden="true">
        {["w-2/3", "w-1/2", "w-3/4"].map(width => <div key={width} className="flex items-center gap-3 motion-safe:animate-pulse"><FileText className="size-4 text-muted-foreground/40" /><span className={`${width} h-2 rounded-full bg-muted`} /></div>)}
      </div>}
      <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 shrink-0 motion-safe:animate-spin" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={progress?.currentPath ?? undefined}>{importing ? translateAgentPage("agents:saving_complete_packages_including_scripts_and_references") : progress?.currentPath ?? translateAgentPage("agents:waiting_for_repository_contents")}</span>
        {checking && progress?.totalFiles != null && <span className="shrink-0 tabular-nums">{progress.checkedFiles}/{progress.totalFiles}{" "}{translateAgentPage("agents:files_a1f13b")}</span>}
      </div>
    </div>
    <p className="text-xs text-muted-foreground">{importing ? translateAgentPage("agents:this_may_take_a_moment_for_larger_packages") : translateAgentPage("agents:you_ll_choose_what_to_import_after_every")}</p>
  </section>;
}
