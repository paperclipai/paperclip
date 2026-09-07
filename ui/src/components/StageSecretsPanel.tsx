import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { KeyRound, Save } from "lucide-react";
import type { CompanySecret, RoutineEnvConfig } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./EmptyState";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { AgentIcon } from "./AgentIconPicker";

export interface StageSecretsPanelProps {
  /** Whether the stage has a backing automation routine with an assignee. */
  hasAutomation: boolean;
  /** Display name + icon of the agent that runs this step (when automation exists). */
  agentName?: string | null;
  agentIcon?: string | null;
  /** Company secret inventory (shared, not stage-scoped). */
  secrets: CompanySecret[];
  secretsLoading: boolean;
  value: RoutineEnvConfig;
  onChange: (env: RoutineEnvConfig) => void;
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Jump to the Automation section so the user can pick an agent. */
  onSetupAutomation: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}

/**
 * Stage Secrets tab body. Stage secrets are env bindings on the step's backing
 * automation routine — the same company-secret backbone used by routines,
 * agents, and projects. This panel is intentionally dense and reuses
 * `EnvironmentVariablesEditor` for secret refs, inline secret creation, version
 * selection, and missing/disabled-secret warnings.
 */
export function StageSecretsPanel({
  hasAutomation,
  agentName,
  agentIcon,
  secrets,
  secretsLoading,
  value,
  onChange,
  onCreateSecret,
  onSetupAutomation,
  onSave,
  saving,
  dirty,
}: StageSecretsPanelProps) {
  const { t } = useTranslation();
  // No backing automation/assignee → nothing can receive secrets at runtime.
  // Point the user at Automation instead of creating a hidden routine just
  // because the Secrets tab was opened.
  if (!hasAutomation) {
    return (
      <EmptyState
        icon={KeyRound}
        message={t("localizationSecrets.secretsAreAvailableOnlyToStepAutomationPickAn77")}
        action={t("localizationSecrets.setUpAutomation78")}
        onAction={onSetupAutomation}
      />
    );
  }

  const displayName = agentName?.trim() || t("localizationSecrets.theResponsibleAgent79");

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        {agentName ? (
          <AgentIcon icon={agentIcon} className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        ) : (
          <KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        )}
        <p>
          <Trans t={t} i18nKey="localizationSecrets.stageInjection" values={{ agent: displayName }} components={{ agent: <span className="font-medium text-foreground" />, code: <span className="font-mono" /> }} />
        </p>
      </div>

      {secretsLoading ? (
        <p className="text-sm text-muted-foreground">{t("localizationSecrets.loadingSecrets84")}</p>
      ) : (
        <EnvironmentVariablesEditor
          value={value}
          secrets={secrets}
          onCreateSecret={onCreateSecret}
          onChange={(env) => onChange((env ?? {}) as RoutineEnvConfig)}
        />
      )}

      <div className="flex items-center gap-3">
        <Button type="button" data-env-draft-commit="true" onClick={onSave} disabled={!dirty || saving}>
          <Save className="h-4 w-4 mr-1.5" />
          {saving ? t("localizationSecrets.saving85") : t("localizationSecrets.saveSecrets86")}
        </Button>
        {dirty && !saving ? <span className="text-xs text-muted-foreground">{t("localizationSecrets.unsavedChanges87")}</span> : null}
      </div>
    </div>
  );
}
