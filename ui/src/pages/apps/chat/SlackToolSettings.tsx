import { Link } from "react-router-dom";
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
          {capabilities.missingScopes.length > 0 && (
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
      ) : (
        <Button
          variant="outline"
          disabled={pending || !status.configured}
          onClick={() => void perform(onConnect)}
        >
          Connect Slack search
        </Button>
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
              <code>search:read.files</code>. Find Client ID and Client Secret
              under Basic Information.
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
  connectionId,
}: {
  companyId: string;
  endpointId: string;
  connectionId?: string | null;
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
      {connectionId && (
        <Link
          className="text-sm underline underline-offset-4"
          to={`/apps/${connectionId}/permissions`}
        >
          Manage action permissions
        </Link>
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
  const query = useQuery({
    queryKey: ["slack-search", companyId, endpointId],
    queryFn: () => slackToolsApi.search(companyId, endpointId),
  });
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
      <p role="status" className="text-sm text-muted-foreground">
        Loading search access…
      </p>
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
