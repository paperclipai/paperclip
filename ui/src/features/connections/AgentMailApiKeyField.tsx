import { getAppStoreDefinition } from "@paperclipai/shared";
import { ApiKeyCredentialField } from "./ApiKeyCredentialField";

export const AGENTMAIL_API_KEYS_URL = getAppStoreDefinition("agentmail")!.methods[0]!.consoleLinks!.keys!;

export function AgentMailApiKeyField({ value, onChange, disabled = false, label = "API key" }: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  label?: string;
}) {
  return <ApiKeyCredentialField providerName="AgentMail" keysUrl={AGENTMAIL_API_KEYS_URL}
    options={[]} connectionId="" onConnectionChange={() => {}} value={value} onChange={onChange}
    disabled={disabled} label={label} />;
}
