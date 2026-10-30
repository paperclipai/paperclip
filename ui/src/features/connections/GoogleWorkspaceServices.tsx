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
  return <div className="divide-y">
    {GOOGLE_WORKSPACE_SERVICE_GROUPS.map(group => <div key={group.id} className="flex items-center gap-3 py-3">
      <AppLogo name={group.name} brandKey={group.brandKey} size={28} />
      <div className="min-w-0 flex-1 space-y-1">
        <label htmlFor={`workspace-service-${group.id}`} className="text-sm font-medium">{group.name}</label>
        {"description" in group && <p className="text-xs text-muted-foreground">{group.description}</p>}
      </div>
      <NativeSelect aria-label={`${group.name} access`} disabled={!value[group.id]} value={value[group.id] ?? "write"}
        className="w-auto shrink-0 disabled:opacity-50"
        onChange={event => onChange({ ...value, [group.id]: event.target.value as "read" | "write" })}>
        <option value="read">Read only</option><option value="write">Read &amp; write</option>
      </NativeSelect>
      <ToggleSwitch id={`workspace-service-${group.id}`} aria-label={group.name} checked={Boolean(value[group.id])}
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
  const existing = props.connection && props.connection.status !== "draft" ? props.connection : null;
  const oauth = props.connection?.config?.oauth as { pendingWorkspaceServiceRequests?: Record<string, { requestedScopes?: unknown; requestedAt?: string }> } | undefined;
  const pendingRequests = oauth?.pendingWorkspaceServiceRequests;
  const loadConnection = existing ?? (pendingRequests && Object.keys(pendingRequests).length ? props.connection : null);
  const grants = useQuery({ queryKey: ["workspace-service-consent", loadConnection?.id], queryFn: () => toolsApi.listConnectionGrants(loadConnection!.id), enabled: Boolean(loadConnection) });
  if (loadConnection && !grants.data) return <Dialog open onOpenChange={open => { if (!open) props.onCancel(); }}><DialogContent>
    <DialogTitle>Connect Google Workspace</DialogTitle><DialogDescription>{grants.isError ? "Could not load your saved service access. Your connection has not changed." : "Loading your saved service access…"}</DialogDescription>
    <footer className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={() => props.onCancel()}>Cancel</Button>{grants.isError && <Button onClick={() => void grants.refetch()}>Try again</Button>}</footer>
  </DialogContent></Dialog>;
  const grant = grants.data?.grants.find(grant => existing?.credentialPolicy === "per_user"
    ? grant.kind === "user" && grant.subjectUserId === grants.data?.currentUserId
    : existing?.credentialPolicy === "per_agent"
      ? grant.kind === "agent" && grant.subjectAgentId === (existing.config?.oauth as { connectorSubjectAgentId?: string } | undefined)?.connectorSubjectAgentId
      : grant.kind === "organization");
  const savedScopes = grant?.providerTenant?.oauth?.requestedScopes ?? grant?.providerTenant?.oauth?.scopes ?? [];
  const pending = grants.data?.currentUserId ? pendingRequests?.[grants.data.currentUserId] : undefined;
  const pendingTime = Date.parse(pending?.requestedAt ?? "");
  // Refresh and lease writes update the grant row without changing consent.
  const consentTime = grant ? Date.parse(grant.providerTenant?.oauth?.consentedAt ?? String(grant.createdAt)) : NaN;
  const grantTime = Number.isFinite(consentTime) ? consentTime : -Infinity;
  const pendingScopes = Number.isFinite(pendingTime) && pendingTime > grantTime && Array.isArray(pending?.requestedScopes) && pending.requestedScopes.every(scope => typeof scope === "string")
    ? pending.requestedScopes as string[] : undefined;
  return <ServicePicker {...props} initial={props.initial ?? (pendingScopes ? googleWorkspaceSelectionForScopes(pendingScopes) : existing ? googleWorkspaceSelectionForScopes(savedScopes) : undefined)} />;
}

function ServicePicker({ onContinue, onCancel, initial = GOOGLE_WORKSPACE_DEFAULT_SELECTION }: DialogProps) {
  const [selection, setSelection] = useState(initial);
  const empty = Object.keys(selection).length === 0;
  return <Dialog open onOpenChange={open => { if (!open) onCancel(selection); }}>
    <DialogContent className="sm:max-w-3xl">
      <DialogHeader className="text-left">
        <div className="flex items-center gap-3"><AppLogo name="Google Workspace" brandKey="google" size={40} /><DialogTitle>Connect Google Workspace</DialogTitle></div>
        <DialogDescription className="sr-only">Choose the Google services to connect.</DialogDescription>
      </DialogHeader>
      <GoogleWorkspaceServiceFields value={selection} onChange={setSelection} />
      {empty && <p role="status" className="text-xs text-muted-foreground">Select at least one service to continue.</p>}
      <footer className="flex items-center justify-between gap-3 pt-4">
        <Button variant="ghost" onClick={() => onCancel(selection)}>Cancel</Button>
        <Button disabled={empty} onClick={() => onContinue(selection)}>Continue</Button>
      </footer>
    </DialogContent>
  </Dialog>;
}
