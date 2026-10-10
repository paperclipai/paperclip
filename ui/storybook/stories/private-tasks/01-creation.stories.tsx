import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { PrivacyPage } from "./06-full-product-pages.stories";
import { useDialog } from "@/context/DialogContext";
import { Button } from "@/components/ui/button";
import {
  mobile,
  choosePrivateTask,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
} from "./PrivacyStory";

function Creation({
  parent = false,
  project = false,
  draft = false,
  taskTitle = "Prepare my board briefing",
}: {
  parent?: boolean;
  project?: boolean;
  draft?: boolean;
  taskTitle?: string;
}) {
  const { openNewIssue } = useDialog();
  const opened = useRef(false);
  const open = () =>
    openNewIssue({
      ...(draft
        ? {}
        : {
            title: parent
              ? "Research market benchmarks"
              : taskTitle,
          }),
      ...(parent
        ? {
            parentId: "privacy-root",
            parentIdentifier: "PAP-410",
            parentTitle: taskTitle,
          }
        : {}),
      ...(project ? { projectId: "project-private" } : {}),
    });
  useEffect(() => {
    open();
  }, [parent, project, draft, taskTitle]);
  return <PrivacyPage tasks />;
}
const meta = {
  title: "Private tasks/01 Creation",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, waitForViewport: true, docs: { description: { component: "Route /PAP/issues with the new-task composer. Choose Private task from +; the lock chip keeps the selection visible. Hover, focus, or tap an inherited chip to see the parent task or private project that requires privacy. Mobile stories use the real shell and check that menu actions and composer controls stay inside the viewport." } } },
  args: { taskTitle: "Prepare my board briefing" },
  argTypes: { taskTitle: { control: "text" } },
  render: (args) => <Creation {...args} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const OpenByDefault: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await page.findByRole("button", { name: "Add to composer" });
    await waitFor(() => expect(page.queryByTestId("composer-private-chip")).not.toBeInTheDocument());
  },
};
export const PrivacyInPlusMenu: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
    await expect(await page.findByTestId("composer-add-private")).toBeVisible();
  },
};
export const PrivateBeforeSaving: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await choosePrivateTask(page);
    await expect(await page.findByRole("button", { name: "Remove private task" })).toBeVisible();
  },
};
export const RemovePrivateChoice: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await choosePrivateTask(page);
    await userEvent.click(await page.findByRole("button", { name: "Remove private task" }));
    await waitFor(() => expect(page.queryByTestId("composer-private-chip")).not.toBeInTheDocument());
  },
};
export const ChildInheritsPrivacy: Story = {
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = await page.findByRole("button", { name: "Private task" });
    await expect(chip).toBeDisabled();
    await userEvent.hover(chip.parentElement!);
    await expect(await page.findByRole("tooltip")).toHaveTextContent("Subtask of private task Prepare my board briefing");
  },
};
export const MobilePrivateChoice: Story = { ...PrivateBeforeSaving, globals: mobile };
async function expectInsideViewport(element: HTMLElement) {
  await waitFor(() => {
    const rect = element.getBoundingClientRect();
    const view = element.ownerDocument.defaultView!;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(view.innerWidth);
    expect(rect.bottom).toBeLessThanOrEqual(view.innerHeight);
  });
}
async function openMobilePlusMenu(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
  const menu = await page.findByRole("dialog", { name: "Add" });
  await expectInsideViewport(menu);
  await expectInsideViewport(within(menu).getByRole("button", { name: "Close Add menu" }));
  for (const action of within(menu).getAllByRole("button")) await expectInsideViewport(action);
  return page;
}
export const MobilePlusMenu: Story = {
  globals: mobile,
  parameters: { docs: { description: { story: "390 × 844. The Add menu stays below the safe-area inset; its header, close action, and every option remain on screen." } } },
  play: async ({ canvasElement }) => { await openMobilePlusMenu(canvasElement); },
};
export const SmallPhonePlusMenu: Story = {
  ...MobilePlusMenu,
  globals: { viewport: { value: "smallPhone", isRotated: false } },
  parameters: { viewport: { options: { smallPhone: { name: "Small phone", styles: { width: "320px", height: "568px" } } } }, docs: { description: { story: "320 × 568. All menu actions remain reachable on the smallest supported phone layout." } } },
};
export const ShortViewportPlusMenu: Story = {
  ...MobilePlusMenu,
  globals: { viewport: { value: "shortPhone", isRotated: false } },
  parameters: { viewport: { options: { shortPhone: { name: "Short phone viewport", styles: { width: "390px", height: "360px" } } } }, docs: { description: { story: "390 × 360. A short visible viewport exercises the menu's height limit and internal scrolling. This is a layout check, not a simulation of a native software keyboard." } } },
};
export const LandscapePlusMenu: Story = {
  ...MobilePlusMenu,
  globals: { viewport: { value: "landscapePhone", isRotated: false } },
  parameters: { viewport: { options: { landscapePhone: { name: "Landscape phone", styles: { width: "667px", height: "375px" } } } }, docs: { description: { story: "667 × 375. The same mobile menu fits when the phone is rotated." } } },
};
export const PrivateProject: Story = {
  render: () => <Creation project />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = await page.findByRole("button", { name: "Private task" });
    await expect(chip).toBeDisabled();
    await userEvent.hover(chip.parentElement!);
    await expect(await page.findByRole("tooltip")).toHaveTextContent("In private project Executive planning");
  },
};
export const PersonalProject: Story = {
  parameters: { privacy: { personal: true } },
  render: () => <Creation project />,
};
export const RestoredPrivateDraft: Story = {
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};
export const CreationFailure: Story = {
  parameters: { privacy: { failure: "create", draft: true } },
  render: () => <Creation draft />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Create task" }),
    );
    await expect(
      await page.findByText("The request could not be completed. Try again."),
    ).toBeVisible();
  },
};
export const MobilePrivateChild: Story = {
  globals: mobile,
  render: () => <Creation parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = await page.findByRole("button", { name: "Private task" });
    await userEvent.click(chip.parentElement!);
    await expect(await page.findByRole("tooltip")).toHaveTextContent("Subtask of private task Prepare my board briefing");
  },
};
export const MobilePrivateProject: Story = {
  ...PrivateProject,
  globals: mobile,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = await page.findByRole("button", { name: "Private task" });
    await userEvent.click(chip.parentElement!);
    await expect(await page.findByRole("tooltip")).toHaveTextContent("In private project Executive planning");
  },
};
export const SmallPhoneComposer: Story = {
  globals: SmallPhonePlusMenu.globals,
  parameters: SmallPhonePlusMenu.parameters,
  play: async ({ canvasElement }) => {
    const page = await openMobilePlusMenu(canvasElement);
    await userEvent.click(page.getByTestId("composer-add-private"));
    await userEvent.type(page.getByRole("textbox", { name: "Task title" }), " with a longer title");
    await expectInsideViewport(page.getByTestId("composer-private-chip"));
    await expectInsideViewport(page.getByRole("button", { name: "Create task" }));
    await userEvent.click(page.getByRole("button", { name: "Add to composer" }));
    await userEvent.click(page.getByTestId("composer-add-plan"));
    await expectInsideViewport(page.getByTestId("task-chat-composer-mode"));
    await expectInsideViewport(page.getByRole("button", { name: "Create task" }));
    await userEvent.click(page.getByRole("button", { name: "Remove private task" }));
    await expect(page.queryByTestId("composer-private-chip")).not.toBeInTheDocument();
    await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue("Prepare my board briefing with a longer title");
    await choosePrivateTask(page);
    await expectInsideViewport(page.getByTestId("composer-private-chip"));
    await waitFor(() => expect(page.getByTestId("task-chat-composer-mode").getBoundingClientRect().right)
      .toBeLessThanOrEqual(page.getByTestId("task-chat-composer-selection").getBoundingClientRect().left));
    await userEvent.click(page.getByRole("button", { name: "Select assignee" }));
    await expectInsideViewport(await page.findByRole("dialog", { name: "Select assignee" }));
    await userEvent.click(page.getByRole("button", { name: "Close picker" }));
    await userEvent.click(page.getByRole("button", { name: "Select model and effort" }));
    await expectInsideViewport(await page.findByRole("dialog", { name: "Select model and effort" }));
    await userEvent.click(page.getByRole("button", { name: "Close picker" }));
    await expectInsideViewport(page.getByRole("button", { name: "Create task" }));
  },
};
export const LightPrivateDraft: Story = {
  globals: { theme: "light" },
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};

export const ParentAccessLoading: Story = {
  parameters: { privacy: { loading: "parent" } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Checking parent access…")).toBeVisible();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeDisabled();
    await userEvent.click(await page.findByRole("button", { name: "Add to composer" }));
    await expect(page.queryByTestId("composer-add-private")).not.toBeInTheDocument();
  },
};
export const ParentAccessUnavailable: Story = {
  parameters: { privacy: { failure: "parent" } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText("Couldn't check parent access.")).toBeVisible();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeDisabled();
  },
};
export const RetryParentAccess: Story = {
  parameters: { privacy: { failure: "parent", retryOnce: true } },
  render: (args) => <Creation {...args} parent />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Retry" }));
    await expect(await page.findByRole("button", { name: "Private task" })).toBeDisabled();
    await expect(await page.findByRole("button", { name: "Create sub-task" })).toBeEnabled();
  },
};
export const MobileParentAccessUnavailable: Story = { ...ParentAccessUnavailable, globals: mobile };
