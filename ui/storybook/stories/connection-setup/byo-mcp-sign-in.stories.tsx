import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS, type AppDefinition } from "@paperclipai/shared";
import {
  ConnectionAccessDefaults,
  connectionDefaultSummarySentence,
  StepHeader,
} from "@/features/connections/ConnectionSetupFlow";
import { GenericMcpConnectStep } from "@/features/connections/GenericMcpConnectStep";
import {
  endpointHost,
  genericConnectGuidance,
  newCustomHeaderRow,
  type CustomHeaderRow,
  type GenericConnectGuidance,
  type GenericMcpAuthMode,
} from "@/pages/apps/generic-mcp-connect";

/**
 * Connect your own MCP server: how the server signs in.
 *
 * The shipped sign-in section of the pasted-address connect step. Every story
 * is live: switch options, type values, and watch the summary line and the
 * primary action respond.
 */

type ConnectionGrantKind = ComponentProps<typeof ConnectionAccessDefaults>["grantKind"];

const AGENTS = [
  { id: "agent-ceo", name: "Avery", title: "CEO", icon: null },
  { id: "agent-eng", name: "Jordan", title: "Engineer", icon: null },
  { id: "agent-ops", name: "Riley", title: "Operations", icon: null },
];

const NOTION = CONNECTABLE_APP_DEFINITIONS.find((entry) => entry.slug === "notion") as AppDefinition | undefined;

function header(name: string, value: string): CustomHeaderRow {
  return { ...newCustomHeaderRow(), name, value };
}

interface Scenario {
  link?: string;
  authMode?: GenericMcpAuthMode;
  open?: boolean;
  needsKey?: boolean;
  keyValue?: string;
  headers?: CustomHeaderRow[];
  oauthClientId?: string;
  oauthClientSecret?: string;
  guidance?: GenericConnectGuidance | null;
  matchedEntry?: AppDefinition | null;
  submitting?: boolean;
}

function Screen({
  link = "http://127.0.0.1:8848/mcp",
  authMode: initialAuthMode = "auto",
  open: initialOpen = false,
  needsKey: initialNeedsKey = false,
  keyValue: initialKey = "",
  headers: initialHeaders,
  oauthClientId: initialClientId = "",
  oauthClientSecret: initialClientSecret = "",
  guidance: initialGuidance = null,
  matchedEntry = null,
  submitting: initialSubmitting = false,
}: Scenario) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [authMode, setAuthMode] = useState(initialAuthMode);
  const [open, setOpen] = useState(initialOpen);
  const [needsKey, setNeedsKey] = useState(initialNeedsKey);
  const [keyValue, setKeyValue] = useState(initialKey);
  const [headers, setHeaders] = useState<CustomHeaderRow[]>(() => initialHeaders ?? [newCustomHeaderRow()]);
  const [clientId, setClientId] = useState(initialClientId);
  const [clientSecret, setClientSecret] = useState(initialClientSecret);
  const [guidance, setGuidance] = useState(initialGuidance);
  const [submitting, setSubmitting] = useState(initialSubmitting);
  const [grantKind, setGrantKind] = useState<ConnectionGrantKind>("organization");
  const [installChoice, setInstallChoice] = useState<"specific" | "all">("all");
  const [installAgentIds, setInstallAgentIds] = useState<Set<string>>(() => new Set());

  const authKind = authMode === "none" ? "none" : authMode === "oauth" ? "oauth" : "api_key";

  return (
    <QueryClientProvider client={client}>
      <div className="max-w-5xl p-6">
        <StepHeader
          subtitle="Step 2 of 2"
          step="key"
          activeIndex={1}
          labels={["Pick app", "Connect"]}
          unverifiedHost={endpointHost(link)}
          onCancel={() => {}}
        />
        <GenericMcpConnectStep
          link={link}
          name=""
          needsKey={needsKey}
          keyValue={keyValue}
          onKeyChange={setKeyValue}
          authMode={authMode}
          onAuthModeChange={(next) => {
            // Mirrors the page: an explicit choice replaces the probed answer.
            setAuthMode(next);
            setGuidance(null);
            if (next !== "auto") setNeedsKey(false);
            if (next !== "bearer" && next !== "auto") setKeyValue("");
          }}
          headers={headers}
          onHeadersChange={(next) => {
            setHeaders(next);
            setGuidance(null);
          }}
          oauthClientId={clientId}
          onOAuthClientIdChange={setClientId}
          oauthClientSecret={clientSecret}
          onOAuthClientSecretChange={setClientSecret}
          advancedOpen={open}
          onAdvancedOpenChange={setOpen}
          guidance={guidance}
          matchedEntry={matchedEntry}
          onUseMatchedEntry={matchedEntry ? () => {} : undefined}
          submitting={submitting}
          defaults={
            <ConnectionAccessDefaults
              companyId="company-storybook"
              agents={AGENTS}
              sentence={connectionDefaultSummarySentence({
                grantKind,
                authKind,
                installChoice,
                installCount: installAgentIds.size,
              })}
              authKind={authKind}
              grantKind={grantKind}
              setGrantKind={setGrantKind}
              installChoice={installChoice}
              setInstallChoice={setInstallChoice}
              installAgentIds={installAgentIds}
              setInstallAgentIds={setInstallAgentIds}
              capabilities={{ canCreateOrganizationGrant: true, canSetCompanyInstall: true }}
              disabled={submitting}
            />
          }
          onBack={() => {}}
          onConnect={() => {
            setGuidance(null);
            setSubmitting(true);
            window.setTimeout(() => setSubmitting(false), 1500);
          }}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  id: "byo-mcp-sign-in",
  title: "Apps, channels, and extensions/Connection setup/Apps/Connect your own MCP server — sign-in",
  component: Screen,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Sign-in section for a pasted MCP server address. The choice is a stated default with a Change control, matching the access line below it. Each option keeps its fields directly beneath it. Fixture state only; Check link simulates a short wait.",
      },
    },
    paperclip: {
      "capabilities": [
        "connection-setup/identity-and-access"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Renders the production GenericMcpConnectStep used by the Apps connect route for a pasted MCP server address, with fixture state and a simulated Check link wait."
    },
  },
} satisfies Meta<typeof Screen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "1. Default — nothing to decide" };

export const Choosing: Story = {
  name: "2. Change — all five options",
  args: { open: true },
};

export const KeyOrToken: Story = {
  name: "3. Key or token",
  args: { open: true, authMode: "bearer" },
};

export const BrowserSignIn: Story = {
  name: "4. Browser sign-in",
  args: { open: true, authMode: "oauth", link: "https://mcp.example.com/mcp" },
};

export const BrowserSignInOwnClient: Story = {
  name: "5. Browser sign-in — your own client ID",
  args: {
    open: true,
    authMode: "oauth",
    link: "https://mcp.example.com/mcp",
    oauthClientId: "paperclip-prod-7f3a",
    oauthClientSecret: "example-secret",
  },
};

export const CustomHeaders: Story = {
  name: "6. Custom headers",
  args: {
    open: true,
    authMode: "custom_headers",
    headers: [header("X-Api-Key", "example-value"), header("X-Workspace", "acme")],
  },
};

export const CustomHeadersError: Story = {
  name: "7. Custom headers — rejected header",
  args: {
    open: true,
    authMode: "custom_headers",
    headers: [header("X-Api-Key", "example-value"), header("x-api-key", "another")],
  },
};

export const NoSignIn: Story = {
  name: "8. No sign-in needed",
  args: { open: true, authMode: "none" },
};

export const ChoiceCollapsed: Story = {
  name: "9. A choice, collapsed",
  args: {
    authMode: "custom_headers",
    headers: [header("X-Api-Key", "example-value"), header("X-Workspace", "acme")],
  },
};

export const ServerAskedForKey: Story = {
  name: "10. After checking — the server wants a credential",
  args: {
    open: true,
    needsKey: true,
    link: "https://mcp.example.com/mcp",
    guidance: genericConnectGuidance("oauth_challenge", null),
  },
};

export const ServerNeedsOwnClient: Story = {
  name: "11. After checking — register Paperclip first",
  args: {
    open: true,
    authMode: "oauth",
    link: "https://mcp.example.com/mcp",
    guidance: genericConnectGuidance("oauth_manual_client_required", null),
  },
};

export const Unreachable: Story = {
  name: "12. After checking — nothing answered",
  args: { guidance: genericConnectGuidance("runtime_error", null) },
};

export const KnownApp: Story = {
  name: "13. Address matches a listed app",
  args: { link: "https://mcp.notion.com/mcp", matchedEntry: NOTION ?? null },
};

export const Checking: Story = {
  name: "14. Checking",
  args: { submitting: true },
};
