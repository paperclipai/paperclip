import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isProvisionedSlackSetup,
  type SlackSearchStatus,
  type SlackSetupMethod,
  type SlackToolCapabilities,
} from "@paperclipai/shared";
import { slackToolsApi } from "@/api/slackTools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SlackCapabilitiesView({
  capabilities,
  error,
  setupMethod,
  onReconnect,
}: {
  capabilities?: SlackToolCapabilities;
  error?: string;
  setupMethod?: SlackSetupMethod;
  onReconnect?: () => void;
}) {
  const isProvisioned = isProvisionedSlackSetup(setupMethod);
  const missingScopes = isProvisioned
    ? capabilities?.missingScopes.filter((scope) => scope !== "im:write") ?? []
    : capabilities?.missingScopes ?? [];
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Read, search, and act in Slack. Some actions require approval.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!capabilities && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking Slack permissions…
        </p>
      )}
      {capabilities && (
        <>
          {isProvisioned && capabilities.dmReconnectRequired && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">
                Reconnect Slack to grant DM permission
              </p>
              <p className="text-sm">
                This agent&apos;s Slack app was installed before direct messages became
                standard, so slack_open_dm will fail until you reconnect.
              </p>
              {onReconnect && (
                <Button type="button" size="sm" variant="outline" onClick={onReconnect}>
                  Reconnect Slack
                </Button>
              )}
            </div>
          )}
          {capabilities.missingGroups && capabilities.missingGroups.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">
                Slack permission groups
              </p>
              <p className="text-sm">
                Your existing connection still works. Complete the steps below
                to unlock more tools.
              </p>
              <ul className="space-y-1 text-sm">
                {capabilities.missingGroups.map((missing) => (
                  <li key={missing.group}>
                    <span className="font-medium">{missing.label}</span>
                    {" — "}
                    {missing.description}{" "}
                    {missing.action === "reconnect"
                      ? "This group is already requested. Please reconnect this agent's Slack app to grant it."
                      : "Turn on this group in this agent's Slack setup, then reconnect so Slack grants it."}
                    {" "}Unlocks{" "}
                    <span className="font-mono text-xs">
                      {missing.toolNames.join(", ")}
                    </span>
                    .
                  </li>
                ))}
              </ul>
            </div>
          )}
          {missingScopes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted p-3 space-y-2">
              <p className="text-sm font-medium">
                Add permissions to unlock more tools
              </p>
              <p className="text-sm">
                Your existing connection still works. In{" "}
                <a
                  className="underline underline-offset-4"
                  href="https://api.slack.com/apps"
                  target="_blank"
                  rel="noreferrer"
                >
                  Slack app settings
                </a>
                , choose your app, open OAuth &amp; Permissions, add these Bot
                Token Scopes, then reinstall the app to your workspace.
              </p>
              <p className="text-xs font-mono break-words">
                {missingScopes.join(", ")}
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
  onConnect: (options: { includeDms: boolean }) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onConfigure: (input: {
    clientId: string;
    clientSecret: string;
  }) => Promise<void>;
}) {
  const id = useId();
  const [clientId, setClientId] = useState(status.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [includeDms, setIncludeDms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to update Slack search",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">Your Slack search access</h3>
      <p className="text-sm text-muted-foreground">
        Optional personal authorization enables private search on supported
        runtimes. It cannot read channels the bot hasn’t joined or let the bot
        write as you. Basic channel reading works without it.
      </p>
      {!status.nativeSearchAvailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {status.limitation}
        </p>
      )}
      {status.connected ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">Slack search connected</span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => void perform(onDisconnect)}
            >
              Disconnect search
            </Button>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {status.dmAccess
                ? "Agents can read your direct messages and group DMs"
                : "Agents cannot read your direct messages"}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() =>
                void perform(() => onConnect({ includeDms: !status.dmAccess }))
              }
            >
              {status.dmAccess ? "Stop DM reading" : "Allow DM reading"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Changing this sends you to Slack to approve the new permissions.
            Turning it off stops Paperclip from reading your DMs; to remove
            the permission from Slack itself, revoke the app’s access in your
            Slack account.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {status.linked === false && (
            <p className="text-sm text-muted-foreground">
              Your Slack account isn’t linked to this connection yet.
              Connecting Slack search will sign you in to Slack and link it.
            </p>
          )}
          <div className="flex items-start gap-2">
            <input
              id={`${id}-dms`}
              type="checkbox"
              className="mt-1"
              checked={includeDms}
              disabled={pending || !status.configured}
              onChange={(e) => setIncludeDms(e.target.checked)}
            />
            <label htmlFor={`${id}-dms`} className="text-sm">
              Also let agents read my direct messages and group DMs
              <span className="block text-xs text-muted-foreground">
                Off by default. Agents working on your tasks could read any of
                your DMs, and what they read is kept in their run records.
                Only in tasks you start from a DM with the bot or from
                Paperclip, never from a channel. After reading your DMs, an
                agent can reply in Slack only in your own DM with the bot.
                Slack asks you to approve this separately. You can turn it off
                any time.
              </span>
            </label>
          </div>
          <Button
            variant="outline"
            disabled={pending || !status.configured}
            onClick={() => void perform(() => onConnect({ includeDms }))}
          >
            Connect Slack search
          </Button>
        </div>
      )}
      {!status.configured && (
        <p className="text-sm text-muted-foreground">
          A connection manager needs to configure your Slack app’s OAuth
          credentials first.
        </p>
      )}
      {status.canConfigure && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            OAuth app configuration for connection managers
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
              In Slack app settings, add this redirect URL under OAuth &amp;
              Permissions. Add user scopes <code>search:read.public</code>,{" "}
              <code>search:read.private</code> and{" "}
              <code>search:read.files</code>. To let people opt in to DM
              reading, also add <code>im:history</code>,{" "}
              <code>im:read</code>, <code>mpim:history</code> and{" "}
              <code>mpim:read</code>. Find Client ID and Client Secret under
              Basic Information.
            </p>
            <p className="text-xs font-mono break-all">
              {status.redirectUri ?? "Configure a public HTTPS URL first."}
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
                Save OAuth configuration
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
  setupMethod,
  onReconnect,
}: {
  companyId: string;
  endpointId: string;
  setupMethod?: SlackSetupMethod;
  onReconnect?: () => void;
}) {
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
        setupMethod={setupMethod}
        onReconnect={onReconnect}
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
      <p role="status" className="text-sm text-muted-foreground">
        Loading search access…
      </p>
    );
  return (
    <SlackSearchView
      status={query.data}
      onConnect={async (options) => {
        const result = await slackToolsApi.connect(companyId, endpointId, options);
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
