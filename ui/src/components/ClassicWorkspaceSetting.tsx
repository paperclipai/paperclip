import { useCompany } from "@/context/CompanyContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTx } from "@/i18n/tx";

export function ClassicWorkspaceSetting() {
  const tx = useTx();
  const { selectedCompany } = useCompany();
  const workspace = useCoordinatorWorkspaceEnabled();
  const error = workspace.error instanceof Error ? workspace.error.message : null;
  return (
    <Card className="block bg-transparent p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h3 id="classic-workspace-title" className="text-sm font-medium">{tx("Classic workspace")}</h3>
          <p id="classic-workspace-description" className="text-sm text-muted-foreground">
            {tx("Use the previous workspace instead of the standard Coordinator workspace. This changes your interface across companies on this instance.")}
          </p>
          <p className="text-xs text-muted-foreground">
            {tx("Off by default. Turn it off to return to Coordinator. Your work and your teammates’ settings stay the same.")}
          </p>
          {workspace.userId === "local-board" && (
            <p className="text-xs text-muted-foreground">{tx("This local instance uses the shared Local Board identity.")}</p>
          )}
        </div>
        <ToggleSwitch
          checked={workspace.loaded && !workspace.enabled}
          disabled={!workspace.loaded || workspace.isSaving || !workspace.userId || !selectedCompany || !!workspace.error}
          aria-label={tx("Enable classic workspace")}
          aria-describedby="classic-workspace-description"
          onCheckedChange={(classicEnabled) => {
            if (!selectedCompany) return;
            void workspace.setEnabled(selectedCompany.id, !classicEnabled).catch(() => {});
          }}
        />
      </div>
      {workspace.isSaving && <p role="status" className="mt-3 text-sm text-muted-foreground">{tx("Saving your workspace…")}</p>}
      {!workspace.loaded && <p role="status" className="mt-3 text-sm text-muted-foreground">{tx("Loading your preference…")}</p>}
      {error && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-sm text-destructive">
          <span>{tx(error)}</span>
          <Button variant="ghost" size="sm" onClick={() => { void workspace.retry(); }}>{tx("Retry")}</Button>
        </div>
      )}
    </Card>
  );
}
