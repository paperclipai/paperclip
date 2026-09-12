import { AiReviewFrame, aiReviewContext } from "../prototypes/AiReviewFrame";
import { AiTaskConnectionReview } from "../prototypes/AiTaskConnectionReview";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AiConnectionsReview } from "../prototypes/AiConnectionsReview";
import { AiConnectorPages } from "../prototypes/AiConnectorPages";
import {
  AI_REVIEW_BINDING,
  AI_REVIEW_CONNECTIONS,
  AI_REVIEW_REQUIREMENT,
} from "../fixtures/aiConnections";

const meta = {
  title: "AI Connections/Review",
  component: AiConnectionsReview,
  parameters: { layout: "fullscreen" },
  decorators: [(Story, context) => (
    <AiReviewFrame {...aiReviewContext(context.id, context.args)}><Story /></AiReviewFrame>
  )],
} satisfies Meta<typeof AiConnectionsReview>;
export default meta;
type Story = StoryObj<typeof meta>;

const groups = [
  [
    "Connections",
    [
      ["Existing Connectors page with AI providers", "provider-catalog"],
      ["Connection list", "connections"],
      ["Add account through existing Connectors", "connect-from-existing-catalog"],
      ["Provider and identity matrix", "identity-matrix"],
      ["Manage account", "management"],
      ["Change personal default", "change-personal-default"],
      ["Unavailable default", "revoked-default"],
    ],
  ],
  [
    "Choose an account",
    [
      ["Responsible user", "responsible-user"],
      ["Company shared", "shared-selected"],
      ["Human access denied", "shared-audience-denied"],
      ["Another responsible user", "another-user-missing"],
      ["Incompatible selection", "incompatible-selection"],
    ],
  ],
  [
    "Authentication",
    [
      ["Claude subscription", "claude-subscription"],
      ["ChatGPT subscription", "chat-gpt-subscription"],
      ["Grok subscription", "grok-subscription"],
      ["API key", "open-router-api-key"],
      ["Invalid credentials and retry", "api-key-retry"],
      ["Expired sign-in", "expired-attempt"],
      ["Cancel and restore focus", "cancel-and-restore-focus"],
    ],
  ],
  [
    "Complete flows",
    [
      ["First onboarding", "first-onboarding"],
      ["Onboarding reuse", "onboarding-reuse"],
      ["New-agent reuse", "new-agent-reuse"],
      ["Inline task connection", "inline-task-connection"],
      ["Inline task reuse", "inline-task-reuse"],
      ["Settings change", "settings-change"],
      ["Legacy adoption", "legacy-adoption"],
    ],
  ],
] as const;

export const ReviewIndex: Story = {
  render: () => (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">AI Connections · Review index</h1>
      <p className="text-sm text-muted-foreground">
        Milestone 1: shared UI, simulated accounts, no live authentication.
        Start with the existing Connectors page, then account details, provider
        sign-in and agent connection selection. Use the Storybook toolbar for light/dark themes and narrow
        viewports.
      </p>
      <p className="text-sm">
        Personal defaults are per company, provider, and sign-in method.
        Connection selection never changes harness or model. Unavailable
        accounts block without fallback.
      </p>
      {groups.map(([title, links]) => (
        <section key={title} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          {links.map(([label, id]) => (
            <a
              className="text-sm underline underline-offset-2"
              key={id}
              href={`/?path=/story/ai-connections-review--${id}`}
              target="_top"
            >
              {label}
            </a>
          ))}
        </section>
      ))}
      <p className="text-xs text-muted-foreground">
        Additional stories cover read-only, loading, denied access,
        reauthorization, revocation, mobile, and unsupported environments.
        Runtime enforcement and data migration follow UI review.
      </p>
    </main>
  ),
};
export const ProviderCatalog: Story = {
  args: { host: "connections", initialStage: "providers" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Add account Anthropic" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Connect Gmail" })).toBeVisible();
    await userEvent.type(canvas.getByPlaceholderText("Search connectors…"), "Claude");
    await expect(canvas.queryByRole("button", { name: "Connect Gmail" })).not.toBeInTheDocument();
    await userEvent.clear(canvas.getByPlaceholderText("Search connectors…"));
  },
};
export const ConnectFromExistingCatalog: Story = {
  args: { host: "connections" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add account Anthropic" }));
    await userEvent.click(await canvas.findByRole("radio", { name: "Any agent" }));
    await userEvent.click(canvas.getByRole("button", { name: /^(Save and continue|Continue)$/ }));
    const name = await canvas.findByLabelText("Connection name");
    await userEvent.clear(name); await userEvent.type(name, "My additional Claude account");
    await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await canvas.findByLabelText("Authorization code"), "fixture-code");
    await userEvent.click(canvas.getByRole("button", { name: "Submit code" }));
    await userEvent.click(canvas.getByRole("button", { name: "Use connection" }));
    await expect(await canvas.findByLabelText("AI account settings")).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "My additional Claude account" })).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: "Connectors" }));
    await expect(await canvas.findByRole("button", { name: "Open My additional Claude account permissions" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Open My Claude subscription permissions" })).toBeVisible();
  },
};
export const Connections: Story = { args: { host: "connections" } };
export const IdentityMatrix: Story = {
  render: () => <AiConnectorPages />,
};
export const ResponsibleUser: Story = {};
export const SharedSelected: Story = {
  args: {
    initialBinding: {
      ...AI_REVIEW_BINDING,
      mode: "shared",
      connectionId: "claude-shared",
      grantId: "grant-shared",
    },
  },
};
export const LegacyPersonalSelectionBlocked: Story = {
  args: {
    initialBinding: {
      ...AI_REVIEW_BINDING,
      mode: "delegated",
      connectionId: "claude-sam",
      grantId: "grant-sam",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent("This credential is not shared with you");
    await expect(canvas.queryByRole("button", { name: /Sam’s Claude/ })).not.toBeInTheDocument();
  },
};
export const NoAccounts: Story = { args: { initialConnections: [] } };
export const AnotherUserMissing: Story = {
  args: { currentUserId: "sam", host: "task" },
};
export const IncompatibleSelection: Story = {
  args: {
    initialBinding: {
      mode: "shared",
      provider: "openai",
      method: "api_key",
      connectionId: "openai-api",
      grantId: "grant-openai-api",
    },
  },
};
export const Loading: Story = { args: { loading: true } };
export const LoadFailed: Story = {
  args: { error: "Could not load AI connections. Try again." },
};
export const ReadOnly: Story = { args: { readOnly: true } };
export const SharedAudienceDenied: Story = {
  args: {
    initialConnections: AI_REVIEW_CONNECTIONS.map((row) =>
      row.id === "claude-shared"
        ? {
            ...row,
            unavailableReason:
              "The responsible user is not permitted to use this company account.",
          }
        : row,
    ),
  },
};
export const RevokedDefault: Story = {
  args: {
    initialConnections: AI_REVIEW_CONNECTIONS.map((row) =>
      row.id === "claude-dotta" ? { ...row, status: "revoked" } : row,
    ),
  },
};
export const ChangePersonalDefault: Story = {
  args: {
    host: "connections", initialStage: "manage",
    initialConnections: [AI_REVIEW_CONNECTIONS[1], ...AI_REVIEW_CONNECTIONS.filter((row) => row.id !== AI_REVIEW_CONNECTIONS[1].id)],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Make default" }));
    await expect(canvas.getByLabelText("AI account settings")).toHaveTextContent("Personal default");
    await expect(canvas.getByLabelText("AI account settings")).toHaveTextContent("Your default");
    await expect(canvas.queryByRole("button", { name: "Make default" })).not.toBeInTheDocument();
  },
};

const authArgs = { initialStage: "auth" as const };
const waiting = {
  phase: "waiting" as const,
  authorizationUrl: "#storybook-provider-simulator",
  code: "DEMO-CODE",
};
export const ClaudeSubscription: Story = {
  args: { ...authArgs, initialAuthState: waiting },
};
export const ChatGptSubscription: Story = {
  args: {
    ...authArgs,
    requirement: { ...AI_REVIEW_REQUIREMENT, provider: "openai" },
    initialAuthState: waiting,
  },
};
export const GrokSubscription: Story = {
  args: {
    ...authArgs,
    requirement: { ...AI_REVIEW_REQUIREMENT, provider: "xai" },
    initialAuthState: waiting,
  },
};
export const ClaudeApiKey: Story = {
  args: {
    ...authArgs,
    requirement: { ...AI_REVIEW_REQUIREMENT, method: "api_key" },
  },
};
export const OpenAiApiKey: Story = {
  args: {
    ...authArgs,
    requirement: {
      ...AI_REVIEW_REQUIREMENT,
      provider: "openai",
      method: "api_key",
    },
  },
};
export const OpenRouterApiKey: Story = {
  args: {
    ...authArgs,
    requirement: {
      ...AI_REVIEW_REQUIREMENT,
      provider: "openrouter",
      method: "api_key",
    },
  },
};
export const GrokApiKey: Story = {
  args: {
    ...authArgs,
    requirement: {
      ...AI_REVIEW_REQUIREMENT,
      provider: "xai",
      method: "api_key",
    },
  },
};
export const PreparingLogin: Story = {
  args: { ...authArgs, initialAuthState: { phase: "starting" } },
};
export const Connected: Story = {
  args: { ...authArgs, initialAuthState: { phase: "connected" } },
};
export const Cancelled: Story = {
  args: { ...authArgs, initialAuthState: { phase: "cancelled" } },
};
export const ExpiredAttempt: Story = {
  args: {
    ...authArgs,
    initialAuthState: {
      phase: "expired",
      message:
        "This sign-in attempt expired. Start again to receive a new code.",
    },
  },
};
export const UnsupportedEnvironment: Story = {
  args: {
    ...authArgs,
    initialAuthState: {
      phase: "unsupported",
      message:
        "Subscription sign-in is unavailable in this environment. Choose an environment that supports this provider’s login.",
    },
  },
};
export const InvalidCredentials: Story = {
  args: {
    ...authArgs,
    requirement: { ...AI_REVIEW_REQUIREMENT, method: "api_key" },
    initialAuthState: {
      phase: "error",
      message:
        "The provider rejected this API key. Check the key and try again.",
    },
  },
};
export const ApiKeyRetry: Story = {
  args: {
    ...authArgs,
    initialConnections: [],
    requirement: {
      ...AI_REVIEW_REQUIREMENT,
      provider: "openrouter",
      method: "api_key",
    },
    failFirstAttempt: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("API key"),
      "storybook-not-a-key",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "could not verify",
    );
    await expect(canvas.getByLabelText("API key")).toHaveValue("");
    await userEvent.type(
      canvas.getByLabelText("API key"),
      "storybook-retry-not-a-key",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Connect" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Connected.");
    await userEvent.click(
      canvas.getByRole("button", { name: "Use connection" }),
    );
    await expect(canvas.getByText("For you: My OpenRouter API")).toBeVisible();
  },
};

export const FirstOnboarding: Story = {
  args: { host: "onboarding", initialConnections: [], initialStage: "auth" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));
    await userEvent.type(
      canvas.getByLabelText("Authorization code"),
      "storybook-code",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Submit code" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Use connection" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Create another agent using existing connections",
      }),
    );
    await expect(
      canvas.getByText("For you: My Claude subscription"),
    ).toBeVisible();
    await expect(canvas.getByTestId("ai-harness")).toHaveTextContent(
      "Claude Code",
    );
  },
};
export const OnboardingReuse: Story = { args: { host: "onboarding" } };
export const NewAgentReuse: Story = { args: { host: "new_agent" } };
export const InlineTaskConnection: Story = {
  render: () => <AiTaskConnectionReview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement); const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Connect" }));
    const dialog = within(await body.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("button", { name: /^(Save and continue|Continue)$/ }));
    await userEvent.click(await dialog.findByRole("button", { name: "Sign in" }));
    await userEvent.type(dialog.getByLabelText("Authorization code"), "fixture-task-code");
    await userEvent.click(dialog.getByRole("button", { name: "Submit code" }));
    await userEvent.click(dialog.getByRole("button", { name: "Use connection" }));
    await expect(await canvas.findByText("Claude connected")).toBeVisible();
    await expect(canvas.getByTestId("connection-intent-focus-target")).toHaveFocus();
  },
};
export const InlineTaskReuse: Story = {
  render: () => <AiTaskConnectionReview reuse />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement); const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Connect / Use existing" }));
    const dialog = within(await body.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("button", { name: "My Claude subscription" }));
    await expect(await canvas.findByText("Claude connected")).toBeVisible();
  },
};
export const SettingsChange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Engineering Claude" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Engineering Claude" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(canvas.getByTestId("ai-harness")).toHaveTextContent(
      "Claude Code",
    );
    await expect(canvas.getByTestId("ai-model")).toHaveTextContent(
      "Configured Claude model",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Save connection" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Connection selected for Nova",
    );
  },
};
export const CancelAndRestoreFocus: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect another account" }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(
      canvas.getByRole("button", { name: "Connect another account" }),
    ).toHaveFocus();
    await expect(
      canvas.getByText("For you: My Claude subscription"),
    ).toBeVisible();
  },
};
export const Management: Story = {
  args: { host: "connections", initialStage: "manage" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { name: "Which humans can use this credential?" })).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Which agents can use this connection?" })).toBeVisible();
    await expect(canvas.queryByText("Authorized use for other users’ tasks")).not.toBeInTheDocument();
  },
};
export const ManagementReadOnly: Story = {
  args: { host: "connections", initialStage: "manage", readOnly: true },
};
export const ReconnectExisting: Story = {
  args: {
    host: "connections",
    initialStage: "manage",
    initialConnections: AI_REVIEW_CONNECTIONS.map((connection) =>
      connection.id === "claude-dotta"
        ? { ...connection, status: "expired" }
        : connection,
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Reconnect" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Sign in" }));
    await userEvent.type(await canvas.findByLabelText("Authorization code"), "fixture-reconnect");
    await userEvent.click(canvas.getByRole("button", { name: "Submit code" }));
    await userEvent.click(canvas.getByRole("button", { name: "Use connection" }));
    await expect(await canvas.findByRole("heading", { name: "My Claude subscription" })).toBeVisible();
    await expect(canvas.getByLabelText("AI account settings")).toHaveTextContent("Your default");
  },
};
export const RevokeConnection: Story = {
  args: { host: "connections", initialStage: "manage" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement); const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Revoke identity" }));
    const dialog = within(await body.findByRole("alertdialog"));
    await expect(dialog.getByText(/Existing runs may retain credentials/)).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Revoke identity" }));
    await expect(canvas.getByLabelText("AI account settings")).toHaveTextContent("Default unavailable");
  },
};
export const LegacyAdoption: Story = {
  args: { initialStage: "legacy" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Choose a managed connection" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Adopt connection" }),
    ).toBeDisabled();
    await userEvent.click(
      canvas.getByRole("button", { name: "Test selected connection" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Adopt connection" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Managed connection adopted.",
    );
  },
};
export const MobilePicker: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const MobileAuthentication: Story = {
  args: { ...authArgs, initialAuthState: waiting },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
