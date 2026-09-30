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

function PrivacyActionsStory() {
  const state = usePrivacyStory();
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail("privacy-root"),
    queryFn: () => issuesApi.get("privacy-root"),
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
  parameters: privacyParameters,
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
    await userEvent.click(
      await page.findByRole("button", { name: "Make public" }),
    );
    await expect(await page.findByRole("alertdialog")).toHaveTextContent(
      "Existing private subtasks keep their privacy",
    );
  },
};
export const MakePublicFailure: Story = {
  parameters: { privacy: { failure: "visibility" } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Make public" }),
    );
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
