import { PluginSettings } from "@/pages/PluginSettings";
import { PluginManager } from "@/pages/PluginManager";
import { installPluginFixtures } from "../../support/capability-gaps/plugins";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { PluginPage } from "@/pages/PluginPage";
import { registerPluginReactComponent } from "@/plugins/slots";
import { within } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function Contribution() {
  return (
    <Routes>
      <Route
        path="/PAP/company/settings/instance/plugins/:pluginId"
        element={<PluginSettings />}
      />
      <Route
        path="/PAP/company/settings/instance/plugins"
        element={<PluginManager />}
      />
      <Route path="/PAP/plugins/:pluginId" element={<PluginPage />} />
    </Routes>
  );
}
function FixturePluginContent() {
  return <p>Isolated plugin contribution</p>;
}
const meta = {
  id: "feature-plugin-contributions",
  title: "Apps, channels, and extensions/Plugins/Contributed routes",
  component: Contribution,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/plugins/contribution-gap"],
    paperclip: {
      "capabilities": [
        "plugins/contributions"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production PluginPage host with a registered fixture plugin component; pending/missing contribution and discovery failure. Discovery failure currently remains Loading; contribution contents are a fixture, not shipped plugin code."
    },
  },
  beforeEach: ({ parameters }) => {
    registerPluginReactComponent(
      "storybook.contribution",
      "FixturePluginContent",
      FixturePluginContent,
    );
    const baseCleanup = installPluginFixtures(
      "ready",
      false,
      "contribution-gap",
    );
    const fixture = prepareFixtureApi(
      [
        {
          path: "/api/plugins/ui-contributions",
          read: () =>
            parameters.empty
              ? []
              : [
                  {
                    pluginId: "contribution-gap",
                    pluginKey: "storybook.contribution",
                    displayName: "Preview contribution",
                    version: "1.0.0",
                    uiEntryFile: "fixture.js",
                    slots: [
                      {
                        type: "page",
                        id: "fixture-page",
                        displayName: "Preview",
                        exportName: "FixturePluginContent",
                        routePath: "fixture",
                      },
                    ],
                    launchers: [],
                  },
                ],
        },
      ],
      parameters.fixtureState as FixtureState,
    );
    return () => {
      fixture.cleanup();
      baseCleanup();
    };
  },
} satisfies Meta<typeof Contribution>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MountedContribution: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Isolated plugin contribution");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const MissingContribution: Story = { parameters: { empty: true } };
export const DiscoveryFailure: Story = {
  parameters: {
    fixtureState: "failure",
    docs: {
      description: {
        story:
          "Current production PluginPage retains its Loading state after contribution discovery fails. This exposes a product error-state gap; it is not a passing failure UX.",
      },
    },
  },
};
