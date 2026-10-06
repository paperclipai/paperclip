import { t, useTranslation } from "@/i18n";
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
  useTranslation();
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
        <DialogDescription className="break-all font-mono text-xs">{root || t("oct5Core.s0373")}/ · {(inspection?.files.length ?? skill.fileCount) == null ? t("oct5Core.filesUnknown") : t("oct5Core.files", { count: inspection?.files.length ?? skill.fileCount })}{commitSha ? ` · ${commitSha.slice(0, 8)}` : ''}</DialogDescription>
      </DialogHeader>
      {!inspection && <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0374")}</p>}
      {skill.error && <p role="alert" className="text-sm text-destructive">{skill.error}</p>}
      {inspection?.requirements && <section className="rounded-md border border-border bg-muted/30 p-3 text-sm">
        <h3 className="font-medium">{t("oct5Core.s0375")}</h3>
        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{inspection.requirements}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t("oct5Core.s0376")}</p>
      </section>}
      {Boolean(inspection?.references.length) && <section className="rounded-md border border-border p-3 text-sm" aria-label={t("oct5Core.s0377")}>
        <h3 className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" />{t("oct5Core.s0378")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("oct5Core.s0379")}</p>
        <ul className="mt-2 space-y-2">
          {inspection!.references.map(reference => <li key={`${reference.fromPath}:${reference.resolvedPath}`} className="break-all text-xs">
            <span className="font-mono">{reference.target}</span> · {reference.kind === 'outside_package' ? t("oct5Core.s0380") : t("oct5Core.s0381")}
            <span className="text-muted-foreground"> {t("oct5Core.s0382")} {reference.fromPath}</span>
          </li>)}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">{t("oct5Core.s0383")}</p>
      </section>}
      {Boolean(inspection?.warnings.length) && <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("oct6Beta.auditNotices", { count: inspection!.warnings.length })}</summary>
        <ul className="mt-2 space-y-1">{inspection!.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
      </details>}
      {inspection && <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border md:flex-row">
        <div className="max-h-48 shrink-0 overflow-auto border-b border-border py-1 md:max-h-(--sz-480px) md:w-56 md:border-b-0 md:border-r">
          <FileTree nodes={nodes} selectedFile={filePath} expandedDirs={expanded} showCheckboxes={false} wrapLabels={false}
            ariaLabel={t("oct6Beta.includedFiles")} onSelectFile={setFilePath} onToggleDir={path => setCollapsed(previous => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; })} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="break-all font-mono">{filePath}</span>
            {file && <span className="text-muted-foreground">{file.sizeBytes.toLocaleString()} {t("oct5Core.s0385")}{file.executable ? t("oct6Beta.executableSuffix") : ''}</span>}
          </div>
          <div className="max-h-(--sz-480px) min-h-40 overflow-auto p-3">
            {preview.isFetching && <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0212")}</p>}
            {preview.error && <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">{preview.error.message}</p><Button variant="outline" size="sm" onClick={() => void preview.refetch()}>{t("oct5Core.s0057")}</Button> <Link to="/apps" className="underline">{t("oct5Core.s0386")}</Link></div>}
            {skill.error && <p className="text-sm text-muted-foreground">{t("oct5Core.s0387")}</p>}
            {preview.data?.file.encoding === 'base64' && <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground"><FileImage className="size-6" /><p>{t("oct5Core.s0388")}</p><p className="text-xs">{t("oct5Core.s0389")}</p></div>}
            {preview.data?.content !== null && preview.data?.content !== undefined && <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{preview.data.content}</pre>}
            {preview.data?.truncated && <p className="mt-3 text-xs text-muted-foreground">{t("oct5Core.s0390")}</p>}
          </div>
        </div>
      </div>}
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="outline" onClick={onClose}>{t("oct5Core.s0141")}</Button><Button asChild variant="ghost" size="sm"><a href={githubUrl} target="_blank" rel="noreferrer">{t("oct5Core.s0391")}<ExternalLink className="size-3.5" /></a></Button></div>
    </DialogContent>
  </Dialog>;
}
