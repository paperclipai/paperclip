import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { screen, userEvent, waitFor } from "storybook/test";
import type { ProductFeedbackCapability } from "@paperclipai/shared";
import { ProductFeedbackDialog } from "@/components/ProductFeedbackDialog";
import { Button } from "@/components/ui/button";

const capability: ProductFeedbackCapability = {
  enabled: true,
  limits: { feedbackMaxLength: 5_000, diagnosticCount: 5 },
};

const receipt = {
  ok: true as const,
  duplicate: false,
  submissionId: "708db09f-1a29-4dd6-ad62-99b19b6902b4",
  receiptId: "808db09f-1a29-4dd6-ad62-99b19b6902b4",
};

function FeedbackStory(props: ComponentProps<typeof ProductFeedbackDialog>) {
  const [open, setOpen] = useState(true);
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      {!open ? <Button onClick={() => setOpen(true)}>Open feedback</Button> : null}
      <ProductFeedbackDialog {...props} open={open} onOpenChange={setOpen} />
    </div>
  );
}

async function enterFeedbackAndSubmit() {
  await userEvent.type(
    screen.getByLabelText("What could Paperclip do better?"),
    "Make this workflow easier to inspect.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));
}

const meta = {
  title: "Product/Feedback dialog",
  component: ProductFeedbackDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: () => undefined,
    capability,
    deploymentMode: "authenticated",
    companyId: "11111111-1111-4111-8111-111111111111",
    knownEmail: "owner@example.com",
    appVersion: "2026.901.0",
    submitFeedback: async () => receipt,
  },
  render: (args) => <FeedbackStory {...args} />,
} satisfies Meta<typeof ProductFeedbackDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KnownAccountEmail: Story = {};

export const LocalEmailEntry: Story = {
  args: {
    deploymentMode: "local_trusted",
    knownEmail: null,
  },
};

export const ConsentOff: Story = {
  play: async () => {
    await userEvent.click(screen.getByRole("checkbox"));
  },
};

export const ChangedAccountEmail: Story = {
  play: async () => {
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
  },
};

export const Submitting: Story = {
  args: {
    submitFeedback: async () => new Promise<never>(() => undefined),
  },
  play: enterFeedbackAndSubmit,
};

export const Retry: Story = {
  args: {
    submitFeedback: async () => {
      throw new Error("The feedback relay is unavailable");
    },
  },
  play: async () => {
    await enterFeedbackAndSubmit();
    await waitFor(() => screen.getByRole("button", { name: "Try again" }));
  },
};

export const Success: Story = {
  play: async () => {
    await enterFeedbackAndSubmit();
    await waitFor(() => screen.getByRole("heading", { name: "Feedback sent" }));
  },
};
