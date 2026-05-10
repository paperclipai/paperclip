// Static rendering of every OAuth UI scenario captured for the PR review.
//
// Reachable only in dev (`import.meta.env.DEV`) at `/tests/screenshots/oauth-ui`.
// The Playwright spec under `tools/oauth-ui-screenshots/capture.ts` boots the
// vite dev server, navigates here, and screenshots each `<section data-screenshot-id>`.
//
// The components we care about (ProviderTile / ConnectionDrawer / EnvVarEditor)
// are rendered against in-memory fixtures — there is no fetching here, no
// router state, and no toast/breadcrumb plumbing. Anything that would
// normally require backend/context wiring is stubbed locally.

import type { ReactNode } from "react";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { AlertTriangle, Plug } from "lucide-react";

import { ProviderTile } from "../settings/connections/ProviderTile";
import { EnvVarEditor } from "@/components/EnvVarEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type {
  ConnectionSummary,
  ProviderSummary,
} from "../settings/connections/api";
import { connectionsStrings as t } from "../settings/connections/strings";

const PROVIDER_FIXTURES: Record<string, ProviderSummary> = {
  github: {
    id: "github",
    displayName: "GitHub",
    scopesDefault: ["repo", "read:user"],
    scopesOffered: ["repo", "read:user", "workflow"],
  },
  slack: {
    id: "slack",
    displayName: "Slack",
    scopesDefault: ["chat:write"],
    scopesOffered: ["chat:write", "channels:read", "users:read"],
  },
  google: {
    id: "google",
    displayName: "Google",
    scopesDefault: ["openid", "email"],
    scopesOffered: ["openid", "email", "profile", "calendar"],
  },
  notion: {
    id: "notion",
    displayName: "Notion",
    scopesDefault: [],
    scopesOffered: [],
  },
};

const ACTIVE_GITHUB_CONNECTION: ConnectionSummary = {
  id: "conn-1",
  providerId: "github",
  status: "active",
  accountId: "42",
  accountLabel: "octocat",
  scopes: ["repo", "read:user"],
  accessTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 30).toISOString(),
  lastRefreshedAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
};

const ACTIVE_SLACK_CONNECTION: ConnectionSummary = {
  id: "conn-2",
  providerId: "slack",
  status: "active",
  accountId: "T1234",
  accountLabel: "team-paperclip",
  scopes: ["chat:write"],
  accessTokenExpiresAt: null,
  lastRefreshedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  lastError: null,
  lastErrorAt: null,
  refreshAttemptCount: 0,
};

function FixtureFrame({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      data-screenshot-id={id}
      className="space-y-3 rounded-xl border border-border bg-background p-6 shadow-sm"
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {id}
        </div>
        <div className="text-sm font-semibold">{title}</div>
      </div>
      <div>{children}</div>
    </section>
  );
}

function ConnectionsPageMock({
  providers,
  connections,
  role = "admin",
}: {
  providers: ProviderSummary[];
  connections: ConnectionSummary[];
  role?: "admin" | "member";
}) {
  const byProvider = new Map(connections.map((c) => [c.providerId, c]));
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t.title}</h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t.subtitle}</p>
      </div>
      {providers.length === 0 ? (
        <Card className="gap-2 px-6 py-8 text-center">
          <div className="text-base font-semibold">{t.noProvidersTitle}</div>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            {t.noProvidersBody}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {providers.map((provider) => (
            <ProviderTile
              key={provider.id}
              provider={provider}
              connection={byProvider.get(provider.id) ?? null}
              role={role}
              onConnect={() => {}}
              onManage={() => {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatDateTime(value: string | null): string {
  if (!value) return "never";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  } catch {
    return value;
  }
}

function statusVariant(status: ConnectionSummary["status"]) {
  switch (status) {
    case "active":
      return "secondary" as const;
    case "revoked":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

// Inline replica of ConnectionDrawer's content so the screenshot captures
// the populated panel without a Radix portal overlay.
function DrawerInline({
  connection,
  showConfirm = false,
}: {
  connection: ConnectionSummary;
  showConfirm?: boolean;
}) {
  return (
    <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-background p-4 shadow-lg">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-base font-semibold">
          <span className="capitalize">{connection.providerId}</span>
          <Badge variant={statusVariant(connection.status)} className="capitalize">
            {connection.status}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {connection.accountLabel ?? connection.accountId ?? "OAuth connection details"}
        </p>
      </div>
      <div className="space-y-3">
        <DetailRow label="Account">
          {connection.accountLabel ?? connection.accountId ?? "—"}
        </DetailRow>
        <DetailRow label="Account ID">
          <code className="font-mono text-xs">{connection.accountId ?? "—"}</code>
        </DetailRow>
        <DetailRow label="Scopes">
          <div className="flex flex-wrap gap-1">
            {connection.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-mono text-[11px]">
                {scope}
              </Badge>
            ))}
          </div>
        </DetailRow>
        <DetailRow label="Access token expires">
          {formatDateTime(connection.accessTokenExpiresAt)}
        </DetailRow>
        <DetailRow label="Last refreshed">
          {formatDateTime(connection.lastRefreshedAt)}
        </DetailRow>
        <DetailRow label="Refresh attempts">{connection.refreshAttemptCount}</DetailRow>
        {connection.lastError ? (
          <>
            <Separator />
            <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <div className="flex items-center gap-2 text-xs font-medium text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" />
                Last error
              </div>
              <code className="block text-xs text-destructive">{connection.lastError}</code>
              {connection.lastErrorAt ? (
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(connection.lastErrorAt)}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <Separator />
      {showConfirm ? (
        <div className="space-y-2">
          <p className="text-sm text-destructive">
            Disconnecting will break agents currently bound to this connection.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm">
              Cancel
            </Button>
            <Button variant="destructive" size="sm">
              Confirm
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm">
            {t.refreshNow}
          </Button>
          <Button variant="destructive" size="sm">
            {t.disconnect}
          </Button>
        </div>
      )}
    </div>
  );
}

const SAMPLE_SECRETS: CompanySecret[] = [
  {
    id: "sec-1",
    companyId: "c1",
    key: "STRIPE_KEY",
    name: "STRIPE_KEY",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 3,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

const SAMPLE_ENV: Record<string, EnvBinding> = {
  GH_TOKEN: { type: "oauth_token", connectionId: "conn-1", field: "access" },
  STRIPE_KEY: { type: "secret_ref", secretId: "sec-1" },
  LOG_LEVEL: { type: "plain", value: "info" },
};

export function OauthUiScreenshots() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">OAuth UI screenshots</h1>
        <p className="text-sm text-muted-foreground">
          Static fixtures for PR review. Each section is captured by
          <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-xs">
            tools/oauth-ui-screenshots/capture.ts
          </code>
          via Playwright.
        </p>
      </header>

      <FixtureFrame id="01-empty-state" title="No providers configured">
        <ConnectionsPageMock providers={[]} connections={[]} />
      </FixtureFrame>

      <FixtureFrame
        id="02-providers-no-connections"
        title="Providers configured, no connections"
      >
        <ConnectionsPageMock
          providers={[
            PROVIDER_FIXTURES.github,
            PROVIDER_FIXTURES.slack,
            PROVIDER_FIXTURES.google,
            PROVIDER_FIXTURES.notion,
          ]}
          connections={[]}
        />
      </FixtureFrame>

      <FixtureFrame id="03-active-connection" title="Mixed: active + available">
        <ConnectionsPageMock
          providers={[
            PROVIDER_FIXTURES.github,
            PROVIDER_FIXTURES.slack,
            PROVIDER_FIXTURES.google,
            PROVIDER_FIXTURES.notion,
          ]}
          connections={[
            ACTIVE_GITHUB_CONNECTION,
            { ...ACTIVE_SLACK_CONNECTION, status: "error", lastError: "refresh_token_invalid" },
          ]}
        />
      </FixtureFrame>

      <FixtureFrame id="04-drawer-active" title="Connection detail drawer (active)">
        <DrawerInline connection={ACTIVE_GITHUB_CONNECTION} />
      </FixtureFrame>

      <FixtureFrame
        id="05-drawer-disconnect-confirm"
        title="Disconnect confirmation"
      >
        <DrawerInline connection={ACTIVE_GITHUB_CONNECTION} showConfirm />
      </FixtureFrame>

      <FixtureFrame
        id="06-envvar-oauth-binding"
        title="Env var editor — OAuth token source"
      >
        <div className="rounded-xl border border-border bg-card p-4">
          <EnvVarEditor
            value={SAMPLE_ENV}
            secrets={SAMPLE_SECRETS}
            oauthConnections={[ACTIVE_GITHUB_CONNECTION, ACTIVE_SLACK_CONNECTION]}
            onCreateSecret={() => {
              throw new Error("not used");
            }}
            onChange={() => {}}
          />
        </div>
      </FixtureFrame>
    </div>
  );
}
