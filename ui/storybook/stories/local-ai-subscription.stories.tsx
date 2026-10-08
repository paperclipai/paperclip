import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { LocalProviderLoginInstructions } from "@/components/AdapterLoginChrome";

const meta = {
  title: "AI Connections/Provider routing/07 Subscription sign-in",
  component: LocalProviderLoginInstructions,
  parameters: { layout: "centered" },
} satisfies Meta<typeof LocalProviderLoginInstructions>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeBrowserCode: Story = {
  args: {
    adapterType: "claude_local",
    login: {
      isolated: true, preparing: false, status: "sign_in_required", error: null,
      authorizationUrl: "#storybook-provider-simulator",
      submitCode: async () => {}, retry: () => {},
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("link", { name: "Sign in to Claude" })).toBeVisible());
    await waitFor(() => expect(canvas.getByLabelText("Authorization code")).toBeVisible());
    await expect(canvas.queryByText(/claude auth login|CLAUDE_CONFIG_DIR/)).not.toBeInTheDocument();
    await userEvent.type(canvas.getByLabelText("Authorization code"), "fixture-code");
    await userEvent.click(canvas.getByRole("button", { name: "Submit code" }));
    await expect(canvas.getByLabelText("Authorization code")).toHaveValue("");
  },
};

export const CodexDeviceCode: Story = {
  args: {
    adapterType: "codex_local",
    login: {
      isolated: true, preparing: false, status: "sign_in_required", error: null,
      authorizationUrl: "#storybook-provider-simulator", code: "ABCD-12345",
      retry: () => {},
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole("link", { name: "Sign in to OpenAI" })).toBeVisible());
    await waitFor(() => expect(canvas.getByText("ABCD-12345")).toBeVisible());
    await expect(canvas.queryByText(/codex login|CODEX_HOME/)).not.toBeInTheDocument();
  },
};

export const Connected: Story = {
  args: { adapterType: "codex_local", login: { isolated: true, preparing: false, status: "ready", error: null, retry: () => {} } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("is signed in");
    await userEvent.click(canvas.getByRole("button", { name: "Use a different account" }));
  },
};

export const Expired: Story = {
  args: { adapterType: "claude_local", login: { isolated: true, preparing: false, status: "expired", error: "This sign-in attempt expired. Start sign-in again.", retry: () => {} } },
};
