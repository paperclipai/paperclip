import { useTranslation } from "@/i18n";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AI_PROVIDERS,
  aiConnectionProblem,
  aiMethodLabel,
  bindingProblem,
  matchesAiRequirement,
  personalAiDefault,
  type AiConnectionBinding,
  type AiConnectionRequirement,
  type AiConnectionSummary,
} from "./model";

export interface AiConnectionPickerProps {
  requirement: AiConnectionRequirement;
  connections: AiConnectionSummary[];
  value?: AiConnectionBinding;
  currentUserId: string;
  agentId: string;
  agentName: string;
  loading?: boolean;
  error?: string;
  readOnly?: boolean;
  onChange: (binding: AiConnectionBinding) => void;
  onConnect: () => void;
  onRetry?: () => void;
}

export function AiConnectionPicker({
  requirement,
  connections,
  value,
  currentUserId,
  agentId,
  loading,
  error,
  readOnly,
  onChange,
  onConnect,
  onRetry,
}: AiConnectionPickerProps) {
  const { t } = useTranslation();
  const compatible = connections.filter((connection) =>
    matchesAiRequirement(connection, requirement),
  );
  const personalDefault = personalAiDefault(
    compatible,
    requirement,
    currentUserId,
  );
  const problem = value ? bindingProblem(
    value,
    requirement,
    compatible,
    currentUserId,
    agentId,
  ) : undefined;
  const select = (
    mode: "shared",
    connection: AiConnectionSummary,
  ) =>
    onChange({
      provider: requirement.provider,
      method: requirement.method,
      mode,
      connectionId: connection.id,
      grantId: connection.grantId,
    });
  return (
    <section className="flex flex-col gap-4" aria-label={t("sep13Connections.aiConnection")}>
      <div className="flex items-center gap-3">
        <AppLogo
          name={AI_PROVIDERS[requirement.provider].name}
          brandKey={requirement.provider}
          logoUrl={AI_PROVIDERS[requirement.provider].logo}
          darkLogoUrl={requirement.provider === "xai" ? "/brands/adapters/grok-dark.svg" : undefined}
          size={32}
        />
        <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-semibold">{t("sep13Connections.aiConnection")}</h3>
        <p className="text-xs text-muted-foreground">
          {AI_PROVIDERS[requirement.provider].name} ·{" "}
          {aiMethodLabel(requirement.provider, requirement.method)}
        </p>
        </div>
      </div>
      {loading ? (
        <div role="status" aria-label={t("sep13Connections.loadingConnections")}>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              {t("sep13Connections.retryConnections")}
            </Button>
          )}
        </div>
      ) : (
        <>
          <ConnectionChoiceList
            disabled={readOnly}
            selectedId={value?.mode === "responsible_user" ? "responsible_user" : value?.connectionId}
            choices={[
              { id: "responsible_user", name: t("sep13Connections.responsibleConnection"), description: <>
                <span className="block">{t("sep13Connections.forYou", { connection: personalDefault?.name ?? t("sep13Connections.notConnected") })}</span>
                <span className="block">{requirement.method === "api_key" ? t("sep13Connections.othersOwnApiKey", { provider: AI_PROVIDERS[requirement.provider].name }) : t("sep13Connections.othersOwnSubscription", { provider: requirement.provider === "openai" ? "ChatGPT" : AI_PROVIDERS[requirement.provider].name })}</span>
              </> },
              ...compatible.filter((connection) => connection.ownership === "shared").map((connection) => ({
                id: connection.id, name: connection.name,
                disabled: Boolean(aiConnectionProblem(connection)),
                description: <>{t("sep13Connections.companyShared")}{connection.accountLabel ? ` · ${connection.accountLabel}` : ""}{aiConnectionProblem(connection) ? ` · ${aiConnectionProblem(connection)}` : ""}</>,
              })),
            ]}
            onSelect={(id) => {
              if (id === "responsible_user") onChange({provider: requirement.provider, method: requirement.method, mode: "responsible_user"});
              else { const connection = compatible.find((item) => item.id === id)!; select("shared", connection); }
            }}
          />
          {problem && (
            <p role="status" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              className="self-end"
              onClick={onConnect}
            >
              {t("sep13Connections.connectAnother")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
