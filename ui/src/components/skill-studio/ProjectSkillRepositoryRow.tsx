import type { ProjectSkillRepository } from '@paperclipai/shared';
import { GithubIcon } from '@/components/icons/github-icon';
import { Button } from '@/components/ui/button';
import { GitBranch, LoaderCircle } from 'lucide-react';
import { Link } from '@/lib/router';

const missingAzureAuthorization = 'Authorize this project’s Azure DevOps connection to import its skills.';

export function ProjectSkillImportError({ message, workspaces }: { message: string; workspaces: ProjectSkillRepository[] }) {
  const projects = [...new Map(workspaces.filter(workspace => workspace.lastError === missingAzureAuthorization)
    .map(workspace => [workspace.projectId, workspace.projectName])).entries()];
  if (message !== missingAzureAuthorization || !projects.length) return <p role="alert" className="text-sm text-destructive">{message}</p>;
  return <div role="alert" className="flex flex-col gap-2 text-sm text-destructive">
    <p>Skill import needs a project Azure DevOps authorization. In project configuration, under Azure DevOps organization access, select a connection and choose Save authorization. Then retry the import.</p>
    <div className="flex flex-wrap gap-3">{projects.map(([id, name]) => <Link key={id} to={`/projects/${id}/configuration`} className="font-medium underline underline-offset-2">Configure {name}</Link>)}</div>
  </div>;
}

export function ProjectSkillRepositoryRow({ repository, workspaces, pending, backgroundPending, disabled, onImport }: {
  repository: ProjectSkillRepository;
  workspaces: ProjectSkillRepository[];
  pending?: boolean;
  backgroundPending?: boolean;
  disabled?: boolean;
  onImport: () => void;
}) {
  const actionPending = pending || repository.status === 'pending';
  const importing = actionPending || backgroundPending;
  const azure = repository.repositoryUrl.startsWith('https://dev.azure.com/');
  return <section className="flex flex-col gap-2 py-3" aria-label={`Skills from ${repository.projectName}`} aria-busy={Boolean(importing)}>
    <div className="flex items-center gap-3">
      {azure ? <GitBranch className="size-5 shrink-0 text-muted-foreground" aria-label="Azure DevOps" /> : <GithubIcon className="size-5 shrink-0 text-muted-foreground" />}
      <div className="min-w-0 flex-1">
        <a href={repository.repositoryUrl} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium hover:underline">
          {repository.repositoryUrl.replace('https://github.com/', '')}
        </a>
        <p className="truncate text-xs text-muted-foreground">{azure ? 'Azure DevOps · ' : ''}{repository.projectName} · {repository.trackingRef === 'HEAD' ? 'Default branch' : repository.trackingRef}{repository.projectVisibility === 'private' ? ' · Project access' : ''}</p>
      </div>
      <Button size="sm" variant="outline" disabled={actionPending || disabled} onClick={onImport}>
        {importing && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />}
        {actionPending ? 'Importing…' : repository.status === 'error' ? 'Retry import' : backgroundPending ? 'Import remaining skills' : 'Import skills'}
      </Button>
    </div>
    {importing && <p role="status" className="ml-8 text-xs text-muted-foreground">{pending ? 'Starting import…' : repository.importState === 'importing'
      ? 'Checking repository for skills… This can take a few minutes for large repositories.' : 'Import queued. Skills will appear here when ready.'}</p>}
    {repository.lastError && <ProjectSkillImportError message={repository.lastError} workspaces={workspaces} />}
  </section>;
}
