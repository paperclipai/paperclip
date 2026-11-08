import { t as translateShell, useTranslation } from "@/i18n";
import type { ProjectSkillRepository } from '@paperclipai/shared';
import { GithubIcon } from '@/components/icons/github-icon';
import { Button } from '@/components/ui/button';
import { LoaderCircle } from 'lucide-react';

export function ProjectSkillRepositoryRow({ repository, pending, backgroundPending, disabled, onImport }: {
  repository: ProjectSkillRepository;
  pending?: boolean;
  backgroundPending?: boolean;
  disabled?: boolean;
  onImport: () => void;
}) {
  const { t: translateShell } = useTranslation("shell");
  const actionPending = pending || repository.status === 'pending';
  const importing = actionPending || backgroundPending;
  return <section className="flex flex-col gap-2 py-3" aria-label={translateShell("shell:skills_from", { value1: repository.projectName })} aria-busy={Boolean(importing)}>
    <div className="flex items-center gap-3">
      <GithubIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <a href={repository.repositoryUrl} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
          {repository.repositoryUrl.replace('https://github.com/', '')}
        </a>
        <p className="truncate text-xs text-muted-foreground">{repository.projectName} · {repository.trackingRef === 'HEAD' ? translateShell("shell:default_branch") : repository.trackingRef}{repository.projectVisibility === 'private' ? translateShell("shell:project_access") : ''}</p>
      </div>
      <Button size="sm" variant="outline" disabled={actionPending || disabled} onClick={onImport}>
        {importing && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {actionPending ? translateShell("shell:importing") : repository.status === 'error' ? translateShell("shell:retry_import") : backgroundPending ? translateShell("shell:import_remaining_skills") : translateShell("shell:import_skills")}
      </Button>
    </div>
    {importing && <p role="status" className="ml-8 text-xs text-muted-foreground">{pending ? translateShell("shell:starting_import") : repository.importState === 'importing'
      ? translateShell("shell:checking_repository_for_skills_this_can_take") : translateShell("shell:import_queued_skills_will_appear_here_when")}</p>}
    {repository.lastError && <p role="alert" className="text-sm text-destructive">{repository.lastError}</p>}
  </section>;
}
