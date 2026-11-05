import { useTranslation, t as translate } from "@/i18n";
import { getAppStoreDefinition } from "@paperclipai/shared";
import { ApiKeyCredentialField } from "./ApiKeyCredentialField";

export const AGENTMAIL_API_KEYS_URL = getAppStoreDefinition("agentmail")!.methods[0]!.consoleLinks!.keys!;

export function AgentMailApiKeyField({ value, onChange, disabled = false, label = translate("connections:api_key_cf678ca") }: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  label?: string;
}) {
  useTranslation("connections");
  return <ApiKeyCredentialField providerName="AgentMail" keysUrl={AGENTMAIL_API_KEYS_URL}
    options={[]} connectionId="" onConnectionChange={() => {}} value={value} onChange={onChange}
    disabled={disabled} label={label} />;
}
