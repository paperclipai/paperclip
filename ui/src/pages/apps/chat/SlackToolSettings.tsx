import { slackSearchLimitation, slackToolLabel, chatUiErrorMessage, type ChatUiError } from "./chat-copy";
import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { Link } from "react-router-dom";
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  SlackSearchStatus,
  SlackToolCapabilities,
} from "@paperclipai/shared";
import { slackToolsApi } from "@/api/slackTools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SlackCapabilitiesView({
  capabilities,
  error,
}: {
  capabilities?: SlackToolCapabilities;
  error?: string;
}) {
  useTranslation();
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t("sep28Apps.copy210")}</h3>
      <p className="text-sm">{t("sep28Apps.copy211")}</p>
      <p className="text-sm text-muted-foreground">{t("sep28Apps.copy212")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {chatUiErrorMessage(error)}
        </p>
      )}
      {!capabilities && !error && (
        <p role="status" className="text-sm text-muted-foreground">{t("sep28Apps.copy213")}</p>
      )}
      {capabilities && (
        <>
          <ul className="space-y-2 text-sm">
            <li>{t("sep28Apps.copy214")}</li>
            <li>{t("sep28Apps.copy215")}</li>
            <li>{t("sep28Apps.copy216")}</li>
          </ul>
          {capabilities.missingScopes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">{t("sep28Apps.copy217")}</p>
              <p className="text-sm">
                <Trans i18nKey="sep28Apps.slackAddScopes" components={{ settings: <a className="underline underline-offset-4" href="https://api.slack.com/apps" target="_blank" rel="noreferrer" /> }} />
              </p>
              <p className="text-xs font-mono break-words">
                {capabilities.missingScopes.join(", ")}
              </p>
            </div>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{t("sep28Apps.copy218")}</summary>
            <ul className="mt-3 divide-y divide-border">
              {capabilities.tools.map((tool) => (
                <li
                  key={tool.name}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <span>
                    {slackToolLabel(tool.name)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {tool.available === false
                      ? t("sep28Apps.copy219")
                      : tool.available === null
                        ? t("sep28Apps.copy220")
                        : tool.risk === "approval"
                          ? t("pages.apps.connect.actions.askFirst")
                          : t("runIdentityHistory.githubStatus.available")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-muted-foreground">{t("sep28Apps.copy221")}</p>
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
  useTranslation();
  const id = useId();
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ChatUiError | null>(null);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : { key: "sep28Apps.copy222" },
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t("sep28Apps.copy223")}</h3>
      <p className="text-sm text-muted-foreground">{t("sep28Apps.copy224")}</p>
      {!status.nativeSearchAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {slackSearchLimitation(status.limitation)}
        </p>
      )}
      {status.connected ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{t("sep28Apps.copy225")}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void perform(onDisconnect)}
          >{t("sep28Apps.copy226")}</Button>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={pending || !status.configured}
          onClick={() => void perform(onConnect)}
        >{t("sep28Apps.copy227")}</Button>
      )}
      {!status.configured && (
        <p className="text-sm text-muted-foreground">{t("sep28Apps.copy228")}</p>
      )}
      {status.canConfigure && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("sep28Apps.copy229")}</summary>
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
              <Trans i18nKey="sep28Apps.slackRedirectScopes" components={{ public: <code />, private: <code />, files: <code /> }} />
            </p>
            <p className="text-xs font-mono break-all">
              {status.redirectUri ?? t("sep28Apps.copy230")}
            </p>
            <div className="space-y-2">
              <label htmlFor={`${id}-client`}>{t("localizationConnections.clientID115")}</label>
              <Input
                id={`${id}-client`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-secret`}>{t("sep28Apps.copy231")}</label>
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
              >{t("sep28Apps.copy232")}</Button>
            </div>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {chatUiErrorMessage(error)}
        </p>
      )}
    </section>
  );
}
export function SlackToolsSettings({
  companyId,
  endpointId,
  connectionId,
}: {
  companyId: string;
  endpointId: string;
  connectionId?: string | null;
}) {
  useTranslation();
  const query = useQuery({
    queryKey: ["slack-capabilities", companyId, endpointId],
    queryFn: () => slackToolsApi.capabilities(companyId, endpointId),
    staleTime: 60_000,
  });
  return (
    <div className="space-y-3">
      <SlackCapabilitiesView
        capabilities={query.data}
        error={query.error?.message}
      />
      {connectionId && (
        <Link
          className="text-sm underline underline-offset-4"
          to={`/apps/${connectionId}/permissions`}
        >{t("sep28Apps.copy233")}</Link>
      )}
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
  useTranslation();
  const query = useQuery({
    queryKey: ["slack-search", companyId, endpointId],
    queryFn: () => slackToolsApi.search(companyId, endpointId),
  });
  if (query.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {query.error.message}
      </p>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">{t("sep28Apps.copy234")}</p>
    );
  return (
    <SlackSearchView
      status={query.data}
      onConnect={async () => {
        const result = await slackToolsApi.connect(companyId, endpointId);
        window.location.assign(result.url);
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
  );
}
