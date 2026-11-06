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
import { useTranslation } from "@/i18n";

export function SlackCapabilitiesView({
  capabilities,
  error,
}: {
  capabilities?: SlackToolCapabilities;
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("apps.SlackCapabilitiesView.description")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!capabilities && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("apps.SlackCapabilitiesView.checking")}
        </p>
      )}
      {capabilities && (
        <>
          {capabilities.missingScopes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">
                {t("apps.SlackCapabilitiesView.addPermissions")}
              </p>
              <p className="text-sm">
                {t("apps.SlackCapabilitiesView.scopesPrefix")}{" "}
                <a
                  className="underline underline-offset-4"
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("apps.SlackCapabilitiesView.slackAppSettings")}
                </a>
                {t("apps.SlackCapabilitiesView.scopesSuffix")}
              </p>
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
  const { t } = useTranslation();
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
      <h3 className="text-sm font-semibold">{t("apps.SlackSearchView.title")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("apps.SlackSearchView.description")}
      </p>
      {!status.nativeSearchAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {status.limitation}
        </p>
      )}
      {status.connected ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t("apps.SlackSearchView.connected")}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void perform(onDisconnect)}
          >
            {t("apps.SlackSearchView.disconnect")}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !status.configured}
          onClick={() => void perform(onConnect)}
        >
          {t("apps.SlackSearchView.connect")}
        </Button>
      )}
      {!status.configured && (
        <p className="text-sm text-muted-foreground">
          {t("apps.SlackSearchView.needsConfig")}
        </p>
      )}
      {status.canConfigure && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t("apps.SlackSearchView.oauthSummary")}
          </summary>
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
            <p className="text-sm">
              {t("apps.SlackSearchView.oauthHelpIntro")} <code>search:read.public</code>, <code>search:read.private</code> {t("apps.SlackSearchView.and")} <code>search:read.files</code>{t("apps.SlackSearchView.oauthHelpEnd")}
            </p>
            <p className="text-xs font-mono break-all">
              {status.redirectUri ?? t("apps.SlackSearchView.configureHttps")}
            </p>
            <div className="space-y-2">
              <label htmlFor={`${id}-client`}>Client ID</label>
              <Input
                id={`${id}-client`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-secret`}>Client Secret</label>
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
              >
                {t("apps.SlackSearchView.saveConfig")}
              </Button>
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
  const { t } = useTranslation();
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
        action={t("apps.SlackSearchAccess.loadAction")}
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t("apps.SlackSearchAccess.loading")}
      </p>
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
