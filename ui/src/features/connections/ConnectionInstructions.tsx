import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CONNECTION_INSTRUCTIONS_MAX_LENGTH,
  connectionInstructionContext,
  connectionInstructionsConfig,
  defaultConnectionAgentInstructions,
  getConnectableAppDefinition,
  type ConnectionAgentInstructions,
  type ConnectionInstructionTemplate,
  type ToolConnection,
} from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { InlineBanner } from "@/components/InlineBanner";
import { useTranslation } from "@/i18n";

export function ConnectionInstructionsEditor({ provider, template, value, onChange, disabled = false }: {
  provider: string;
  template: ConnectionInstructionTemplate;
  value: ConnectionAgentInstructions;
  onChange: (value: ConnectionAgentInstructions) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const changed = value.text !== template.text || value.template?.id !== template.id || value.template?.version !== template.version;
  return <section className="space-y-3" aria-label={t("apps.ConnectionInstructionsEditor.title")}>
    <h3 className="text-sm font-medium">{t("apps.ConnectionInstructionsEditor.title")}</h3>
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="text-sm">{t("apps.ConnectionInstructionsEditor.tellAgents", { provider })}</label>
      <ToggleSwitch id={id} checked={value.enabled} disabled={disabled} onCheckedChange={(enabled) => onChange({ ...value, enabled })} />
    </div>
    {!value.enabled && <InlineBanner tone="warning">{t("apps.ConnectionInstructionsEditor.warningOff")}</InlineBanner>}
    {editing ? <Textarea aria-label={t("apps.ConnectionInstructionsEditor.textLabel")} value={value.text} disabled={disabled} maxLength={CONNECTION_INSTRUCTIONS_MAX_LENGTH}
      className="min-h-40" onChange={(event) => onChange({ ...value, text: event.target.value })} />
      : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{value.text}</p>}
    {!value.text.trim() && <p role="alert" className="text-sm text-destructive">{t("apps.ConnectionInstructionsEditor.enterInstructions")}</p>}
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(!editing)}>{editing ? t("apps.ConnectionInstructionsEditor.doneEditing") : t("apps.ConnectionInstructionsEditor.editInstructions")}</Button>
      {changed && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...defaultConnectionAgentInstructions(template)!, enabled: value.enabled })}>{t("apps.ConnectionInstructionsEditor.reset")}</Button>}
    </div>
  </section>;
}

export function ConnectionInstructionsSettings({ connection, provider, template, canConfigure }: {
  connection: ToolConnection;
  provider: string;
  template: ConnectionInstructionTemplate;
  canConfigure: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [draft, setDraft] = useState<ConnectionAgentInstructions | null>(null);
  // A deliberately cleared setting stays off. Defaults are persisted by the server.
  const saved = connection.agentInstructions ?? { ...defaultConnectionAgentInstructions(template)!, enabled: false };
  const value = draft ?? saved;
  const mutation = useMutation({
    mutationFn: () => toolsApi.updateConnection(connection.id, { agentInstructions: value }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["tools"] });
      setDraft(null);
    },
  });
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);
  return <div className="space-y-4">
    <ConnectionInstructionsEditor provider={provider} template={template} value={value} onChange={setDraft} disabled={!canConfigure || mutation.isPending} />
    {mutation.error && <div role="alert"><InlineBanner tone="danger">{describeError(mutation.error).body}</InlineBanner></div>}
    {dirty && <div className="flex items-center justify-between">
      <Button variant="ghost" disabled={mutation.isPending} onClick={() => { setDraft(null); mutation.reset(); }}>{t("apps.ConnectionInstructionsSettings.cancel")}</Button>
      <Button disabled={!canConfigure || mutation.isPending || !value.text.trim()} onClick={() => mutation.mutate()}>{mutation.isPending ? t("apps.ConnectionInstructionsSettings.saving") : t("apps.ConnectionInstructionsSettings.save")}</Button>
    </div>}
  </div>;
}

export function AgentConnectionInstructions({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agentId), queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId) });
  const view = useQueryView(query);
  const sources = query.data?.installedConnections.filter((connection) => connection.agentInstructions && connection.enabled && connection.status === "active") ?? [];
  if (query.isLoading || view.kind === "reconnecting") return <p className="text-sm text-muted-foreground">{t("apps.AgentConnectionInstructions.loading")}</p>;
  if (view.kind === "error") return <QueryErrorState error={query.error} action={t("apps.AgentConnectionInstructions.loadAction")} onRetry={view.retry} retrying={view.isFetching} />;
  if (!sources.length) return null;
  return <section className="mt-8 space-y-4" aria-label={t("apps.AgentConnectionInstructions.fromConnections")}>
    <h3 className="text-sm font-medium">{t("apps.AgentConnectionInstructions.fromConnections")}</h3>
    <p className="text-sm text-muted-foreground">{t("apps.AgentConnectionInstructions.intro")}</p>
    {sources.map((connection) => {
      const config = connectionInstructionsConfig(connection);
      const app = getConnectableAppDefinition(String(config.sourceTemplateKey ?? ""));
      const context = connectionInstructionContext(app, config);
      return <div key={connection.id} className="space-y-3 rounded-lg border border-border p-4">
        <Link className="text-sm font-medium underline underline-offset-2" to={`/apps/${connection.id}/permissions`}>{connection.name}</Link>
        {!connection.agentInstructions!.enabled && <InlineBanner tone="warning">{t("apps.AgentConnectionInstructions.turnedOff")}</InlineBanner>}
        {context === null ? <InlineBanner tone="warning">{t("apps.AgentConnectionInstructions.incomplete")}</InlineBanner>
          : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{connection.agentInstructions!.text}</p>}
      </div>;
    })}
  </section>;
}
