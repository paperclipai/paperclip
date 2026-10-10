import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Route, Routes, useNavigate } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { Issues } from "@/pages/Issues";
import { ProjectDetail } from "@/pages/ProjectDetail";
import { Projects } from "@/pages/Projects";
import { DesignGuide } from "@/pages/DesignGuide";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { mobile, privacyDecorator, privacyParameters } from "./PrivacyStory";

export function PrivacyPage({
  child = false,
  guide = false,
  projects = false,
  tasks = false,
  projectSettings = false,
}: {
  child?: boolean;
  guide?: boolean;
  projects?: boolean;
  tasks?: boolean;
  projectSettings?: boolean;
}) {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    navigate(
      projectSettings ? "/PAP/projects/project-private/configuration" : tasks ? "/PAP/issues" : projects ? "/PAP/projects" : guide
        ? "/PAP/design-guide"
        : `/PAP/issues/${child ? "PAP-411" : "PAP-410"}`,
      { replace: true },
    );
    setReady(true);
  }, [navigate, child, guide, projects, tasks, projectSettings]);
  if (!ready) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="issues" element={<Issues />} />
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:projectId/*" element={<ProjectDetail />} />
          <Route path="design-guide" element={<DesignGuide />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
const meta = {
  title: "Private tasks/06 Full product pages",
  excludeStories: ["PrivacyPage"],
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

export const PrivateProjectsInNavigation: Story = { parameters: { docs: { description: { story: "Route /PAP/projects. Private project locks sit on the right in the list and starred navigation." } } }, render: () => <PrivacyPage projects /> };
export const ClassicPrivateProjects: Story = { parameters: { privacy: { classic: true } }, render: () => <PrivacyPage projects /> };
export const MobilePrivateProjects: Story = { globals: mobile, render: () => <PrivacyPage projects /> };

export const OwnerInheritedTaskMenu: Story = {
  render: () => <PrivacyPage child />,
  parameters: { docs: { description: { story: "Actual /PAP/issues/PAP-411 page: sharing remains available, while Make public explains the private parent restriction." } } },
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await expect(page.getByRole("button", { name: "Share…" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Make public" })).toBeDisabled();
  },
};
export const MobileInheritedTaskMenu: Story = { ...OwnerInheritedTaskMenu, globals: mobile };

export const ProjectVisibilityThroughAutosave: Story = {
  render: () => <PrivacyPage projectSettings />,
  parameters: { docs: { description: { story: "Actual project Configuration page. Open the project through its field-autosave control and review the private-task access consequence before saving." } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("switch", { name: "Private project" }, { timeout: 15000 }));
    await expect(await page.findByRole("alertdialog")).toHaveTextContent("will lose access");
  },
};
export const ProjectVisibilityAutosaveCompletes: Story = {
  ...ProjectVisibilityThroughAutosave,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("switch", { name: "Private project" }, { timeout: 15000 }));
    const dialog = await page.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open to company" }));
    await expect(await page.findByText(/Everyone in the company can discover this project/)).toBeVisible();
  },
};
export const MobileProjectVisibilityThroughAutosave: Story = { ...ProjectVisibilityThroughAutosave, globals: mobile };

export const OwnerMovesOutOfPrivateParent: Story = {
  render: () => <PrivacyPage child />,
  parameters: { docs: { description: { story: "The owner removes a private parent through the production properties picker, then reviews Make public on the same task. Privacy hints refresh without reloading the page." } } },
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await expect(page.getByRole("button", { name: "Make public" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "More task actions" }));
    await userEvent.click(await page.findByRole("button", { name: "Edit parent" }));
    await userEvent.click(await page.findByRole("button", { name: "No parent" }));
    await openTaskMenu(canvasElement);
    await waitFor(() => expect(page.getByRole("button", { name: "Make public" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "Make public" }));
    await expect(await page.findByRole("alertdialog")).toHaveTextContent("Existing private subtasks keep their privacy");
  },
};
export const OwnerMovesOutOfPrivateProject: Story = {
  render: () => <PrivacyPage />,
  parameters: { privacy: { taskProject: true }, docs: { description: { story: "The owner removes the private project through the production properties picker. The task keeps its private visibility, and Make public becomes available without a page reload." } } },
  play: async ({ canvasElement }) => {
    const page = await openTaskMenu(canvasElement);
    await expect(page.getByRole("button", { name: "Make public" })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "More task actions" }));
    await userEvent.click(await page.findByRole("button", { name: "Executive planning" }));
    await userEvent.click(await page.findByRole("button", { name: "No project" }));
    await openTaskMenu(canvasElement);
    await waitFor(() => expect(page.getByRole("button", { name: "Make public" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "Make public" }));
    await expect(await page.findByRole("alertdialog")).toHaveTextContent("Make this task public?");
  },
};
