import { useState } from "react";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { LocalProviderLoginInstructions, ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import type {
  AiConnectionBinding,
  AiConnectionRequirement,
  AiConnectionSummary,
} from "./model";
import { useTranslation } from "@/i18n";

const requirement: AiConnectionRequirement = {
  companyId: "design-example",
  provider: "anthropic",
  method: "subscription",
};
export function AiConnectionDesignExamples() {
  const { t } = useTranslation();
  const account: AiConnectionSummary = {
    ...requirement,
    method: "subscription",
    id: "example",
    grantId: "example-grant",
    name: t("agents.AiConnectionDesignExamples.exampleAccountName"),
    ownership: "personal",
    ownerUserId: "example-user",
    ownerName: "You",
    status: "connected",
    isDefault: true,
  };
  const [binding, setBinding] = useState<AiConnectionBinding>({
    provider: "anthropic",
    method: "subscription",
    mode: "responsible_user",
  });
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {t("agents.AiConnectionDesignExamples.intro")}
      </p>
      <p className="text-sm text-muted-foreground">{t("agents.AiConnectionDesignExamples.providers")}</p>
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
        placeholder={t("agents.AiConnectionDesignExamples.apiKeyPlaceholder")}
      />
      <LocalProviderLoginInstructions
        adapterType="claude_local"
        login={{ isolated: true, preparing: false, status: "sign_in_required", error: null,
          command: "CLAUDE_CONFIG_DIR='/example/connection-login' claude auth login", retry: () => {} }}
      />
    </div>
  );
}
