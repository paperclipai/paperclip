import { useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import {
  useSolarisOrgs,
  useCreateSolarisOrg,
  useUpdateSolarisOrg,
  useDeleteSolarisOrg,
  LANGUAGE_LABELS,
  type SolarisOrg,
  type SupportedLanguage,
} from "../../hooks/useSolarisAlerts";

const LANGUAGES: SupportedLanguage[] = ["en", "es", "zh-Hans", "tl"];

interface OrgRowProps {
  org: SolarisOrg;
  companyId: string;
}

function OrgRow({ org, companyId }: OrgRowProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [language, setLanguage] = useState<SupportedLanguage>(org.preferredLanguage as SupportedLanguage);
  const updateOrg = useUpdateSolarisOrg();
  const deleteOrg = useDeleteSolarisOrg();

  async function handleSave() {
    await updateOrg.mutateAsync({ orgId: org.id, companyId, updates: { preferredLanguage: language } });
    setEditing(false);
  }

  async function handleDelete() {
    await deleteOrg.mutateAsync({ orgId: org.id, companyId });
    setConfirmDelete(false);
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded border border-border bg-card/60">
      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="text-sm flex-1 font-medium">{org.name}</span>
      {editing ? (
        <>
          <select
            className="text-xs bg-muted/40 border border-border rounded px-2 py-1"
            value={language}
            onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>
            ))}
          </select>
          <button
            onClick={handleSave}
            disabled={updateOrg.isPending}
            className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save
          </button>
          <button
            onClick={() => { setEditing(false); setLanguage(org.preferredLanguage as SupportedLanguage); }}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">{LANGUAGE_LABELS[org.preferredLanguage as SupportedLanguage] ?? org.preferredLanguage}</span>
          <span className="text-[10px] text-muted-foreground hidden">Alert notifications will be delivered in {LANGUAGE_LABELS[org.preferredLanguage as SupportedLanguage] ?? org.preferredLanguage} for this organization</span>
          <button
            onClick={() => setEditing(true)}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-muted text-muted-foreground"
          >
            Edit
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={handleDelete}
                disabled={deleteOrg.isPending}
                className="text-xs px-2 py-1 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-xs p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

interface OrgSettingsProps {
  companyId: string;
}

export function OrgSettings({ companyId }: OrgSettingsProps) {
  const { data: orgs = [], isLoading } = useSolarisOrgs(companyId);
  const createOrg = useCreateSolarisOrg();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLanguage, setNewLanguage] = useState<SupportedLanguage>("en");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    await createOrg.mutateAsync({ companyId, name: newName.trim(), preferredLanguage: newLanguage });
    setNewName("");
    setNewLanguage("en");
    setShowCreate(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Language & Localization</span>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border bg-card hover:bg-muted transition-colors"
        >
          <Plus className="h-3 w-3" /> Add Org
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="border border-border rounded-lg bg-card/60 p-3 space-y-2">
          <input
            className="w-full text-sm bg-muted/40 border border-border rounded px-3 py-2 placeholder:text-muted-foreground"
            placeholder="Organization name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <div className="flex gap-2">
            <select
              className="text-xs bg-card border border-border rounded px-2 py-1 flex-1"
              value={newLanguage}
              onChange={(e) => setNewLanguage(e.target.value as SupportedLanguage)}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={createOrg.isPending}
              className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {createOrg.isPending ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Alert notifications will be delivered in {LANGUAGE_LABELS[newLanguage]} for this organization
          </p>
        </form>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-2">Loading orgs…</div>
      ) : orgs.length === 0 ? (
        <div className="text-sm text-muted-foreground py-2">No orgs configured</div>
      ) : (
        <div className="space-y-1.5">
          {orgs.map((org) => (
            <OrgRow key={org.id} org={org} companyId={companyId} />
          ))}
        </div>
      )}
    </div>
  );
}
