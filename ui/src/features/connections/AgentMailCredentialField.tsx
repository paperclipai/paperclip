import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { describeError } from "@/api/errors";
import { useQueryView } from "@/components/QueryView";
import { formatDateTime } from "@/lib/utils";
import { ApiKeyCredentialField } from "./ApiKeyCredentialField";
import { AGENTMAIL_API_KEYS_URL } from "./AgentMailApiKeyField";

export function AgentMailCredentialField({ companyId, connectionId, onConnectionChange, value, onChange, disabled }: {
  companyId: string;
  connectionId: string | null;
  onConnectionChange(id: string): void;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const saved = useQuery({ queryKey: ["email-credentials", companyId],
    queryFn: () => emailApi.credentials(companyId), staleTime: 60_000 });
  const savedView = useQueryView(saved);
  useEffect(() => {
    // Null means untouched; an explicit new-key choice must survive refreshes
    // and slow responses. Inbox-only keys cannot create a new email address.
    if (connectionId !== null || value || !saved.isSuccess) return;
    const preferred = saved.data.find(option => option.scope === "organization" || option.scope === "pod");
    if (preferred) onConnectionChange(preferred.id);
  }, [connectionId, value, saved.isSuccess, saved.data, onConnectionChange]);
  return <ApiKeyCredentialField providerName="AgentMail" keysUrl={AGENTMAIL_API_KEYS_URL}
    options={(saved.data ?? []).map(option => ({ id: option.id, disabled: option.scope === "unavailable",
      label: `${option.label} · saved ${formatDateTime(option.createdAt)}` }))}
    connectionId={connectionId} onConnectionChange={onConnectionChange} value={value} onChange={onChange}
    disabled={disabled} loading={saved.isFetching || savedView.kind === "reconnecting"}
    error={savedView.kind === "error" ? describeError(saved.error).body : undefined} />;
}
