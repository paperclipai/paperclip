import { Trans } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  SlackSearchStatus,
  SlackToolCapabilities,
} from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { slackToolsApi } from "@/api/slackTools";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SlackCapabilitiesView({
  capabilities,
  error,
}: {
  capabilities?: SlackToolCapabilities;
  error?: string;
}) {
  const { t } = useTranslation("connections");
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("read_search_and_act_in_slack_some_0bcddc3")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!capabilities && !error && (
        <p role="status" className="text-sm text-muted-foreground">{t("checking_slack_permissions_436ccd6")}</p>
      )}
      {capabilities && (
        <>
          {capabilities.missingScopes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">{t("add_permissions_to_unlock_more_tools_b8d22de")}</p>
              <p className="text-sm">{t("your_existing_connection_still_works_in_309485e")}{" "}
                <a
                  className="underline underline-offset-4"
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                >{t("slack_app_settings_f03249d")}</a>{t("choose_your_app_open_oauth_permissions_add_ff3f1c2")}</p>
              <p className="text-xs font-mono break-words">
                {capabilities.missingScopes.join(", ")}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function SlackSearchView({
  status,
  onConnect,
  onDisconnect,
  onConfigure,
}: {
  status: SlackSearchStatus;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onConfigure: (input: {
    clientId: string;
    clientSecret: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        describeError(e).body,
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t("your_slack_search_access_af9c7e8")}</h3>
      <p className="text-sm text-muted-foreground">{t("optional_personal_authorization_enables_private_search_on_48ce733")}</p>
      {!status.nativeSearchAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {status.limitation}
        </p>
      )}
      {status.connected ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t("slack_search_connected_f94901d")}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void perform(onDisconnect)}
          >{t("disconnect_search_c9524a6")}</Button>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !status.configured}
          onClick={() => void perform(onConnect)}
        >{t("connect_slack_search_6e9fa54")}</Button>
      )}
      {!status.configured && (
        <p className="text-sm text-muted-foreground">{t("a_connection_manager_needs_to_configure_your_e6ff0fc")}</p>
      )}
      {status.canConfigure && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("oauth_app_configuration_for_connection_managers_0e342f8")}</summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                await onConfigure({ clientId, clientSecret });
                setClientSecret("");
              });
            }}
          >
            <p className="text-sm"><Trans ns="final-pages" i18nKey="In_Slack_app_settings_add_this_redirect_URL_under_OAuth_Permissio_90d079" components={{ public: <code />, private: <code />, files: <code /> }} /></p>
            <p className="text-xs font-mono break-all">
              {status.redirectUri ?? t("configure_a_public_https_url_first_7222cef")}
            </p>
            <div className="space-y-2">
              <label htmlFor={`${id}-client`}>{t("client_id_a766cd7")}</label>
              <Input
                id={`${id}-client`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-secret`}>{t("client_secret_2c4e1ba")}</label>
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-end gap-3">
              <Button
                type="submit"
                size="sm"
                disabled={pending || !clientId || !clientSecret}
              >{t("save_oauth_configuration_d49e5f5")}</Button>
            </div>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
export function SlackToolsSettings({
  companyId,
  endpointId,
}: {
  companyId: string;
  endpointId: string;
}) {
  const query = useQuery({
    queryKey: ["slack-capabilities", companyId, endpointId],
    queryFn: () => slackToolsApi.capabilities(companyId, endpointId),
    staleTime: 60_000,
  });
  const view = useQueryView(query);
  return (
    <div className="space-y-3">
      <SlackCapabilitiesView
        capabilities={query.data}
        error={view.kind === "error" ? describeError(query.error).body : undefined}
      />

    </div>
  );
}
export function SlackSearchAccess({
  companyId,
  endpointId,
}: {
  companyId: string;
  endpointId: string;
}) {
  const { t } = useTranslation("connections");
  const query = useQuery({
    queryKey: ["slack-search", companyId, endpointId],
    queryFn: () => slackToolsApi.search(companyId, endpointId),
  });
  const authorization = useAuthorizationWindow();
  const view = useQueryView(query);
  if (view.kind === "error")
    return (
      <QueryErrorState
        error={query.error}
        action="load Slack search access"
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">{t("loading_search_access_fe058ff")}</p>
    );
  return (<>
    {authorization.fallback}
    <SlackSearchView
      status={query.data}
      onConnect={async () => {
        authorization.reserve();
        try {
          const result = await slackToolsApi.connect(companyId, endpointId);
          await authorization.open(result.url);
        } catch (error) { authorization.cancel(); throw error; }
      }}
      onDisconnect={async () => {
        await slackToolsApi.disconnect(companyId, endpointId);
        await query.refetch();
      }}
      onConfigure={async (input) => {
        await slackToolsApi.configure(companyId, endpointId, input);
        await query.refetch();
      }}
    />
  </>);
}
