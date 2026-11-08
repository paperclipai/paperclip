import { useTranslation } from "@/i18n";
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { connectionInstructionsConfig, type ToolConnection } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineBanner } from "@/components/InlineBanner";

export function HonchoWorkspaceSettings({ connection, canConfigure }: { connection: ToolConnection; canConfigure: boolean }) {
  const { t } = useTranslation("connections");
  const id = useId();
  const client = useQueryClient();
  const connectionConfig = connectionInstructionsConfig(connection);
  const config = (connectionConfig.methodConfig ?? {}) as Record<string, unknown>;
  const saved = typeof config.workspaceId === "string" ? config.workspaceId : "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const mutation = useMutation({
    mutationFn: () => toolsApi.updateConnection(connection.id, { config: { ...connectionConfig, methodConfig: { ...config, workspaceId: value.trim() } } }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["tools"] }); setDraft(null); },
  });
  return <section className="space-y-3" aria-label={t("honcho_workspace_5738dbb")}>
    <label htmlFor={id} className="text-sm font-medium">{t("honcho_workspace_5738dbb")}</label>
    <Input id={id} value={value} maxLength={512} disabled={!canConfigure || mutation.isPending} placeholder={t("workspace_id_14fb665")} onChange={(event) => setDraft(event.target.value)} />
    {!value.trim() && <InlineBanner tone="warning">{t("enter_a_workspace_to_include_honcho_instructions_6b30219")}</InlineBanner>}
    {mutation.error && <div role="alert"><InlineBanner tone="danger">{describeError(mutation.error).body}</InlineBanner></div>}
    {draft !== null && draft !== saved && <div className="flex items-center justify-between">
      <Button variant="ghost" disabled={mutation.isPending} onClick={() => { setDraft(null); mutation.reset(); }}>{t("cancel_77dfd21")}</Button>
      <Button disabled={!canConfigure || mutation.isPending || !value.trim()} onClick={() => mutation.mutate()}>{mutation.isPending ? t("saving_56a2285") : t("save_workspace_36256dc")}</Button>
    </div>}
  </section>;
}
