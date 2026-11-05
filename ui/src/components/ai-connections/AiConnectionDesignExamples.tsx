import { useTranslation } from "@/i18n";
import { useState } from "react";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { LocalProviderLoginInstructions, ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import type {
  AiConnectionBinding,
  AiConnectionRequirement,
  AiConnectionSummary,
} from "./model";

const requirement: AiConnectionRequirement = {
  companyId: "design-example",
  provider: "anthropic",
  method: "subscription",
};
const account: AiConnectionSummary = {
  ...requirement,
  method: "subscription",
  id: "example",
  grantId: "example-grant",
  name: "My Claude subscription",
  ownership: "personal",
  ownerUserId: "example-user",
  ownerName: "You",
  status: "connected",
  isDefault: true,
};

export function AiConnectionDesignExamples() {
  const { t } = useTranslation("connections");
  const [binding, setBinding] = useState<AiConnectionBinding>({
    provider: "anthropic",
    method: "subscription",
    mode: "responsible_user",
  });
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t("shared_ai_connection_identity_account_selection_and_ffb052c")}</p>
      <p className="text-sm text-muted-foreground">{t("provider_lists_and_account_management_use_browse_4bb2567")}</p>
      <AiConnectionPicker
        requirement={requirement}
        connections={[account]}
        value={binding}
        currentUserId="example-user"
        agentId="example-agent"
        agentName="Nova"
        onChange={setBinding}
        readOnly
        onConnect={() => {}}
      />
      <ProviderApiKeyCard
        providerName="OpenAI"
        value=""
        disabled
        onChange={() => {}}
        onSubmit={() => {}}
        placeholder={t("enter_api_key_here_4991fd6")}
      />
      <LocalProviderLoginInstructions
        adapterType="claude_local"
        login={{ isolated: true, preparing: false, status: "sign_in_required", error: null,
          command: "CLAUDE_CONFIG_DIR='/example/connection-login' claude auth login", retry: () => {} }}
      />
    </div>
  );
}
