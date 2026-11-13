import type { Meta, StoryObj } from "@storybook/react-vite";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Sidebar } from "@/components/Sidebar";
import { expect, userEvent, within, waitFor } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function SidebarPreferences() {
  return (
    <PluginLauncherProvider>
      <Sidebar />
    </PluginLauncherProvider>
  );
}
const meta = {
  id: "feature-sidebar-preferences",
  title:
    "Oversight and operation/Navigation, profile, and announcements/Sidebar preferences",
  component: SidebarPreferences,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Production sidebar with isolated saved order responses. Section collapse is session-local; recents are browser-local. No server persistence is claimed.",
      },
    },
    paperclip: {
      "capabilities": [
        "navigation-preferences/preferences"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production Sidebar inside PluginLauncherProvider with saved-order reads, pending/error/403 fallback and session-only section collapse. Favorites, recents and actual order persistence still need the recipe checks."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      [
        {
          path: "/api/sidebar-preferences/me",
          read: () => ({ orderedIds: ["company-storybook"], updatedAt: null }),
        },
        {
          path: "/api/companies/company-storybook/sidebar-preferences/me",
          read: () => ({ orderedIds: [], updatedAt: null }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof SidebarPreferences>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SavedOrder: Story = {};
export const LoadingOrder: Story = { parameters: { fixtureState: "loading" } };
export const OrderReadFailed: Story = {
  parameters: { fixtureState: "failure" },
};
export const OrderPermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const CollapseWork: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: /Work/ }));
    await waitFor(() =>
      expect(
        c.queryByRole("link", { name: "Dashboard" }),
      ).not.toBeInTheDocument(),
    );
  },
};
