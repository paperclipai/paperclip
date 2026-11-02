import { t, useTranslation } from "@/i18n";
import { SettingsDisplayError, settingsErrorText } from "@/lib/settings-localization";
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
  useTranslation();
  const [added, setAdded] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const pending = added.filter(id => !projectIds.includes(id));
  const visibleIds = [...new Set([...projectIds, ...pending])];
  const name = (id: string) => projects.find(project => project.id === id)?.name ?? t("oct26Settings.projects.unavailable");
  const matches = projects.filter(project => project.name.toLowerCase().includes(query.toLowerCase()));

  async function save() {
    if (!canManage || saving || !pending.length) return;
    setSaving(true); setError(null); setSaved(false);
    try { await onSave(pending); setAdded([]); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? failure : new SettingsDisplayError("projects.saveError")); }
    finally { setSaving(false); }
  }

  return <section aria-label={t("oct26Settings.projects.title")} className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1"><h3 className="text-sm font-semibold">{t("oct26Settings.projects.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("oct26Settings.projects.description")}</p></div>
      {canManage && <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={saving}><Plus className="size-4" aria-hidden />{t("oct26Settings.projects.add")}</Button>
      </PopoverTrigger><PopoverContent align="end" className="w-72 space-y-3">
        <Input aria-label={t("oct26Settings.projects.search")} placeholder={t("oct26Settings.projects.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
        <div className="max-h-64 space-y-1 overflow-y-auto">{matches.map(project => <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent">
          <Checkbox aria-label={project.name} checked={projectIds.includes(project.id) || pending.includes(project.id)} disabled={projectIds.includes(project.id)} className="mt-0.5"
            onCheckedChange={checked => { setAdded(current => checked ? [...new Set([...current, project.id])] : current.filter(id => id !== project.id)); setSaved(false); }} />
          <span className="min-w-0 text-sm">{project.name}{projectIds.includes(project.id) && <span className="block text-xs text-muted-foreground">{t("oct26Settings.projects.alreadyAllowed")}</span>}</span>
        </label>)}</div>
        {!matches.length && <p className="text-sm text-muted-foreground">{t("oct26Settings.projects.noMatches")}</p>}
        <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(false)}>{t("oct26Settings.projects.done")}</Button>
      </PopoverContent></Popover>}
    </div>
    {visibleIds.length ? <ul aria-label={t("oct26Settings.projects.title")} className="divide-y divide-border rounded-lg border">
      {visibleIds.map(id => <li key={id} className="flex items-center gap-3 p-4">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1 break-words text-sm font-medium">{name(id)}</span>
        {projectIds.includes(id) ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden />{t("oct26Settings.projects.allowed")}</span>
          : <><span className="text-xs text-muted-foreground">{t("oct26Settings.projects.toAdd")}</span><Button variant="ghost" size="icon-sm" disabled={saving} aria-label={t("oct26Settings.projects.undoAdd", { name: name(id) })} onClick={() => setAdded(current => current.filter(value => value !== id))}><X className="size-4" aria-hidden /></Button></>}
      </li>)}
    </ul> : <p className="text-sm text-muted-foreground">{t("oct26Settings.projects.noneAllowed")}</p>}
    {!canManage && <p className="text-sm text-muted-foreground">{t("oct26Settings.projects.permission")}</p>}
    {pending.length > 0 && <div className="space-y-2 rounded-md bg-muted p-4 text-sm">
      <p className="font-medium">{t("oct26Settings.projects.addAccess", { projects: pending.map(name).join(", ") })}</p>
      <p className="text-muted-foreground">{t("oct26Settings.projects.accessNotice", { count: pending.length, name: agentName })}</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{t("oct26Settings.projects.keptSelectionError")} {settingsErrorText(error)}</p>}
    {saved && <p role="status" className="inline-flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{t("oct26Settings.projects.saved")}</p>}
    {canManage && <div className="flex items-center justify-between gap-3 border-t pt-4">
      <Button variant="ghost" disabled={saving || !pending.length} onClick={() => { setAdded([]); setError(null); setSaved(false); }}>{t("oct26Settings.common.cancel")}</Button>
      <Button disabled={saving || !pending.length} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" aria-hidden />}{saving ? t("oct26Settings.projects.saving") : error ? t("oct26Settings.projects.trySaveAgain") : t("oct26Settings.projects.saveAccess")}</Button>
    </div>}
  </section>;
}
