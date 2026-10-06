import { t, useTranslation } from "@/i18n";
import { useMemo, useState } from 'react';
import type { SkillSourceCandidate } from '@paperclipai/shared';
import { FileTree, buildFileTree, collectAllPaths, type FileTreeNode } from '@/components/FileTree';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Search, Info, AlertTriangle } from 'lucide-react';

export type SkillTreeCandidate = Pick<SkillSourceCandidate, 'path' | 'name' | 'description' | 'error' | 'inspection'> & { note?: string; warnings?: string[]; fileCount?: number };
export function updateSkillTreeSelection(candidates: SkillTreeCandidate[], selected: Set<string>, folder: string, checked: boolean) {
  const result = new Set(selected);
  for (const skill of candidates.filter(skill => !folder || skill.path.startsWith(`${folder}/`))) {
    if (checked) result.add(skill.path); else result.delete(skill.path);
  }
  return result;
}

/** Package rows own only their manifest. Nested packages remain independently selectable. */
export function buildSkillPackageTree(candidates: SkillTreeCandidate[]) {
  const byPath = new Map(candidates.map(skill => [skill.path, skill]));
  const included = new Map<string, { skill: SkillTreeCandidate; filePath: string }>();
  function packageFiles(skill: SkillTreeCandidate): FileTreeNode[] {
    function prefix(nodes: FileTreeNode[]): FileTreeNode[] {
      return [...nodes].sort((a, b) => Number(b.name === 'SKILL.md') - Number(a.name === 'SKILL.md')).map(node => {
        const virtualPath = `${skill.path}/${node.path}`;
        included.set(virtualPath, { skill, filePath: node.path });
        return { ...node, path: virtualPath, children: prefix(node.children) };
      });
    }
    return prefix(buildFileTree(Object.fromEntries((skill.inspection?.files ?? []).map(file => [file.path, null]))));
  }
  function transform(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map(node => {
      if (node.kind === 'file') {
        const skill = byPath.get(node.path)!;
        return { ...node, name: skill.name, kind: 'dir' as const, children: packageFiles(skill) };
      }
      const children = transform(node.children);
      const entrypoint = node.children.find(child => child.kind === 'file' && byPath.has(child.path));
      // A folder containing nested packages remains a grouping folder, so a collapsed
      // parent package never hides separately selectable children or new discoveries.
      if (entrypoint && children.length === 1) return children[0]!;
      let compact = { ...node, children };
      while (compact.children.length === 1 && compact.children[0]!.kind === 'dir'
        && !byPath.has(compact.children[0]!.path)) {
        const child = compact.children[0]!;
        compact = { ...child, name: `${compact.name}/${child.name}` };
      }
      return compact;
    });
  }
  return { nodes: transform(buildFileTree(Object.fromEntries(candidates.map(skill => [skill.path, null])))), included };
}

export function SkillSourceTree({ candidates, selected, excludedFolders, onChange, onPreview, disabled = false }: {
  candidates: SkillTreeCandidate[]; selected: Set<string>; excludedFolders: string[];
  onChange: (selected: Set<string>, excludedFolders: string[]) => void;
  onPreview?: (skill: SkillTreeCandidate, filePath?: string) => void; disabled?: boolean;
}) {
  useTranslation();
  const [search, setSearch] = useState('');
  const [expansion, setExpansion] = useState(new Map<string, boolean>());
  const { nodes, included } = useMemo(() => buildSkillPackageTree(candidates), [candidates]);
  const skillsByPath = new Map(candidates.map(skill => [skill.path, skill]));
  const allDirs = collectAllPaths(nodes, 'dir');
  const expanded = new Set([...allDirs].filter(path => expansion.get(path) ?? !skillsByPath.has(path)));
  const visiblePaths = search ? new Set<string>() : undefined;
  if (visiblePaths) {
    const query = search.toLowerCase();
    function matches(nodes: FileTreeNode[]): boolean {
      let any = false;
      for (const node of nodes) {
        const skill = skillsByPath.get(node.path) ?? included.get(node.path)?.skill;
        const match = skill && `${skill.path} ${skill.name} ${skill.description ?? ''} ${(skill.inspection?.files ?? []).map(file => file.path).join(' ')}`.toLowerCase().includes(query);
        if (matches(node.children) || match) { visiblePaths!.add(node.path); expanded.add(node.path); any = true; }
      }
      return any;
    }
    matches(nodes);
  }
  function toggleCheck(path: string) {
    if (disabled || included.has(path)) return;
    if (skillsByPath.has(path)) {
      const next = new Set(selected);
      if (next.has(path)) next.delete(path); else next.add(path);
      onChange(next, excludedFolders);
      return;
    }
    const descendants = candidates.filter(skill => !path || skill.path.startsWith(`${path}/`));
    const checked = !descendants.every(skill => selected.has(skill.path));
    const next = updateSkillTreeSelection(candidates, selected, path, checked);
    const folders = excludedFolders.filter(folder => Boolean(path) && folder !== path && !folder.startsWith(`${path}/`));
    if (!checked) folders.push(path);
    onChange(next, folders);
  }
  const selectedCount = candidates.filter(skill => selected.has(skill.path)).length;
  const allCollapsed = allDirs.size > 0 && expanded.size === 0;
  return <div className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
    <div className="flex items-center gap-2 px-3">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("oct5Core.s0392")} aria-label={t("oct5Core.s0393")} />
    </div>
    <div className="flex items-center justify-between gap-2 border-y border-border bg-muted/30 px-3 py-1.5">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="size-3.5 accent-foreground" aria-label={t("oct5Core.s0394")}
          checked={candidates.length > 0 && selectedCount === candidates.length}
          ref={element => { if (element) element.indeterminate = selectedCount > 0 && selectedCount < candidates.length; }}
          disabled={disabled || candidates.length === 0} onChange={() => toggleCheck('')} />
        <span>{t("oct5Core.selectedOutOf", { count: selectedCount, total: candidates.length })}</span>
      </label>
      <Button type="button" variant="ghost" size="xs" className="font-normal text-muted-foreground" disabled={disabled || Boolean(search) || allDirs.size === 0} onClick={() => setExpansion(new Map([...allDirs].map(path => [path, allCollapsed])))}>{allCollapsed ? t("oct5Core.s0395") : t("oct5Core.s0396")}</Button>
    </div>
    <div className="min-h-0 max-h-(--sz-480px) overflow-auto py-1">
      <FileTree layout="explorer" wrapLabels={false}
        nodes={nodes} selectedFile={null} expandedDirs={expanded}
        visiblePaths={visiblePaths} disabled={disabled} ariaLabel={t("oct6Beta.discoveredSkills")}
        empty={{ title: t("oct5Core.s0397"), description: t("oct5Core.s0398") }}
        onToggleDir={path => setExpansion(previous => new Map(previous).set(path, !expanded.has(path)))}
        onSelectFile={path => { const file = included.get(path); if (file) onPreview?.(file.skill, file.filePath); }}
        onToggleCheck={toggleCheck}
        checkboxLabel={node => skillsByPath.has(node.path) ? t("oct6Beta.importPath", { path: node.path }) : t("oct5Core.importFolder", { path: node.path })}
        getCheckboxState={node => {
          if (included.has(node.path)) return null;
          if (skillsByPath.has(node.path)) return selected.has(node.path) ? 'checked' : 'unchecked';
          const descendants = candidates.filter(skill => skill.path.startsWith(`${node.path}/`));
          const count = descendants.filter(skill => selected.has(skill.path)).length;
          return count === 0 ? 'unchecked' : count === descendants.length ? 'checked' : 'mixed';
        }}
        renderLabel={node => {
          const skill = skillsByPath.get(node.path);
          if (!skill) return <span className="block truncate font-mono text-xs" title={included.get(node.path)?.filePath ?? node.path}>{node.name}</span>;
          return <span className="flex min-w-0 items-baseline gap-2" title={[skill.path, skill.description, skill.error].filter(Boolean).join('\n')}>
            <span className="max-w-full shrink-0 truncate font-medium text-foreground">{skill.name}</span>
            {(skill.error ?? skill.description) && <span className={`min-w-0 flex-1 truncate text-xs ${skill.error ? 'text-destructive' : 'text-muted-foreground'}`}>{skill.error ?? skill.description}</span>}
            <span className="hidden max-w-32 shrink-0 truncate font-mono text-xs text-muted-foreground md:inline" title={skill.path}>{skill.path.split('/').at(-2) ?? '.'}/</span>
          </span>;
        }}
        renderNodeExtra={node => {
          const skill = skillsByPath.get(node.path);
          if (!skill) return node.kind === 'file' ? <span className="text-xs text-muted-foreground">{t("oct5Core.s0399")}</span> : null;
          const label = skill.error ? t("oct5Core.s0400") : skill.inspection?.references.length ? t("oct5Core.s0378") : skill.note === 'New skill' ? t("oct5Core.s0401") : skill.note === 'Already imported' ? t("oct5Core.s0402") : skill.note?.startsWith('Removed from source') ? t("oct5Core.s0403") : skill.note;
          const count = skill.inspection?.files.length ?? skill.fileCount;
          return <>
            {label && <Badge variant="outline" className={skill.error ? 'font-normal text-destructive' : 'hidden font-normal text-muted-foreground sm:inline-flex'} title={skill.error ?? (skill.note === "New skill" ? t("oct5Core.sourceNoteNew") : skill.note === "Already imported" ? t("oct5Core.sourceNoteImported") : skill.note?.startsWith("Removed from source") ? t("oct5Core.sourceNoteRemoved") : skill.note)}>{label}</Badge>}
            {count !== undefined && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("oct5Core.files", { count })}</span>}
            {onPreview && <Button type="button" size="icon-xs" variant="ghost" disabled={disabled} aria-label={t("oct5Core.inspectSkill", { name: skill.name })} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onPreview(skill); }}>{skill.inspection?.references.length ? <AlertTriangle className="size-3.5" /> : <Info className="size-3.5" />}</Button>}
          </>;
        }}
      />
    </div>
    <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t("oct5Core.s0404")}</p>
  </div>;
}
