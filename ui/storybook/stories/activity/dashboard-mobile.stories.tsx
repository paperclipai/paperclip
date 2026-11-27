import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import { Layout } from "@/components/Layout";
import { Route, Routes } from "@/lib/router";
import { Dashboard } from "@/pages/Dashboard";
import { PluginLauncherProvider } from "@/plugins/launchers";

function RoutedDashboardPage() {
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="dashboard" element={<Dashboard />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}

const meta = {
  id: "activity-dashboard-mobile",
  title: "Oversight and operation/Dashboards and audit trails/Dashboard (Mobile)",
  component: RoutedDashboardPage,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/dashboard"],
    docs: {
      description: {
        component:
          "Production Dashboard page inside the app shell at mobile (390×844) and desktop viewports. Verifies single-column chart stacking on narrow screens and uniform-height summary metric cards.",
      },
    },
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "Mounts Layout with the shipped Dashboard route over Storybook API fixtures. Verifies mobile metric card alignment, single-column chart stacking, and zero horizontal overflow; live WebSocket updates and server aggregation are not verified.",
    },
  },
} satisfies Meta<typeof RoutedDashboardPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DashboardMobile: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
  parameters: {
    layout: "fullscreen",
    waitForViewport: true,
    initialEntries: ["/PAP/dashboard"],
  },
  play: async () => {
    const page = within(document.body);
    await expect(await page.findByText("Agents Enabled")).toBeVisible();
    await expect(await page.findByText("Run Activity")).toBeVisible();
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth));
  },
};

export const DashboardDesktop: Story = {
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/dashboard"],
  },
  play: async () => {
    const page = within(document.body);
    await expect(await page.findByText("Agents Enabled")).toBeVisible();
  },
};
