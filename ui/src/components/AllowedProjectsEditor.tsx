import { t, useTranslation, Trans } from "@/i18n";
import { useState } from "react";
import { Check, FolderOpen, Loader2, Plus, X } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export interface AllowedProjectsEditorProps {
  projects: Array<{ id: string; name: string }>;
  projectIds: string[];
  canManage: boolean;
  agentName: string;
  onSave: (projectIds: string[]) => Promise<unknown>;
}

export function AllowedProjectsEditor({ projects, projectIds, canManage, agentName, onSave }: AllowedProjectsEditorProps) {
  useTranslation("task-components");
  const [added, setAdded] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<{ raw: string } | { key: string } | null>(null);
  const pending = added.filter(id => !projectIds.includes(id));
  const visibleIds = [...new Set([...projectIds, ...pending])];
  const name = (id: string) => projects.find(project => project.id === id)?.name ?? t("deep-ui:unavailable_project_3045d2");
  const matches = projects.filter(project => project.name.toLowerCase().includes(query.toLowerCase()));

  async function save() {
    if (!canManage || saving || !pending.length) return;
    setSaving(true); setError(null); setSaved(false);
    try { await onSave(pending); setAdded([]); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? { raw: failure.message } : { key: "access_save_failed" }); }
    finally { setSaving(false); }
  }

  return <section aria-label={t("task-components:allowedProjects_230edefb")} className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h3 className="text-sm font-semibold">{t("task-components:allowedProjects_230edefb")}</h3>
        <p className="text-sm text-muted-foreground">{t("task-components:projectsWhoseTasksAndRepositoriesThisAgent_ddc99f36")}</p></div>
      {canManage && <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={saving}><Plus className="size-4" aria-hidden />{t("deep-ui:access_add")}</Button>
      </PopoverTrigger><PopoverContent align="end" className="w-72 space-y-3">
        <Input aria-label={t("task-components:searchProjects_9e079c7d")} placeholder={t("task-components:searchProjects_b0c5facf")} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="max-h-64 space-y-1 overflow-y-auto">{matches.map(project => <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent">
          <Checkbox aria-label={project.name} checked={projectIds.includes(project.id) || pending.includes(project.id)} disabled={projectIds.includes(project.id)} className="mt-0.5"
            onCheckedChange={checked => { setAdded(current => checked ? [...new Set([...current, project.id])] : current.filter(id => id !== project.id)); setSaved(false); }} />
          <span className="min-w-0 text-sm">{project.name}{projectIds.includes(project.id) && <span className="block text-xs text-muted-foreground">{t("task-components:alreadyAllowed_1761b7cb")}</span>}</span>
        </label>)}</div>
        {!matches.length && <p className="text-sm text-muted-foreground">{t("task-components:noProjectsFound_26e92309")}</p>}
        <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(false)}>{t("task-components:done_11a6767d")}</Button>
      </PopoverContent></Popover>}
    </div>
    {visibleIds.length ? <ul aria-label={t("task-components:allowedProjects_230edefb")} className="divide-y divide-border rounded-lg border">
      {visibleIds.map(id => <li key={id} className="flex items-center gap-3 p-4">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1 break-words text-sm font-medium">{name(id)}</span>
        {projectIds.includes(id) ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden />{t("task-components:allowed_1bb201d1")}</span>
          : <><span className="text-xs text-muted-foreground">{t("task-components:toAdd_0546c1c6")}</span><Button variant="ghost" size="icon-sm" disabled={saving} aria-label={t("deep-ui:access_undo", { name: name(id) })} onClick={() => setAdded(current => current.filter(value => value !== id))}><X className="size-4" aria-hidden /></Button></>}
      </li>)}
    </ul> : <p className="text-sm text-muted-foreground">{t("task-components:noProjectsAllowedYet_1369b8b0")}</p>}
    {!canManage && <p className="text-sm text-muted-foreground">{t("task-components:aPersonWithAgentManagementPermissionCan_d4e0efa0")}</p>}
    {pending.length > 0 && <div className="space-y-2 rounded-md bg-muted p-4 text-sm">
      <p className="font-medium"><Trans ns="task-components" i18nKey="sentence_f0052a463bbc" components={{ part1: <>{pending.map(name).join(", ")}</> }} /></p>
      <p className="text-muted-foreground">{t("deep-ui:access_explanation", { agent: agentName, count: pending.length })}</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive"><Trans ns="task-components" i18nKey="sentence_734328dd3441" components={{ part1: <>{error && ("raw" in error ? error.raw : t(`deep-ui:${error.key}`))}</> }} /></p>}
    {saved && <p role="status" className="inline-flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{t("deep-ui:access_saved")}</p>}
    {canManage && <div className="flex items-center justify-between gap-3 border-t pt-4">
      <Button variant="ghost" disabled={saving || !pending.length} onClick={() => { setAdded([]); setError(null); setSaved(false); }}>{t("task-components:cancel_19766ed6")}</Button>
      <Button disabled={saving || !pending.length} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" aria-hidden />}{saving ? t("deep-ui:saving_access_49299d") : error ? t("deep-ui:try_saving_again_b04cf4") : t("deep-ui:save_project_access_6d52d1")}</Button>
    </div>}
  </section>;
}
