import type { Project } from "@paperclipai/shared";
import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { ProjectProperties } from "@/components/ProjectProperties";
import { IssueShareSheet } from "@/components/IssueShareSheet";
import { Button } from "@/components/ui/button";
import { ProjectAccessMembers } from "@/components/ProjectAccessMembers";
import { projectsApi } from "@/api/projects";
import {
  mobile,
  openProjectMemberPicker,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
  usePrivacyStory,
} from "./PrivacyStory";

function ProjectStory({
  settings = false,
  open = false,
  projectName = "Executive planning",
}: {
  settings?: boolean;
  open?: boolean;
  projectName?: string;
}) {
  const state = usePrivacyStory();
  const [project, setProject] = useState<Project>(() => ({
    ...state.projects[0]!,
    name: projectName,
    visibility: open ? ("open" as const) : ("private" as const),
  }));
  useEffect(() => setProject(value => ({ ...value, name: projectName })), [projectName]);
  return (
    <StoryFrame
      title={
        settings
          ? "Project visibility settings"
          : "Manage private project members"
      }
      story="As an owner, I can create a private place for related work and grant members access to its tasks. People directly invited to one task do not automatically see the project."
      checks={[
        "Only the owner or an admin can change privacy and memberships.",
        "The owner's access cannot be removed. Readers can inspect the member list.",
        "Shared agents show a memory and workspace caution before being added.",
      ]}
    >
      {settings ? (
        <ProjectProperties
          project={project}
          onUpdate={async (data) => {
            const updated = await projectsApi.update(
              project.id,
              data,
              project.companyId,
            );
            setProject(updated);
          }}
        />
      ) : (
        <ProjectAccessMembers
          project={project}
          canManage={state.options.role !== "reader"}
        />
      )}
    </StoryFrame>
  );
}
const openMembers = async (canvasElement: HTMLElement) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(
    await page.findByRole("button", { name: /^(Manage|View) access$/ }),
  );
  await page.findByRole("dialog", { name: "Private project access" });
  return page;
};
const meta = {
  title: "Private tasks/05 Projects",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, docs: { description: { component: "Project settings → Manage access. Human and agent identities appear in the search dropdown and selected value. Owner, reader, error, loading and mobile states use production components." } } },
  args: { projectName: "Executive planning" },
  argTypes: { projectName: { control: "text" } },
  render: (args) => <ProjectStory {...args} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const PrivateProjectSettings: Story = {
  render: (args) => <ProjectStory {...args} settings />,
};
export const OpenProjectSettings: Story = {
  render: (args) => <ProjectStory {...args} settings open />,
};
export const PersonalProjectSettings: Story = {
  parameters: { privacy: { personal: true } },
  render: (args) => <ProjectStory {...args} settings />,
};
export const ReaderProjectSettings: Story = {
  parameters: { privacy: { role: "reader" } },
  render: (args) => <ProjectStory {...args} settings />,
};
export const AdminProjectSettings: Story = {
  parameters: { privacy: { role: "admin" } },
  render: (args) => <ProjectStory {...args} settings />,
};
export const MemberList: Story = {
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await expect(await page.findByText("Morgan Reed")).toBeVisible();
    await expect(
      page.queryByRole("button", { name: "Remove Avery Chen" }),
    ).not.toBeInTheDocument();
  },
};
export const ReaderMemberList: Story = {
  parameters: { privacy: { role: "reader" } },
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await expect(
      await page.findByRole("button", { name: "Remove Morgan Reed" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add" })).toBeDisabled();
  },
};
export const SharedAgentSelected: Story = {
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await openProjectMemberPicker(canvasElement);
    await userEvent.click(
      await page.findByRole("option", { name: "Research team agent" }),
    );
    await expect(
      await page.findByText(/This agent can retain private project context/),
    ).toBeVisible();
  },
};
export const LoadingMembers: Story = {
  parameters: { privacy: { loading: "members" } },
  play: async ({ canvasElement }) => {
    await openMembers(canvasElement);
  },
};
export const MemberLoadFailure: Story = {
  parameters: { privacy: { failure: "members" } },
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await expect(
      await page.findByText("Couldn't load project access members."),
    ).toBeVisible();
  },
};
export const DirectoryFailure: Story = {
  parameters: { privacy: { failure: "directory" } },
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await expect(
      await page.findByText("Couldn't load the company access directory."),
    ).toBeVisible();
  },
};
export const RemoveFailure: Story = {
  parameters: { privacy: { failure: "project-remove" } },
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await userEvent.click(
      await page.findByRole("button", { name: "Remove Morgan Reed" }),
    );
    await waitFor(() =>
      expect(page.getByText("Couldn't remove project access")).toBeVisible(),
    );
  },
};
export const AddFailure: Story = {
  parameters: { privacy: { failure: "project-add" } },
  play: async ({ canvasElement }) => {
    const page = await openMembers(canvasElement);
    await openProjectMemberPicker(canvasElement);
    await userEvent.click(
      await page.findByRole("option", { name: /Sam Rivera/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(page.getByText("Couldn't add project access")).toBeVisible(),
    );
  },
};
export const MobileMembers: Story = {
  globals: mobile,
  play: async ({ canvasElement }) => {
    await openMembers(canvasElement);
  },
};
export const LightProjectSettings: Story = {
  globals: { theme: "light" },
  render: (args) => <ProjectStory {...args} settings />,
};

export const OpenProjectConfirmation: Story = {
  render: (args) => <ProjectStory {...args} settings />,
  parameters: { docs: { description: { story: "Before opening a private project, the owner sees that project-only access to private tasks will end and can share tasks directly first." } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("switch", { name: "Private project" }));
    await expect(await page.findByRole("alertdialog")).toHaveTextContent("will lose access");
  },
};
export const OpenProjectAudienceCopy: Story = {
  ...OpenProjectConfirmation,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("switch", { name: "Private project" }));
    const dialog = await page.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Open to company" }));
    await expect(await page.findByText(/Everyone in the company can discover this project/)).toBeVisible();
    await expect(page.queryByRole("button", { name: "Manage access" })).not.toBeInTheDocument();
  },
};
export const MobileOpenProjectConfirmation: Story = { ...OpenProjectConfirmation, globals: mobile };
function ProjectAudienceJourney() {
  const state = usePrivacyStory();
  const [open, setOpen] = useState(false);
  return <StoryFrame title="Project membership and task audience" story="Removing project access updates a previously opened task share sheet." checks={[]}>
    <Button onClick={() => setOpen(true)}>View task audience</Button>
    <ProjectAccessMembers project={state.projects[0]!} canManage />
    <IssueShareSheet issueId="privacy-root" companyId={state.projects[0]!.companyId} canManage open={open} onOpenChange={setOpen} />
  </StoryFrame>;
}
export const MembershipUpdatesTaskAudience: Story = {
  render: () => <ProjectAudienceJourney />,
  parameters: { privacy: { taskProject: true, grants: "empty" }, docs: { description: { story: "Open the task audience, remove Morgan from the project, then reopen that cached share sheet. Project-only access disappears without reloading the page." } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "View task audience" }));
    await expect(await page.findByText("Morgan Reed")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "Manage access" }));
    await userEvent.click(await page.findByRole("button", { name: "Remove Morgan Reed" }));
    await page.findByText("Project access removed");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(page.getByRole("button", { name: "View task audience" }));
    const dialog = await page.findByRole("dialog", { name: "Who can access this task" });
    await waitFor(() => expect(within(dialog).queryByText("Morgan Reed")).not.toBeInTheDocument());
  },
};
