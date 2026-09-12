import { useTranslation } from "@/i18n";
import { useState } from "react";
import { AiConnectionPicker } from "./AiConnectionPicker";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
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
  const { t } = useTranslation();
  const [binding, setBinding] = useState<AiConnectionBinding>({
    provider: "anthropic",
    method: "subscription",
    mode: "responsible_user",
  });
  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {t("sep13Connections.designDescription")}
      </p>
      <p className="text-sm text-muted-foreground">{t("sep13Connections.designComponents")}</p>
      <AiConnectionPicker
        requirement={requirement}
        connections={[{ ...account, name: t("sep13Connections.defaultSubscriptionName", { provider: "Claude" }), ownerName: t("sep13Connections.exampleOwner") }]}
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
        placeholder={t("sep13Connections.apiKeyPlaceholder")}
      />
    </div>
  );
}
