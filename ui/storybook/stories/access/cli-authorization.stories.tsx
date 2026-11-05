import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { CliAuthPage } from "@/pages/CliAuth";
import { expect, userEvent, within } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function CliAuthorization() {
  return (
    <Routes>
      <Route path="/cli-auth/:id" element={<CliAuthPage />} />
    </Routes>
  );
}
const meta = {
  id: "feature-cli-authorization",
  title:
    "Getting started and access/Login, invitations, and access/CLI authorization",
  component: CliAuthorization,
  parameters: {
    initialEntries: ["/cli-auth/challenge-gap?token=fixture-code"],
    layout: "padded",
    paperclip: {
      "capabilities": [
        "access/cli-auth"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Real CliAuth route with pending/expired/unavailable/preflight denial, approval/cancel and write pending/error. Fictional challenge; no CLI identity or real token is authorized."
    },
  },
  beforeEach: ({ parameters }) => {
    let status = parameters.status ?? "pending";
    return prepareFixtureApi(
      [
        {
          path: "/api/cli-auth/challenges/challenge-gap",
          read: () => ({
            id: "challenge-gap",
            status,
            command: "paperclipai auth login",
            clientName: "Review workstation",
            requestedAccess: "board",
            requestedCompanyId: "company-storybook",
            requestedCompanyName: "Acme Research",
            approvedAt: null,
            expiresAt: "2099-01-01T00:00:00Z",
            requiresSignIn: false,
            canApprove: !parameters.blocked,
          }),
        },
        {
          path: "/api/cli-auth/challenges/challenge-gap/approve",
          method: "POST",
          read: () => {
            status = "approved";
            return {
              approved: true,
              status,
              userId: "user-storybook",
              keyId: "fixture-key",
              expiresAt: "2099-01-01T00:00:00Z",
            };
          },
        },
        {
          path: "/api/cli-auth/challenges/challenge-gap/cancel",
          method: "POST",
          read: () => {
            status = "cancelled";
            return { cancelled: true, status };
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof CliAuthorization>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Expired: Story = { parameters: { status: "expired" } };
export const Unavailable: Story = { parameters: { fixtureState: "failure" } };
export const PermissionBlocked: Story = {
  parameters: { blocked: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Approve CLI access",
      }),
    ).toBeDisabled();
  },
};
export const Approved: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Approve CLI access" }),
    );
    await c.findByRole("heading", { name: "CLI access approved" });
  },
};
export const Approving: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Approve CLI access" }),
    );
    await expect(
      await c.findByRole("button", { name: "Approving..." }),
    ).toBeDisabled();
  },
};
export const ApprovalFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Approve CLI access" }),
    );
    await c.findByText("The request failed. Please try again.");
  },
};
export const Cancelled: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Cancel" }));
    await c.findByRole("heading", { name: "CLI auth challenge cancelled" });
  },
};
