import { userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnection,
} from "@paperclipai/shared";
import { BrowserUseSettingsPanel } from "@/pages/apps/app-detail/BrowserUseSettingsPanel";
import { BrowserStoryProviders, mockBrowserUse } from "../fixtures/browser-use";
const connection = {
  id: "browser-use-cloud-connection",
  companyId: "storybook-company",
} as ToolConnection;
const grant = (id: string, kind: "organization" | "user"): ConnectionGrant =>
  ({
    id,
    companyId: connection.companyId,
    connectionId: connection.id,
    kind,
    status: "active",
    subjectUserId: kind === "user" ? "storybook-user" : null,
    createdByUserId: "storybook-user",
    capabilities: { canEditAudience: true, canRevoke: true },
  }) as ConnectionGrant;
const grants = {
  currentUserId: "storybook-user",
  grants: [grant("shared", "organization")],
} as ConnectionGrantsResponse;
const meta = {
  title: "Connections/Browser Use Cloud/Settings",
  component: BrowserUseSettingsPanel,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Production credential settings: per-run spending cap, saved-profile access, multiple credentials, and loading/error/permission states. Saves and provider profiles are simulated; no credentials are present.",
      },
    },
  },
  args: { connection, grants },
  beforeEach: () => mockBrowserUse(),
  decorators: [
    (Story) => (
      <BrowserStoryProviders>
        <div className="w-96 max-w-full bg-background p-4 text-foreground">
          <Story />
        </div>
      </BrowserStoryProviders>
    ),
  ],
} satisfies Meta<typeof BrowserUseSettingsPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const NoSavedProfiles: Story = {
  beforeEach: () => mockBrowserUse({ emptyProfiles: true }),
};
export const MultipleCredentials: Story = {
  args: {
    grants: {
      ...grants,
      grants: [...grants.grants, grant("personal", "user")],
    },
  },
};
export const Loading: Story = {
  beforeEach: () => mockBrowserUse({ loading: true }),
};
export const ProfileError: Story = {
  beforeEach: () => mockBrowserUse({ profilesError: true }),
};
export const SaveError: Story = {
  beforeEach: () => mockBrowserUse({ saveError: true }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Research workspace");
    await userEvent.click(
      canvas.getByRole("button", { name: "Save browser settings" }),
    );
  },
};
export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByLabelText("Research workspace"));
    await userEvent.click(
      canvas.getByRole("button", { name: "Save browser settings" }),
    );
  },
};
export const NoPermission: Story = {
  args: { grants: { ...grants, grants: [] } },
};
export const Light: Story = { globals: { theme: "light" } };
