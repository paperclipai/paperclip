import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CONNECTABLE_APP_DEFINITIONS,
  type AppDefinition,
  type ToolConnection,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { Browse } from "@/pages/apps/Browse";
import {
  OAuthConnectStateScreen,
  type OAuthConnectPhase,
} from "@/pages/apps/AppsConnect";
import { ReconnectCard } from "@/pages/apps/app-detail/AdvancedPanel";

/**
 * Enterpret catalog connector — design review for the setup surfaces.
 *
 * Every story renders the real production component against the real generated
 * `AppDefinition`, so the copy, artwork and method labels below are the ones
 * the connector actually ships.
 *
 * Read the first two stories together. Enterpret ships `availability.available
 * = false` because no Enterpret account has validated it, so **the unavailable
 * card is the current state** and everything after it is what the connector
 * looks like once the runbook's nine scenarios pass. The later stories are
 * labelled "after validation" for that reason; they are a design review of
 * copy, not evidence that any flow has run.
 *
 * No real sign-in, no real token, no provider call. Every value here is fake.
 */

const COMPANY_ID = "company-storybook";

const ENTERPRET = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "enterpret",
) as AppDefinition;

/** Enterpret as it will look once validation clears `availability`. */
const ENTERPRET_VALIDATED: AppDefinition = {
  ...ENTERPRET,
  availability: undefined,
};

const OAUTH_METHOD = ENTERPRET.methods.find((m) => m.key === "mcp-oauth")!;
const TOKEN_METHOD = ENTERPRET.methods.find((m) => m.key === "mcp-api-key")!;

function seededClient(entry: AppDefinition) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
      },
    },
  });
  client.setQueryData(queryKeys.apps.gallery(COMPANY_ID), { apps: [entry] });
  client.setQueryData(queryKeys.tools.applications(COMPANY_ID), {
    applications: [],
  });
  client.setQueryData(queryKeys.tools.connections(COMPANY_ID), {
    connections: [],
  });
  return client;
}

function BrowseHost({ entry }: { entry: AppDefinition }) {
  const client = useMemo(() => seededClient(entry), [entry]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-5xl p-6">
        <Browse />
      </div>
    </QueryClientProvider>
  );
}

function OAuthStateHost({
  phase,
  error,
}: {
  phase: OAuthConnectPhase;
  error?: string;
}) {
  return (
    <div className="mx-auto max-w-5xl p-6">
      <OAuthConnectStateScreen
        entry={ENTERPRET_VALIDATED}
        phase={phase}
        error={error}
        authorizationHost="oauth.enterpret.com"
        onRetry={() => undefined}
        onBack={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}

function enterpretConnection(
  overrides: Partial<ToolConnection> = {},
): ToolConnection {
  return {
    id: "connection-enterpret",
    companyId: COMPANY_ID,
    applicationId: "application-enterpret",
    name: "Enterpret",
    uid: "enterpret-storybook",
    connectionKind: "managed",
    connectionPurpose: "tool",
    ownership: "dcr",
    transport: "mcp_remote",
    authKind: "oauth",
    credentialSource: "paperclip_vault",
    credentialPolicy: "per_user",
    status: "active",
    transportConfig: { url: "https://wisdom-api.enterpret.com/server/mcp" },
    config: {
      url: "https://wisdom-api.enterpret.com/server/mcp",
      sourceTemplateKey: "enterpret",
      connectionMethodKey: "mcp-oauth",
      oauth: {
        provider: "enterpret",
        connectedAt: "2026-09-23T12:00:00.000Z",
      },
    },
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: new Date("2026-09-23T12:00:00.000Z"),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdAt: new Date("2026-09-23T11:55:00.000Z"),
    updatedAt: new Date("2026-09-23T12:00:00.000Z"),
    ...overrides,
  };
}

/** The organization auth-token method, as a saved connection. */
function tokenConnection(
  overrides: Partial<ToolConnection> = {},
): ToolConnection {
  return enterpretConnection({
    id: "connection-enterpret-token",
    ownership: "customer",
    authKind: "api_key",
    credentialPolicy: "shared",
    config: {
      url: "https://wisdom-api.enterpret.com/server/mcp",
      sourceTemplateKey: "enterpret",
      connectionMethodKey: "mcp-api-key",
    },
    // A value-free pointer. The token itself lives in the instance vault.
    credentialRefs: [
      { name: "Authorization", placement: "header", key: "Authorization", prefix: "Bearer " },
    ],
    ...overrides,
  } as Partial<ToolConnection>);
}

function ReconnectHost({ connection }: { connection: ToolConnection }) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Enterpret</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connection needs attention
        </p>
      </header>
      <ReconnectCard
        connection={connection}
        galleryEntry={ENTERPRET_VALIDATED}
        onReconnected={() => undefined}
      />
    </div>
  );
}

/**
 * The two method descriptions a reviewer is approving, rendered from the
 * generated definition rather than retyped. Warnings included, because they are
 * the only place the operator learns about the six-month token expiry and the
 * verbatim-quote exposure.
 */
function MethodCopyHost() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      {[OAUTH_METHOD, TOKEN_METHOD].map((method) => (
        <section
          key={method.key}
          className="space-y-2 rounded-lg border border-border p-4"
        >
          <h2 className="text-lg font-semibold">{method.label}</h2>
          <p className="text-sm text-muted-foreground">{method.whenToUse}</p>
          <p className="text-sm">{method.guidanceMd}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <dt>Method key</dt>
            <dd className="font-mono">{method.key}</dd>
            <dt>Ownership</dt>
            <dd className="font-mono">{method.ownershipModes.join(", ")}</dd>
            <dt>Grant identity</dt>
            <dd className="font-mono">
              {(method.grantKinds ?? []).join(", ") || "—"}
            </dd>
            <dt>Requested scopes</dt>
            <dd className="font-mono">
              {(method.defaults?.scopesHint ?? []).join(" ") || "—"}
            </dd>
            <dt>Risk tier</dt>
            <dd className="font-mono">{method.riskTier}</dd>
          </dl>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {(method.warnings ?? []).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const meta: Meta = {
  title: "Apps/Enterpret connector",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Design review for the Enterpret catalog connector using production components and the real generated definition. The connector ships unavailable until a real Enterpret account validates it, so story 1 is the current state and stories 3 onward preview the validated experience. No real sign-in, token, or provider call.",
      },
    },
  },
};
export default meta;

type Story = StoryObj;

export const BrowseUnavailable: Story = {
  name: "1 — Browse, unavailable (current state)",
  render: () => <BrowseHost entry={ENTERPRET} />,
};

export const BrowseAfterValidation: Story = {
  name: "2 — Browse, after validation",
  render: () => <BrowseHost entry={ENTERPRET_VALIDATED} />,
};

export const MethodCopy: Story = {
  name: "3 — Method copy and warnings",
  render: () => <MethodCopyHost />,
};

export const OAuthEntry: Story = {
  name: "4 — Browser sign-in, entry",
  render: () => <OAuthStateHost phase="entry" />,
};

export const OAuthStarting: Story = {
  name: "5 — Browser sign-in, in flight",
  render: () => <OAuthStateHost phase="starting" />,
};

export const OAuthError: Story = {
  name: "6 — Browser sign-in, error",
  render: () => (
    <OAuthStateHost
      phase="error"
      error="Paperclip could not reach Enterpret's authorization service. Check the connection and try again."
    />
  ),
};

export const OAuthReconnectRequired: Story = {
  name: "7 — Recovery, sign-in expired",
  render: () => (
    <ReconnectHost
      connection={enterpretConnection({
        healthStatus: "failed",
        healthMessage:
          "Enterpret authorization expired or was revoked (invalid_grant).",
        lastError: "invalid_grant",
      })}
    />
  ),
};

export const TokenExpired: Story = {
  name: "8 — Recovery, auth token expired",
  render: () => (
    <ReconnectHost
      connection={tokenConnection({
        healthStatus: "failed",
        healthMessage:
          "Enterpret rejected this auth token. Tokens expire six months after you generate them; generate a replacement in Settings, Enterpret MCP.",
        lastError: "invalid_token",
      })}
    />
  ),
};

export const BrowseUnavailableNarrow: Story = {
  name: "9 — Browse, unavailable, narrow",
  render: () => <BrowseHost entry={ENTERPRET} />,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
