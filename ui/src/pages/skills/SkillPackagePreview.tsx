import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileImage, AlertTriangle } from 'lucide-react';
import type { SkillSourceDiscoveryRequest, SkillPackageReference } from '@paperclipai/shared';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { queryKeys } from '@/lib/queryKeys';
import { FileTree, buildFileTree, collectAllPaths } from '@/components/FileTree';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';
import type { SkillTreeCandidate } from './SkillSourceTree';

function scanLimitDetails(error: Error) {
  if (!(error instanceof ApiError) || error.status !== 429) return null;
  const details = (error.body as { details?: Record<string, unknown> } | null)?.details;
  return details?.code === 'skill_source_scan_limited' ? details : null;
}

export function SkillReferenceChoices({ references, included, onChange }: {
  references: SkillPackageReference[]; included: string[]; onChange?: (paths: string[]) => void;
}) {
  const choices: SkillPackageReference[] = [...references, ...included.filter(path => !references.some(reference => reference.resolvedPath === path)).map(path => ({
    target: path, resolvedPath: path, fromPath: '', kind: 'missing' as const,
  }))];
  return <section className="rounded-md border border-border p-3 text-sm" aria-label="Package references">
    <h3 className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />Referenced files</h3>
    <p className="mt-1 text-xs text-muted-foreground">Include referenced skills and support files with this skill.</p>
    <ul className="mt-2 space-y-2">
      {choices.map(reference => <li key={`${reference.fromPath}:${reference.resolvedPath}`} className="break-all text-xs">
        {(reference.import || included.includes(reference.resolvedPath)) && onChange ? <label className="flex cursor-pointer items-start gap-2">
          <input type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-foreground" aria-label={`Include ${reference.target}`}
            checked={included.includes(reference.resolvedPath)} onChange={event => onChange(event.target.checked ? [...new Set([...included, reference.resolvedPath])] : included.filter(value => value !== reference.resolvedPath))} />
          <span><span className="font-mono">{reference.target}</span><span className="block text-muted-foreground">{reference.import ? <>{reference.import.kind === 'skill' ? 'Whole skill' : reference.import.kind === 'folder' ? 'Whole folder' : 'File'} · <span className="font-mono">{reference.import.path}</span> · {reference.import.fileCount} {reference.import.fileCount === 1 ? 'file' : 'files'}</> : 'No longer available · uncheck to remove'}</span></span>
        </label> : <><span className="font-mono">{reference.target}</span> · {included.includes(reference.resolvedPath) ? 'Included' : reference.kind === 'missing' ? 'Not found' : 'Unavailable in this repository'}</>}
        {reference.fromPath && <span className="block text-muted-foreground">Referenced in {reference.fromPath}</span>}
      </li>)}
    </ul>
  </section>;
}

export function SkillPackagePreview({ companyId, repository, commitSha, skill, initialFile, includedReferences, onReferencesChange, onClose }: {
  companyId: string; repository: SkillSourceDiscoveryRequest; commitSha: string | null;
  skill: SkillTreeCandidate; initialFile?: string; onClose: () => void;
  includedReferences?: string[]; onReferencesChange?: (paths: string[]) => void;
}) {
  const included = includedReferences ?? skill.inspection?.includedReferences ?? [];
  const saved = skill.inspection?.includedReferences ?? [];
  const referencesChanged = included.length !== saved.length || included.some(path => !saved.includes(path));
  const [filePath, setFilePath] = useState(initialFile ?? 'SKILL.md');
  const preview = useQuery({
    queryKey: [...queryKeys.skillSources.preview(companyId, repository.repositoryUrl, repository.connectionId ?? null, commitSha, skill.path, filePath), ...included],
    queryFn: ({ signal }) => skillSourcesApi.preview(companyId, { ...repository, commitSha: commitSha!, skillPath: skill.path, filePath, includedReferences: included }, signal),
    enabled: Boolean(commitSha && skill.inspection && (!skill.error || referencesChanged)),
    retry: (count, error) => count < 2 && Boolean(scanLimitDetails(error)),
    retryDelay: (_count, error) => Math.min(60, Math.max(1, Number(scanLimitDetails(error)?.retryAfterSeconds) || 5)) * 1000,
    staleTime: 5 * 60_000, refetchOnWindowFocus: false,
  });
  const inspection = preview.data?.inspection ?? skill.inspection;
  const packageError = preview.data ? null : skill.error;
  const nodes = buildFileTree(Object.fromEntries((inspection?.files ?? []).map(file => [file.path, null]))).sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md'));
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const expanded = new Set([...collectAllPaths(nodes, 'dir')].filter(path => !collapsed.has(path)));
  const file = inspection?.files.find(file => file.path === filePath);
  const root = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/')) : '';
  const githubPath = file?.repositoryPath ?? (filePath === 'SKILL.md' ? skill.path : [root, filePath].filter(Boolean).join('/'));
  const githubUrl = commitSha ? `${repository.repositoryUrl}/blob/${commitSha}/${githubPath.split('/').map(encodeURIComponent).join('/')}` : repository.repositoryUrl;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-(--sz-calc-18) flex-col overflow-y-auto p-4 sm:max-w-4xl sm:p-6">
      <DialogHeader>
        <DialogTitle>{skill.name}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">{root || 'Repository root'}/ · {inspection?.files.length ?? skill.fileCount ?? '?'} files{commitSha ? ` · ${commitSha.slice(0, 8)}` : ''}</DialogDescription>
      </DialogHeader>
      {!inspection && <p role="status" className="text-sm text-muted-foreground">Refresh this source to inspect its complete package contents.</p>}
      {packageError && <p role="alert" className="text-sm text-destructive">{packageError}</p>}
      {inspection?.requirements && <section className="rounded-md border border-border bg-muted/30 p-3 text-sm">
        <h3 className="font-medium">Runtime requirements</h3>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{inspection.requirements}</p>
        <p className="mt-2 text-xs text-muted-foreground">Declared by the skill author. Importing does not install dependencies or run scripts.</p>
      </section>}
      {Boolean(inspection?.references.length || included.length) && <SkillReferenceChoices references={inspection?.references ?? []} included={included}
        onChange={onReferencesChange ? paths => { setFilePath('SKILL.md'); onReferencesChange(paths); } : undefined} />}
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
            {packageError && <p className="text-sm text-muted-foreground">Preview unavailable for a package that failed validation.</p>}
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
