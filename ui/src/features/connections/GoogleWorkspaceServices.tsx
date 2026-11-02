import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { GOOGLE_WORKSPACE_DEFAULT_SELECTION, GOOGLE_WORKSPACE_SERVICE_GROUPS, googleWorkspaceSelectionForScopes, type GoogleWorkspaceServiceSelection, type ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/select";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { AppLogo } from "@/pages/apps/AppLogo";

export function GoogleWorkspaceServiceFields({ value, onChange }: {
  value: GoogleWorkspaceServiceSelection;
  onChange: (value: GoogleWorkspaceServiceSelection) => void;
}) {
  useTranslation();
  const serviceName = (group: (typeof GOOGLE_WORKSPACE_SERVICE_GROUPS)[number]) => group.id === "drive" ? t("oct26Ui.workspace.drive") : group.id === "calendar" ? t("oct26Ui.workspace.calendar") : group.name;
  return <div className="divide-y">
    {GOOGLE_WORKSPACE_SERVICE_GROUPS.map(group => <div key={group.id} className="flex items-center gap-3 py-3">
      <AppLogo name={group.name} brandKey={group.brandKey} size={28} />
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={`workspace-service-${group.id}`} className="text-sm font-medium">{serviceName(group)}</label>
        {"description" in group && <p className="text-xs text-muted-foreground">{group.id === "drive" && group.description === "Docs, Sheets, and Slides" ? t("oct26Ui.workspace.driveDescription") : group.description}</p>}
      </div>
      <NativeSelect aria-label={t("oct26Ui.workspace.access", { service: serviceName(group) })} disabled={!value[group.id]} value={value[group.id] ?? "write"}
        className="w-auto shrink-0 disabled:opacity-50"
        onChange={event => onChange({ ...value, [group.id]: event.target.value as "read" | "write" })}>
        <option value="read">{t("oct26Ui.workspace.readOnly")}</option><option value="write">{t("oct26Ui.workspace.readWrite")}</option>
      </NativeSelect>
      <ToggleSwitch id={`workspace-service-${group.id}`} aria-label={serviceName(group)} checked={Boolean(value[group.id])}
        onCheckedChange={checked => {
          const next = { ...value };
          if (checked) next[group.id] = "write";
          else delete next[group.id];
          onChange(next);
        }} />
    </div>)}
  </div>;
}

type DialogProps = {
  onContinue: (value: GoogleWorkspaceServiceSelection) => void;
  onCancel: (selection?: GoogleWorkspaceServiceSelection) => void;
  initial?: GoogleWorkspaceServiceSelection;
  connection?: ToolConnection;
};

export function GoogleWorkspaceServicesDialog(props: DialogProps) {
  useTranslation();
  const existing = props.connection && props.connection.status !== "draft" ? props.connection : null;
  const grants = useQuery({ queryKey: ["workspace-service-consent", existing?.id], queryFn: () => toolsApi.listConnectionGrants(existing!.id), enabled: Boolean(existing) });
  if (existing && !grants.data) return <Dialog open onOpenChange={open => { if (!open) props.onCancel(); }}><DialogContent>
    <DialogTitle>{t("oct26Ui.workspace.heading")}</DialogTitle><DialogDescription>{grants.isError ? t("oct26Ui.workspace.loadError") : t("oct26Ui.workspace.loading")}</DialogDescription>
    <footer className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={() => props.onCancel()}>{t("oct26Ui.workspace.cancel")}</Button>{grants.isError && <Button onClick={() => void grants.refetch()}>{t("oct26Ui.workspace.retry")}</Button>}</footer>
  </DialogContent></Dialog>;
  const grant = grants.data?.grants.find(grant => existing?.credentialPolicy === "per_user"
    ? grant.kind === "user" && grant.subjectUserId === grants.data?.currentUserId
    : existing?.credentialPolicy === "per_agent"
      ? grant.kind === "agent" && grant.subjectAgentId === (existing.config?.oauth as { connectorSubjectAgentId?: string } | undefined)?.connectorSubjectAgentId
      : grant.kind === "organization");
  const savedScopes = grant?.providerTenant?.oauth?.requestedScopes ?? grant?.providerTenant?.oauth?.scopes ?? [];
  return <ServicePicker {...props} initial={props.initial ?? (existing ? googleWorkspaceSelectionForScopes(savedScopes) : undefined)} />;
}

function ServicePicker({ onContinue, onCancel, initial = GOOGLE_WORKSPACE_DEFAULT_SELECTION }: DialogProps) {
  useTranslation();
  const [selection, setSelection] = useState(initial);
  const empty = Object.keys(selection).length === 0;
  return <Dialog open onOpenChange={open => { if (!open) onCancel(selection); }}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader className="text-left">
        <div className="flex items-center gap-3"><AppLogo name="Google Workspace" brandKey="google" size={40} /><DialogTitle>{t("oct26Ui.workspace.heading")}</DialogTitle></div>
        <DialogDescription className="sr-only">{t("oct26Ui.workspace.choose")}</DialogDescription>
      </DialogHeader>
      <GoogleWorkspaceServiceFields value={selection} onChange={setSelection} />
      {empty && <p role="status" className="text-xs text-muted-foreground">{t("oct26Ui.workspace.chooseAtLeastOne")}</p>}
      <footer className="flex items-center justify-between gap-3 pt-4">
        <Button variant="ghost" onClick={() => onCancel(selection)}>{t("oct26Ui.workspace.cancel")}</Button>
        <Button disabled={empty} onClick={() => onContinue(selection)}>{t("oct26Ui.workspace.continue")}</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
