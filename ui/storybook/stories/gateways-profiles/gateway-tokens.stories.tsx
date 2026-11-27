import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ToolMcpGatewayToken,
  ToolMcpGatewayWithTokens,
} from "@paperclipai/shared";
import {
  toolMcpGatewayAuthConfigSchema,
  toolMcpGatewayHeaderPolicySchema,
  toolMcpGatewayMetadataPolicySchema,
  toolMcpGatewayOnDemandToolsConfigSchema,
} from "@paperclipai/shared";
import { expect, userEvent, within } from "storybook/test";
import { toolsApi } from "@/api/tools";
import { TokensPanel } from "@/pages/apps/gateways/panels/TokensPanel";
import { gatewaysQueryKey } from "@/pages/apps/gateways/NewGatewayDialog";
import { ToastViewport } from "@/components/ToastViewport";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const token: ToolMcpGatewayToken = {
  id: "token-gap",
  companyId: "company-storybook",
  gatewayId: "gateway-gap",
  name: "Preview client",
  tokenPrefix: "pcgw_fixture",
  subjectType: "gateway_client",
  subjectId: null,
  clientLabel: "Preview client",
  ownerNote: "Local preview",
  allowedActions: ["tools/list", "tools/call"],
  expiresAt: "2099-12-01T00:00:00Z",
  expiryOverrideReason: null,
  expiryOverrideByUserId: null,
  expiryOverrideByAgentId: null,
  expiryOverrideAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdByAgentId: null,
  createdByUserId: "user-storybook",
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
};
const gateway: ToolMcpGatewayWithTokens = {
  id: "gateway-gap",
  companyId: "company-storybook",
  gatewayPublicId: "preview-gateway",
  name: "Preview gateway",
  displaySlug: "preview",
  slug: "preview",
  description: null,
  status: "active",
  profileId: "profile-gap",
  defaultProfileMode: "gateway_only",
  contextScopeType: "none",
  contextScopeId: null,
  agentId: null,
  projectId: null,
  issueId: null,
  approvalIssueId: null,
  endpointPath: "/g/preview/mcp",
  authConfig: toolMcpGatewayAuthConfigSchema.parse({}),
  headerPolicy: toolMcpGatewayHeaderPolicySchema.parse({}),
  metadataPolicy: toolMcpGatewayMetadataPolicySchema.parse({}),
  onDemandToolsConfig: toolMcpGatewayOnDemandToolsConfigSchema.parse({}),
  metadata: null,
  createdByAgentId: null,
  createdByUserId: "user-storybook",
  archivedAt: null,
  createdAt: new Date("2026-10-12"),
  updatedAt: new Date("2026-10-12"),
  tokens: [token],
  clientSnippets: [],
};
function Tokens() {
  const query = useQuery({
    queryKey: gatewaysQueryKey("company-storybook"),
    queryFn: () => toolsApi.listGateways("company-storybook"),
  });
  if (!query.data) return null;
  return (
    <>
      <TokensPanel
        companyId="company-storybook"
        gateway={query.data.gateways[0]}
      />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-gateway-tokens",
  title:
    "Apps, channels, and extensions/Tool gateways and access profiles/Named gateway tokens",
  component: Tokens,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "gateways-profiles/tokens"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Named, empty and expired token history; issuance pending/error/403/success and name-confirmed revocation. Tokens are fictional; real bearer expiry, scope and revocation need API verification."
    },
  },
  beforeEach: ({ parameters }) => {
    let current = {
      ...gateway,
      tokens: parameters.empty
        ? []
        : [
            {
              ...token,
              expiresAt: parameters.expired
                ? "2020-01-01T00:00:00Z"
                : token.expiresAt,
            },
          ],
    };
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/tools/gateways",
          read: () => ({ gateways: [current] }),
        },
        {
          path: "/api/tool-gateway/gateways/gateway-gap/tokens",
          method: "POST",
          read: ({ body }) => {
            const created = {
              ...token,
              id: "issued-token",
              name: String(body.name),
              clientLabel: String(body.name),
              ownerNote: String(body.ownerNote),
              expiresAt: String(body.expiresAt),
            };
            current = { ...current, tokens: [created, ...current.tokens] };
            return { ...created, token: "pcgw_storybook_fixture_only" };
          },
        },
        {
          path: "/api/tool-gateway/gateway-tokens/token-gap/revoke",
          method: "POST",
          read: () => {
            const revoked = { ...token, revokedAt: "2026-10-13T12:00:00Z" };
            current = {
              ...current,
              tokens: current.tokens.map((row) =>
                row.id === token.id ? revoked : row,
              ),
            };
            return revoked;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof Tokens>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ActiveToken: Story = {};
export const NoTokens: Story = { parameters: { empty: true } };
export const ExpiredToken: Story = { parameters: { expired: true } };
async function issue(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("button", { name: "Issue token" }));
  await userEvent.clear(c.getByRole("textbox", { name: /Token name/ }));
  await userEvent.type(
    c.getByRole("textbox", { name: /Token name/ }),
    "Review client",
    { delay: 15 },
  );
  await userEvent.click(
    within(canvasElement.querySelector("form")!).getByRole("button", {
      name: "Issue token",
    }),
  );
}
export const IssuedToken: Story = {
  play: async ({ canvasElement }) => {
    await issue(canvasElement);
    await within(document.body).findByText("Token issued");
    await within(canvasElement).findByText("pcgw_storybook_fixture_only");
  },
};
export const Issuing: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    await issue(canvasElement);
    await expect(
      await within(canvasElement).findByRole("button", { name: "Issuing…" }),
    ).toBeDisabled();
  },
};
export const IssueFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await issue(canvasElement);
    await within(document.body).findByText("Token was not issued");
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "mutation-permission" },
  play: async ({ canvasElement }) => {
    await issue(canvasElement);
    await within(document.body).findByText(
      "You do not have permission to perform this action.",
    );
  },
};
export const RevokeToken: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: /Token history/ }),
    );
    await userEvent.click(await c.findByRole("button", { name: "Revoke" }));
    await userEvent.type(
      c.getByPlaceholderText("Preview client"),
      "Preview client",
      { delay: 15 },
    );
    await userEvent.click(c.getByRole("button", { name: "Revoke token" }));
    await within(document.body).findByText("Token revoked");
  },
};
