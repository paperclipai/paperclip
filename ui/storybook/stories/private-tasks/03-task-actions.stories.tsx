import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { IssuePrivacyActions } from "@/components/IssuePrivacyActions";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { privacyCompanyId } from "../../fixtures/privateTasks";
import {
  mobile,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
  usePrivacyStory,
} from "./PrivacyStory";

function PrivacyActionsStory({ child = false }: { child?: boolean }) {
  const state = usePrivacyStory();
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(child ? "privacy-child" : "privacy-root"),
    queryFn: () => issuesApi.get(child ? "privacy-child" : "privacy-root"),
  });
  return (
    <StoryFrame
      title="Task privacy actions"
      story="As the owner or a company admin, I manage the audience from the task menu. A shared reader can read the task but cannot change its audience."
      checks={[
        "Private tasks offer Share and Make public. Open tasks offer Make private.",
        "Making public requires confirmation explaining disclosure and private descendants.",
        "Shared readers see disabled actions with a permission explanation.",
      ]}
    >
      {issue && (
        <div className="space-y-3">
          <p className="text-sm">
            {issue.identifier} ·{" "}
            {issue.visibility === "private" ? "Private" : "Open to company"}
          </p>
          <IssuePrivacyActions
            issue={issue}
            companyId={privacyCompanyId}
            canManage={state.options.role !== "reader"}
            closeMenu={() => {}}
          >
            {(items) => (
              <div
                aria-label="Task privacy menu"
                className="max-w-xs rounded-md border border-border bg-popover p-1"
              >
                {items}
              </div>
            )}
          </IssuePrivacyActions>
        </div>
      )}
    </StoryFrame>
  );
}
const meta = {
  title: "Private tasks/03 Task actions",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, docs: { description: { component: "Task menu privacy actions, permission gates and disclosure confirmation." } } },
  render: () => <PrivacyActionsStory />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const PrivateOwner: Story = {};
export const OpenOwner: Story = {
  parameters: { privacy: { visibility: "open" } },
};
export const SharedReader: Story = {
  parameters: { privacy: { role: "reader" } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(
      await page.findByRole("button", { name: "Share…" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Make public" }),
    ).toBeDisabled();
  },
};
export const CompanyAdmin: Story = {
  parameters: { privacy: { role: "admin" } },
};
export const MakePublicConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("button", { name: "Make public" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "Make public" }));
    await expect(await page.findByRole("alertdialog")).toHaveTextContent(
      "Existing private subtasks keep their privacy",
    );
  },
};
export const MakePublicFailure: Story = {
  parameters: { privacy: { failure: "visibility" } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole("button", { name: "Make public" })).toBeEnabled());
    await userEvent.click(page.getByRole("button", { name: "Make public" }));
    const dialog = await page.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Make public" }),
    );
    await waitFor(() =>
      expect(page.getByText("Couldn't change visibility")).toBeVisible(),
    );
    await expect(dialog).toBeVisible();
  },
};
export const MobileConfirmation: Story = {
  ...MakePublicConfirmation,
  globals: mobile,
};

export const InheritedPrivateParent: Story = {
  render: () => <PrivacyActionsStory child />,
  parameters: { docs: { description: { story: "Make public is disabled while a private parent controls this task. Hover or focus explains that the task must be moved first." } } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const button = await page.findByRole("button", { name: "Make public" });
    await expect(button).toBeDisabled();
    await userEvent.hover(button.parentElement!);
    await waitFor(async () => expect(await page.findByRole("tooltip")).toHaveTextContent("private parent"));
  },
};
export const PrivateProjectRestriction: Story = {
  parameters: { privacy: { taskProject: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const button = await page.findByRole("button", { name: "Make public" });
    await waitFor(() => expect(button).toBeDisabled());
    await userEvent.hover(button.parentElement!);
    await waitFor(async () => expect(await page.findByRole("tooltip")).toHaveTextContent("private project"));
  },
};
export const PersonalProjectCanMakePublic: Story = {
  parameters: { privacy: { taskProject: true, personal: true } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByRole("button", { name: "Make public" })).toBeEnabled());
  },
};
export const RetryInheritedAccessCheck: Story = {
  render: () => <PrivacyActionsStory child />,
  parameters: { privacy: { failure: "parent", retryOnce: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Retry access check" }));
    await waitFor(() => expect(page.queryByRole("button", { name: "Retry access check" })).not.toBeInTheDocument());
    await expect(page.getByRole("button", { name: "Make public" })).toBeDisabled();
  },
};
