import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { GitHubChatPreview } from "../prototypes/github-chat/GitHubChatPreview";

const meta = {
  title: "Apps/GitHub chat & reviews",
  component: GitHubChatPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Design approval preview. Provider handoffs, tool checks, identity events, tasks, and reviews are simulated. No backend behavior or live GitHub actions are implemented by these stories. Use Start here for the complete journey, then inspect alternate and management states.",
      },
    },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof GitHubChatPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StartHere: Story = {
  name: "00 · Start here — interactive setup",
  args: { persistKey: "github-chat-design-draft-v3" },
};
export const ChooseAgent: Story = { name: "01 · Choose agent" };
export const StandardTrustWarning: Story = {
  name: "01 · Agent without low-trust review",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: /Paperclip agent/ }), "Atlas");
    await expect(canvas.getByRole("alert")).toHaveTextContent("Atlas is not configured for low-trust review");
    await expect(canvas.getByRole("link", { name: /Learn about low-trust agents/ })).toHaveAttribute("href", "https://docs.paperclip.ing/administration/trust-and-low-trust-review/");
  },
};
export const CreateApp: Story = {
  name: "02 · Create GitHub App",
  args: { initialStep: 1 },
};
export const ExistingApp: Story = {
  name: "02 · Existing App credentials",
  args: { initialStep: 1, scenario: "existing" },
};
export const Reconnect: Story = {
  name: "02 · Reconnect saved App",
  args: { initialStep: 1, scenario: "reconnect" },
};
export const ExpiredRegistration: Story = {
  name: "02 · Registration expired",
  args: { initialStep: 1, scenario: "expired" },
};
export const PrivateAddress: Story = {
  name: "02 · Public HTTPS prerequisite",
  args: { initialStep: 1, scenario: "private-url" },
};
export const SelectRepositories: Story = {
  name: "04 · Choose allowed repositories",
  args: { initialStep: 3 },
};
export const Verify: Story = {
  name: "05 · Connection and agent tools verified",
  args: { initialStep: 4 },
};
export const MissingTools: Story = {
  name: "05 · Agent missing GitHub tools",
  args: { initialStep: 4, scenario: "tools" },
};
export const MissingPermissions: Story = {
  name: "05 · Installation needs more permissions",
  args: { initialStep: 4, scenario: "permissions" },
};
export const WebhookFailure: Story = {
  name: "05 · Webhook not verified",
  args: { initialStep: 4, scenario: "webhook" },
};
export const UnsupportedRuntime: Story = {
  name: "05 · Agent environment unavailable",
  args: { initialStep: 4, scenario: "runtime" },
};
export const ConnectIdentity: Story = {
  name: "06 · Use your existing GitHub connection",
  args: { initialStep: 5 },
};
export const ConfirmIdentity: Story = {
  name: "06 · Confirm existing GitHub account",
  args: { initialStep: 5, scenario: "identity" },
};
export const LinkedIdentity: Story = {
  name: "06 · Account linked",
  args: { initialStep: 5, scenario: "linked" },
};
export const Configure: Story = {
  name: "07 · Review triggers, prompts, and tools",
  args: { initialStep: 6 },
};
export const TryIt: Story = {
  name: "08 · Optional first review",
  args: { initialStep: 7 },
};
export const SaveError: Story = {
  name: "09 · Save failure and retry",
  args: { initialStep: 6, scenario: "save-error" },
};
export const Settings: Story = {
  name: "Management · Settings",
  args: { initialStep: 7, section: "Settings" },
};
export const RepositoryOverride: Story = {
  name: "Management · Repository overrides",
  args: { initialStep: 7, section: "Settings", initialOverride: true },
};
export const Access: Story = {
  name: "Management · Linked member access",
  args: { initialStep: 7, section: "Access" },
};
export const GuestAccess: Story = {
  name: "Management · Sponsored guest permissions",
  args: { initialStep: 7, section: "Access", scenario: "guest" },
};
export const Reviews: Story = {
  name: "Reviews · Below minimum rating",
  args: { initialStep: 7, section: "Reviews", reviewState: "failed" },
};
export const Passed: Story = {
  name: "Reviews · Passing current head",
  args: { initialStep: 7, section: "Reviews", reviewState: "passed" },
};
export const Running: Story = {
  name: "Reviews · Agent running",
  args: { initialStep: 7, section: "Reviews", reviewState: "running" },
};
export const Queued: Story = {
  name: "Reviews · Task queued",
  args: { initialStep: 7, section: "Reviews", reviewState: "queued" },
};
export const Incomplete: Story = {
  name: "Reviews · Incomplete coverage",
  args: { initialStep: 7, section: "Reviews", reviewState: "incomplete" },
};
export const ManualNeeded: Story = {
  name: "Reviews · Authorized mention needed",
  args: { initialStep: 7, section: "Reviews", reviewState: "manual" },
};
export const Conversations: Story = {
  name: "Management · Task-bound conversations",
  args: { initialStep: 7, section: "Conversations" },
};
export const Activity: Story = {
  name: "Management · Activity pagination",
  args: { initialStep: 7, section: "Activity" },
};
export const MobileSetup: Story = {
  name: "Mobile · Setup",
  args: { initialStep: 1 },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const MobileReviews: Story = {
  name: "Mobile · Review and task links",
  args: { initialStep: 7, section: "Reviews" },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const VerifiedJourney: Story = {
  name: "Verification · Complete setup journey",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Create GitHub App" }),
    );
    await userEvent.click(
      await body.findByRole("button", {
        name: "Simulate App created and return",
      }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Install on GitHub" }),
    );
    await userEvent.click(
      await body.findByRole("button", {
        name: "Simulate installation completed",
      }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Choose repositories" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Check connection and tools" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect your account" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Use this GitHub account" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Configure behavior" }),
    );
    await expect(canvas.getByLabelText("Minimum passing rating")).toHaveValue(
      "5",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Continue to try it" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Finish setup" }));
    await expect(
      canvas.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();
  },
};
export const VerifiedToolGate: Story = {
  name: "Verification · Missing tools block progress",
  args: { initialStep: 4, scenario: "tools" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Connect your account" }),
    ).toBeDisabled();
    await userEvent.click(
      canvas.getByRole("button", { name: "Simulate repair and recheck" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Connect your account" }),
    ).toBeEnabled();
  },
};
export const VerifiedOverrides: Story = {
  name: "Verification · Repository settings stay isolated",
  args: { initialStep: 7, section: "Settings" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      canvas.getByLabelText("Configuration scope"),
      "acme/platform",
    );
    await userEvent.selectOptions(
      canvas.getByLabelText("Minimum passing rating"),
      "4",
    );
    await userEvent.click(
      canvas.getByRole("switch", { name: "Review draft PRs" }),
    );
    await userEvent.selectOptions(
      canvas.getByLabelText("Configuration scope"),
      "defaults",
    );
    await expect(canvas.getByLabelText("Minimum passing rating")).toHaveValue(
      "5",
    );
    await expect(
      canvas.getByRole("switch", { name: "Review draft PRs" }),
    ).toHaveAttribute("aria-checked", "false");
    await userEvent.selectOptions(
      canvas.getByLabelText("Configuration scope"),
      "acme/platform",
    );
    await expect(canvas.getByLabelText("Minimum passing rating")).toHaveValue(
      "4",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Reset to defaults" }),
    );
    await expect(canvas.getByLabelText("Minimum passing rating")).toHaveValue(
      "5",
    );
  },
};
export const VerifiedSaveRetry: Story = {
  name: "Verification · Failed save retains draft",
  args: { initialStep: 1, scenario: "save-error" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText("App name"));
    await userEvent.type(canvas.getByLabelText("App name"), "custom-reviewer");
    await userEvent.click(canvas.getByRole("button", { name: "Save & exit" }));
    await expect(canvas.getByRole("alert")).toBeVisible();
    await expect(canvas.getByLabelText("App name")).toHaveValue(
      "custom-reviewer",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Save & exit" }));
    await userEvent.click(canvas.getByRole("button", { name: "Resume setup" }));
    await expect(canvas.getByLabelText("App name")).toHaveValue(
      "custom-reviewer",
    );
  },
};
export const VerifiedGuestAccess: Story = {
  name: "Verification · Guest access is explicit",
  args: { initialStep: 7, section: "Access" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: "Allow GitHub user" }),
    );
    await userEvent.click(
      await body.findByRole("button", { name: "Look up account" }),
    );
    await expect(body.getByLabelText("Responsible sponsor")).toHaveValue(
      "Dotta",
    );
    await userEvent.click(
      body.getByRole("button", { name: "Allow this GitHub user" }),
    );
    await expect(
      canvas.getByRole("switch", {
        name: "Automatically review PRs by @external-contributor",
      }),
    ).toHaveAttribute("aria-checked", "false");
    await expect(
      canvas.getByLabelText("Responsible sponsor for @external-contributor"),
    ).toHaveValue("Dotta");
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Remove access for @external-contributor",
      }),
    );
    await expect(
      canvas.queryByRole("switch", {
        name: "Automatically review PRs by @external-contributor",
      }),
    ).toBeNull();
  },
};

export const InstallApp: Story = {
  name: "03 · Install GitHub App",
  args: { initialStep: 2 },
};
export const NoPersonalConnection: Story = {
  name: "06 · No personal GitHub connection",
  args: { initialStep: 5, scenario: "no-account" },
};
export const ExpiredPersonalConnection: Story = {
  name: "06 · Reconnect personal GitHub",
  args: { initialStep: 5, scenario: "identity-expired" },
};
export const NoRepositories: Story = {
  name: "04 · No repositories available",
  args: { initialStep: 3, scenario: "repositories-empty" },
};
export const RepositoryRefreshFailure: Story = {
  name: "04 · Repository refresh failed",
  args: { initialStep: 3, scenario: "repositories-error" },
};
export const VerifiedRepositoryRefresh: Story = {
  name: "Verification · New installation access stays disabled",
  args: { initialStep: 3 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      canvas.queryByRole("switch", { name: "acme/mobile" }),
    ).toBeNull();
    await userEvent.click(
      canvas.getAllByRole("button", { name: "Configure access on GitHub" })[0],
    );
    await userEvent.click(
      await body.findByRole("button", {
        name: "Simulate adding a repository on GitHub",
      }),
    );
    await expect(
      canvas.queryByRole("switch", { name: "acme/mobile" }),
    ).toBeNull();
    await userEvent.click(
      canvas.getByRole("button", { name: "Refresh access" }),
    );
    await expect(
      await canvas.findByRole("switch", { name: "acme/mobile" }),
    ).toHaveAttribute("aria-checked", "false");
    await expect(
      canvas.getByRole("switch", { name: "acme/platform" }),
    ).toHaveAttribute("aria-checked", "true");
  },
};
export const VerifiedPersonalConnection: Story = {
  name: "Verification · Personal sign-in requires confirmation",
  args: { initialStep: 5, scenario: "no-account" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect GitHub" }),
    );
    await userEvent.click(
      await body.findByRole("button", {
        name: "Simulate GitHub sign-in completed",
      }),
    );
    await expect(
      canvas.queryByRole("button", { name: "Configure behavior" }),
    ).toBeNull();
    await userEvent.selectOptions(
      canvas.getByLabelText("Your GitHub connection"),
      "dotta-work",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Use this GitHub account" }),
    );
    await expect(
      canvas.getByText("@dotta-work is linked to Dotta."),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Configure behavior" }),
    ).toBeEnabled();
  },
};
export const MobileAccess: Story = {
  name: "Mobile · People and sponsored access",
  args: { initialStep: 7, section: "Access", scenario: "guest" },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const VerifiedMemberAccess: Story = {
  name: "Verification · Selected member access and separate automation",
  args: { initialStep: 7, section: "Access" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      canvas.getByRole("button", { name: "Add Paperclip member" }),
    );
    await userEvent.selectOptions(await body.findByLabelText("Member"), "Sam");
    await expect(
      body.getByRole("button", { name: "Add member" }),
    ).toBeDisabled();
    await userEvent.selectOptions(body.getByLabelText("Member"), "Alex");
    await userEvent.click(body.getByRole("button", { name: "Add member" }));
    await expect(canvas.getByLabelText("Paperclip members")).toHaveValue(
      "selected",
    );
    await expect(
      canvas.getByRole("switch", { name: "Automatically review PRs by @alex" }),
    ).toHaveAttribute("aria-checked", "false");
    await userEvent.click(
      canvas.getByRole("switch", { name: "Automatically review PRs by @alex" }),
    );
    await expect(
      canvas.getByRole("switch", { name: "Automatically review PRs by @alex" }),
    ).toHaveAttribute("aria-checked", "true");
  },
};
