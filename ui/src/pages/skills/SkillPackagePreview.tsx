import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileImage, AlertTriangle } from 'lucide-react';
import type { SkillSourceDiscoveryRequest } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { queryKeys } from '@/lib/queryKeys';
import { FileTree, buildFileTree, collectAllPaths } from '@/components/FileTree';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';
import type { SkillTreeCandidate } from './SkillSourceTree';

export function SkillPackagePreview({ companyId, repository, commitSha, skill, initialFile, onClose }: {
  companyId: string; repository: SkillSourceDiscoveryRequest; commitSha: string | null;
  skill: SkillTreeCandidate; initialFile?: string; onClose: () => void;
}) {
  const inspection = skill.inspection;
  const [filePath, setFilePath] = useState(initialFile ?? 'SKILL.md');
  const nodes = buildFileTree(Object.fromEntries((inspection?.files ?? []).map(file => [file.path, null]))).sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md'));
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const expanded = new Set([...collectAllPaths(nodes, 'dir')].filter(path => !collapsed.has(path)));
  const file = inspection?.files.find(file => file.path === filePath);
  const preview = useQuery({
    queryKey: queryKeys.skillSources.preview(companyId, repository.repositoryUrl, repository.connectionId ?? null, commitSha, skill.path, filePath),
    queryFn: () => skillSourcesApi.preview(companyId, { ...repository, commitSha: commitSha!, skillPath: skill.path, filePath }),
    enabled: Boolean(commitSha && file && !skill.error), retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false,
  });
  const root = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/')) : '';
  const githubPath = filePath === 'SKILL.md' ? skill.path : [root, filePath].filter(Boolean).join('/');
  const githubUrl = commitSha ? `${repository.repositoryUrl}/blob/${commitSha}/${githubPath.split('/').map(encodeURIComponent).join('/')}` : repository.repositoryUrl;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-y-auto p-4 sm:max-w-4xl sm:p-6">
      <DialogHeader>
        <DialogTitle>{skill.name}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">{root || 'Repository root'}/ · {inspection?.files.length ?? skill.fileCount ?? '?'} files{commitSha ? ` · ${commitSha.slice(0, 8)}` : ''}</DialogDescription>
      </DialogHeader>
      {!inspection && <p role="status" className="text-sm text-muted-foreground">Refresh this source to inspect its complete package contents.</p>}
      {skill.error && <p role="alert" className="text-sm text-destructive">{skill.error}</p>}
      {inspection?.requirements && <section className="rounded-md border border-border bg-muted/30 p-3 text-sm">
        <h3 className="font-medium">Runtime requirements</h3>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{inspection.requirements}</p>
        <p className="mt-2 text-xs text-muted-foreground">Declared by the skill author. Importing does not install dependencies or run scripts.</p>
      </section>}
      {Boolean(inspection?.references.length) && <section className="rounded-md border border-border p-3 text-sm" aria-label="Package reference warnings">
        <h3 className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />Check references</h3>
        <p className="mt-1 text-xs text-muted-foreground">These referenced paths are not included. If the skill needs them, fix the source or leave this skill unchecked.</p>
        <ul className="mt-2 space-y-2">
          {inspection!.references.map(reference => <li key={`${reference.fromPath}:${reference.resolvedPath}`} className="break-all text-xs">
            <span className="font-mono">{reference.target}</span> · {reference.kind === 'outside_package' ? 'Outside this package' : 'Not found'}
            <span className="text-muted-foreground"> · referenced in {reference.fromPath}</span>
          </li>)}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Checks cover Markdown links and explicit relative resource paths. They cannot establish every runtime dependency.</p>
      </section>}
      {Boolean(inspection?.warnings.length) && <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Content audit · {inspection!.warnings.length} {inspection!.warnings.length === 1 ? 'notice' : 'notices'}</summary>
        <ul className="mt-2 space-y-1">{inspection!.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </details>}
      {inspection && <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border md:flex-row">
        <div className="max-h-48 shrink-0 overflow-auto border-b border-border py-1 md:max-h-(--sz-480px) md:w-56 md:border-b-0 md:border-r">
          <FileTree nodes={nodes} selectedFile={filePath} expandedDirs={expanded} showCheckboxes={false} wrapLabels={false}
            ariaLabel="Included package files" onSelectFile={setFilePath} onToggleDir={path => setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="break-all font-mono">{filePath}</span>
            {file && <span className="text-muted-foreground">{file.sizeBytes.toLocaleString()} bytes{file.executable ? ' · executable' : ''}</span>}
          </div>
          <div className="max-h-(--sz-480px) min-h-40 overflow-auto p-3">
            {preview.isFetching && <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>}
            {preview.error && <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">{preview.error.message}</p><Button variant="outline" size="sm" onClick={() => void preview.refetch()}>Try again</Button> <Link to="/apps" className="underline">Manage GitHub access</Link></div>}
            {skill.error && <p className="text-sm text-muted-foreground">Preview unavailable for a package that failed validation.</p>}
            {preview.data?.file.encoding === 'base64' && <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground"><FileImage className="size-6" /><p>Binary asset · included without changes</p><p className="text-xs">Open on GitHub to preview or download this file.</p></div>}
            {preview.data?.content !== null && preview.data?.content !== undefined && <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{preview.data.content}</pre>}
            {preview.data?.truncated && <p className="mt-3 text-xs text-muted-foreground">Showing the first 64 KB. The complete file is imported.</p>}
          </div>
        </div>
      </div>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="outline" onClick={onClose}>Back to selection</Button><Button asChild variant="ghost" size="sm"><a href={githubUrl} target="_blank" rel="noreferrer">Open on GitHub<ExternalLink className="size-3.5" /></a></Button></div>
    </DialogContent>
  </Dialog>;
}
