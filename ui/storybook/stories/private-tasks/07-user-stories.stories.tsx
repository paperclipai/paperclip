import { OwnerMovesOutOfPrivateParent, OwnerMovesOutOfPrivateProject } from "./06-full-product-pages.stories";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import creation from "./01-creation.stories";
import sharing, {
  ShareChildWithPerson,
  RemoveCurrentAssigneesSavedGrant,
  AddDirectGrantAlongsideInheritedAccess,
} from "./02-sharing.stories";
import actions from "./03-task-actions.stories";
import { RemovablePrivateBlocker } from "./04-references-and-blockers.stories";
import projects, { MembershipUpdatesTaskAudience, OpenProjectAudienceCopy } from "./05-projects.stories";
import {
  openProjectMemberPicker,
  choosePrivateTask,
  privacyDecorator,
  privacyParameters,
  mobile,
} from "./PrivacyStory";

// Reuse the same real-component canvases. Each play is a complete user journey,
// while the component stories deliberately stop at individual review states.
const meta = {
  title: "Private tasks/07 User stories",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, waitForViewport: true },
} satisfies Meta;
export default meta;
type Story = StoryObj;
export const CeoCreatesPrivateTask: Story = {
  name: "CEO · Create a private task",
  render: creation.render,
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Choose privacy before saving", async () => {
      await choosePrivateTask(page);
      await expect(await page.findByRole("button", { name: "Remove private task" })).toBeVisible();
    });
    await step("Create the private briefing", async () => {
      await userEvent.click(page.getByRole("button", { name: "Create task" }));
      await waitFor(() => expect(page.getByText("Created PAP-414")).toBeVisible());
      await expect(
        page.queryByTestId("composer-private-chip"),
      ).not.toBeInTheDocument();
    });
  },
};
export const MobileCeoCreatesPrivateTask: Story = {
  ...CeoCreatesPrivateTask,
  name: "CEO · Create a private task on mobile",
  globals: mobile,
  parameters: { docs: { description: { story: "Use the actual new-task composer in the mobile shell: choose Private task from +, review the lock chip, and save the private briefing." } } },
};
export const CeoSharesOnlyChild: Story = {
  name: "CEO · Share only a child",
  render: ShareChildWithPerson.render,
  parameters: { privacy: { grants: "empty" } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Review the selected person", async () => {
      const dialog = await page.findByRole("dialog", { name: "Who can access this task" });
      await waitFor(() => expect(dialog).toHaveTextContent("Morgan Reed"));
    });
    await step("Share the research child with Morgan", async () => {
      await userEvent.keyboard("{Escape}");
      await userEvent.click(await page.findByRole("button", { name: "Add" }));
      await waitFor(() =>
        expect(page.getByText("Access granted")).toBeVisible(),
      );
      await expect(await page.findByText("Morgan Reed")).toBeVisible();
    });
  },
};
export const OwnerRevokesAnExplicitGrant: Story = {
  name: "Owner · Revoke a saved grant",
  render: sharing.render,
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Inspect the grant removal explanation", async () => {
      await userEvent.click(
        (await page.findAllByRole("button", { name: "Revoke" }))[0]!,
      );
      await expect(await page.findByRole("alertdialog")).toHaveTextContent(
        "another grant",
      );
    });
    await step("Confirm removal", async () => {
      await userEvent.click(page.getByRole("button", { name: "Remove grant" }));
      await waitFor(() =>
        expect(page.getByText("Access revoked")).toBeVisible(),
      );
      await expect(page.queryByText("Morgan Reed")).not.toBeInTheDocument();
    });
  },
};
export const CurrentAssignmentStillGrantsAccess: Story = {
  name: "Owner · Remove a grant while assignment remains",
  render: RemoveCurrentAssigneesSavedGrant.render,
  parameters: { privacy: { grants: "assignment" } },
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Remove the assignee's saved grant", async () => {
      await userEvent.click(
        await page.findByRole("button", { name: "Remove saved grant" }),
      );
      await userEvent.click(
        await page.findByRole("button", { name: "Remove grant" }),
      );
      await page.findByText("Access revoked");
    });
    await step(
      "Current assignment remains visible as an independent reason",
      async () => {
        await expect(
          await page.findByText("Executive assistant"),
        ).toBeVisible();
        await expect(page.getByText("Current assignee")).toBeVisible();
      },
    );
  },
};
export const OwnerMakesTaskPublic: Story = {
  name: "Owner · Make a task public",
  render: actions.render,
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Review disclosure before changing the audience", async () => {
      await waitFor(() => expect(page.getByRole("button", { name: "Make public" })).toBeEnabled());
      await userEvent.click(page.getByRole("button", { name: "Make public" }));
      await expect(await page.findByRole("alertdialog")).toHaveTextContent(
        "Existing private subtasks keep their privacy",
      );
    });
    await step("Confirm company-wide access", async () => {
      const dialog = page.getByRole("alertdialog");
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Make public" }),
      );
      await expect(
        await page.findByRole("button", { name: "Make private" }),
      ).toBeEnabled();
    });
  },
};
export const ReaderDetachesPrivateBlocker: Story = {
  name: "Reader · Detach a private blocker",
  render: RemovablePrivateBlocker.render,
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step(
      "Remove a relationship without opening the private task",
      async () => {
        await userEvent.click(
          await page.findByRole("button", {
            name: "Remove PAP-410 as blocker",
          }),
        );
        await expect(await page.findByRole("dialog")).toHaveTextContent(
          "Remove PAP-410 as a blocker",
        );
      },
    );
    await step("Confirm the relationship change", async () => {
      await userEvent.click(
        page.getByRole("button", { name: "Remove blocker" }),
      );
      await expect(await page.findByRole("status")).toHaveTextContent(
        "Blocker removed",
      );
    });
  },
};
export const OwnerAddsProjectMember: Story = {
  name: "Project owner · Add a member",
  render: projects.render,
  play: async ({ canvasElement, step }) => {
    const page = within(canvasElement.ownerDocument.body);
    await step("Choose a company member", async () => {
      await userEvent.click(
        await page.findByRole("button", { name: "Manage access" }),
      );
      await openProjectMemberPicker(canvasElement);
      await userEvent.click(
        await page.findByRole("option", { name: /Sam Rivera/ }),
      );
    });
    await step("Grant access to the project", async () => {
      await userEvent.click(page.getByRole("button", { name: "Add" }));
      await waitFor(() =>
        expect(page.getByText("Project access added")).toBeVisible(),
      );
      await expect(
        await page.findByRole("button", { name: "Remove Sam Rivera" }),
      ).toBeEnabled();
    });
  },
};

export const OwnerKeepsChildAccessIndependent: Story = { ...AddDirectGrantAlongsideInheritedAccess, name: "Owner · Add a child grant before removing parent access" };
export const OwnerRemovesProjectOnlyTaskAccess: Story = { ...MembershipUpdatesTaskAudience, name: "Project owner · Remove a member and check the task audience" };
export const OwnerOpensProjectWithPrivateTasks: Story = { ...OpenProjectAudienceCopy, name: "Project owner · Review access loss before opening the project" };

export const OwnerMovesChildThenReviewsPublishing: Story = {
  ...OwnerMovesOutOfPrivateParent,
  name: "Owner · Move out of a private parent and review publishing",
};
export const OwnerMovesTaskThenReviewsPublishing: Story = {
  ...OwnerMovesOutOfPrivateProject,
  name: "Owner · Move out of a private project and review publishing",
};
