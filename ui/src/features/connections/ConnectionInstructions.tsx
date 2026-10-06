import { t, useTranslation } from "@/i18n";
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
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { InlineBanner } from "@/components/InlineBanner";

export function ConnectionInstructionsEditor({ provider, template, value, onChange, disabled = false }: {
  provider: string;
  template: ConnectionInstructionTemplate;
  value: ConnectionAgentInstructions;
  onChange: (value: ConnectionAgentInstructions) => void;
  disabled?: boolean;
}) {
  useTranslation();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const changed = value.text !== template.text || value.template?.id !== template.id || value.template?.version !== template.version;
  return <section className="space-y-3" aria-label={t("sep28Routines.agentInstructions")}>
    <h3 className="text-sm font-medium">{t("sep28Routines.agentInstructions")}</h3>
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="text-sm">{t("oct6Beta.tellAgentsProvider", { provider })}</label>
      <ToggleSwitch id={id} checked={value.enabled} disabled={disabled} onCheckedChange={(enabled) => onChange({ ...value, enabled })} />
    </div>
    {!value.enabled && <InlineBanner tone="warning">{t("oct6Beta.copy136")}</InlineBanner>}
    {editing ? <Textarea aria-label={t("oct6Beta.copy137")} value={value.text} disabled={disabled} maxLength={CONNECTION_INSTRUCTIONS_MAX_LENGTH}
      className="min-h-40" onChange={(event) => onChange({ ...value, text: event.target.value })} />
      : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{value.text}</p>}
    {!value.text.trim() && <p role="alert" className="text-sm text-destructive">{t("oct6Beta.copy138")}</p>}
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(!editing)}>{editing ? t("oct6Beta.copy139") : t("localizationRoutines.editInstructions")}</Button>
      {changed && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange({ ...defaultConnectionAgentInstructions(template)!, enabled: value.enabled })}>{t("oct6Beta.copy140")}</Button>}
    </div>
  </section>;
}

export function ConnectionInstructionsSettings({ connection, provider, template, canConfigure }: {
  connection: ToolConnection;
  provider: string;
  template: ConnectionInstructionTemplate;
  canConfigure: boolean;
}) {
  useTranslation();
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
    {mutation.isError && <div role="alert"><InlineBanner tone="danger">{mutation.error instanceof Error ? mutation.error.message : t("sep28Apps.instructionsFailed")}</InlineBanner></div>}
    {dirty && <div className="flex items-center justify-between">
      <Button variant="ghost" disabled={mutation.isPending} onClick={() => { setDraft(null); mutation.reset(); }}>{t("oct5Core.s0345")}</Button>
      <Button disabled={!canConfigure || mutation.isPending || !value.text.trim()} onClick={() => mutation.mutate()}>{mutation.isPending ? t("oct5Core.s0466") : t("sep28Apps.saveInstructions")}</Button>
    </div>}
  </div>;
}

export function AgentConnectionInstructions({ companyId, agentId }: { companyId: string; agentId: string }) {
  useTranslation();
  const query = useQuery({ queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agentId), queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId) });
  const sources = query.data?.installedConnections.filter((connection) => connection.agentInstructions && connection.enabled && connection.status === "active") ?? [];
  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t("oct6Beta.copy141")}</p>;
  if (query.isError) return <InlineBanner tone="danger" actions={<Button variant="ghost" onClick={() => void query.refetch()}>{t("oct5Core.s0281")}</Button>}>{t("oct6Beta.copy142")}</InlineBanner>;
  if (!sources.length) return null;
  return <section className="mt-8 space-y-4" aria-label={t("oct6Beta.copy143")}>
    <h3 className="text-sm font-medium">{t("oct6Beta.copy143")}</h3>
    <p className="text-sm text-muted-foreground">{t("oct6Beta.copy144")}</p>
    {sources.map((connection) => {
      const config = connectionInstructionsConfig(connection);
      const app = getConnectableAppDefinition(String(config.sourceTemplateKey ?? ""));
      const context = connectionInstructionContext(app, config);
      return <div key={connection.id} className="space-y-3 rounded-lg border border-border p-4">
        <Link className="text-sm font-medium underline underline-offset-2" to={`/apps/${connection.id}/permissions`}>{connection.name}</Link>
        {!connection.agentInstructions!.enabled && <InlineBanner tone="warning">{t("oct6Beta.copy145")}</InlineBanner>}
        {context === null ? <InlineBanner tone="warning">{t("oct6Beta.copy146")}</InlineBanner>
          : <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{connection.agentInstructions!.text}</p>}
      </div>;
    })}
  </section>;
}
