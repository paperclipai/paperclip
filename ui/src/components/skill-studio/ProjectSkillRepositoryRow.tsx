import type { ProjectSkillRepository } from '@paperclipai/shared';
import { GithubIcon } from '@/components/icons/github-icon';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';

export function ProjectSkillRepositoryRow({ repository, pending, onImport }: {
  repository: ProjectSkillRepository;
  pending?: boolean;
  onImport: () => void;
}) {
  const importing = pending || repository.status === 'pending';
  return <section className="flex flex-col gap-2 py-3" aria-label={`Skills from ${repository.projectName}`}>
    <div className="flex items-center gap-3">
      <GithubIcon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <a href={repository.repositoryUrl} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
          {repository.repositoryUrl.replace('https://github.com/', '')}
        </a>
        <p className="truncate text-xs text-muted-foreground">{repository.projectName} · {repository.trackingRef === 'HEAD' ? 'Default branch' : repository.trackingRef}{repository.projectVisibility === 'private' ? ' · Project access' : ''}</p>
      </div>
      <Button size="sm" variant="outline" disabled={importing} onClick={onImport}>
        {importing ? 'Importing…' : repository.status === 'error' ? 'Retry import' : 'Import skills'}
      </Button>
    </div>
    {repository.lastError && <p role="alert" className="text-sm text-destructive">{repository.lastError} <Link to="/apps" className="underline">Manage GitHub connection</Link></p>}
  </section>;
}
