import type { Meta, StoryObj } from "@storybook/react-vite";
import { SLACK_TOOLS, type SlackSearchStatus } from "@paperclipai/shared";
import {
  SlackCapabilitiesView,
  SlackSearchView,
} from "../../src/pages/apps/chat/SlackToolSettings";
const base: SlackSearchStatus = {
  canConfigure: true,
  configured: false,
  connected: false,
  clientId: null,
  redirectUri: "https://paperclip.example/api/slack/search/callback",
  nativeSearchAvailable: false,
  limitation:
    "This runtime uses bounded channel history search. Native search requires transient result delivery.",
};
function Preview({
  upgrade = false,
  access = false,
  connected = false,
  configured = false,
}) {
  return (
    <main className="max-w-3xl p-6 space-y-7">
      <h2 className="text-lg font-semibold">
        {access ? "Access" : "Settings"}
      </h2>
      {access ? (
        <SlackSearchView
          status={{ ...base, configured, connected }}
          onConnect={async () => {}}
          onDisconnect={async () => {}}
          onConfigure={async () => {}}
        />
      ) : (
        <SlackCapabilitiesView
          capabilities={{
            grantedScopes: [],
            missingScopes: upgrade
              ? ["pins:read", "pins:write", "canvases:write", "lists:write"]
              : [],
            tools: SLACK_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              risk: t.risk,
              available: !upgrade || t.risk === "read",
            })),
          }}
        />
      )}
    </main>
  );
}
export default {
  title: "Connections/Slack/Task tools",
  component: Preview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Preview>;
type Story = StoryObj<typeof Preview>;
export const Capabilities: Story = {};
export const UpgradePermissions: Story = { args: { upgrade: true } };
export const ConfigureSearch: Story = { args: { access: true } };
export const ConnectSearch: Story = {
  args: { access: true, configured: true },
};
export const SearchConnected: Story = {
  args: { access: true, configured: true, connected: true },
};
