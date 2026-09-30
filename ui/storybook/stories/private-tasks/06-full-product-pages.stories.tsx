import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Route, Routes, useNavigate } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { DesignGuide } from "@/pages/DesignGuide";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { mobile, privacyDecorator, privacyParameters } from "./PrivacyStory";

function PrivacyPage({
  child = false,
  guide = false,
}: {
  child?: boolean;
  guide?: boolean;
}) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate(
      guide
        ? "/PAP/design-guide"
        : `/PAP/issues/${child ? "PAP-411" : "PAP-410"}`,
      { replace: true },
    );
    setReady(true);
  }, [navigate, child, guide]);
  if (!ready) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="design-guide" element={<DesignGuide />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
const meta = {
  title: "Private tasks/06 Full product pages",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, waitForViewport: true },
  render: () => <PrivacyPage />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
async function openTaskMenu(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body);
  await page.findByRole(
    "button",
    { name: "More task actions" },
    { timeout: 15000 },
  );
  // Navigation focus and async page queries can replace or dismiss the first
  // trigger. Reacquire it, and only open when closed; never toggle an open menu.
  await waitFor(
    async () => {
      const trigger = page.getByRole("button", { name: "More task actions" });
      if (trigger.getAttribute("aria-expanded") !== "true") {
        await userEvent.click(trigger);
      }
      await expect(page.getByRole("button", { name: "Share…" })).toBeVisible();
    },
    { timeout: 15000 },
  );
  return page;
}
export const OwnerTask: Story = {};
export const OwnerTaskMenu: Story = {
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await expect(
      await page.findByRole("button", { name: "Share…" }),
    ).toBeEnabled();
  },
};
export const OwnerSharingFromMenu: Story = {
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await userEvent.click(await page.findByRole("button", { name: "Share…" }));
    await expect(
      await page.findByRole("dialog", { name: "Who can access this task" }),
    ).toBeVisible();
  },
};
export const SharedChildReader: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(
      await page.findByTestId("locked-issue-chip", {}, { timeout: 15000 }),
    ).toHaveTextContent("PAP-410");
    await expect(
      page.queryByRole("link", { name: /Task PAP-410/ }),
    ).not.toBeInTheDocument();
    await expect(
      page.queryByText("Prepare my board briefing"),
    ).not.toBeInTheDocument();
  },
  parameters: { privacy: { role: "reader", childOnly: true } },
  render: () => <PrivacyPage child />,
};
export const SharedReaderMenu: Story = {
  parameters: { privacy: { role: "reader", childOnly: true } },
  render: () => <PrivacyPage child />,
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await expect(
      await page.findByRole("button", { name: "Share…" }),
    ).toBeDisabled();
  },
};
export const AdminTask: Story = { parameters: { privacy: { role: "admin" } } };
export const MobileSharedChild: Story = {
  globals: mobile,
  parameters: { privacy: { role: "reader", childOnly: true } },
  render: () => <PrivacyPage child />,
};
export const LightTask: Story = { globals: { theme: "light" } };
export const DesignGuideLockedReferences: Story = {
  render: () => <PrivacyPage guide />,
  play: async ({ canvasElement }) => {
    const section = await within(canvasElement).findByText(
      "LockedIssueChip",
      {},
      { timeout: 15000 },
    );
    section.scrollIntoView({ block: "center" });
    await expect(section).toBeVisible();
  },
};

export const SharedChildTasksPanel: Story = {
  parameters: { privacy: { role: "reader", childOnly: true } },
  render: () => <PrivacyPage child />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("tab", { name: "Tasks" }, { timeout: 15000 }),
    );
    const ancestors = await page.findByRole("list", {
      name: "Ancestor tasks, root to parent",
    });
    await expect(
      within(ancestors).getByTestId("locked-issue-chip"),
    ).toHaveTextContent("PAP-410");
    await expect(within(ancestors).queryByRole("link")).not.toBeInTheDocument();
  },
};

export const ClassicSharedChild: Story = {
  parameters: { privacy: { role: "reader", childOnly: true, classic: true } },
  render: () => <PrivacyPage child />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const chips = await page.findAllByTestId(
      "locked-issue-chip",
      {},
      { timeout: 15000 },
    );
    await expect(chips.length).toBeGreaterThanOrEqual(1);
    await expect(
      page.queryByRole("link", { name: /PAP-410/ }),
    ).not.toBeInTheDocument();
  },
};
