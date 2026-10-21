import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { CompanyEnvironments } from "@/pages/CompanyEnvironments";
import { ToastViewport } from "@/components/ToastViewport";
import { expect, userEvent, within } from "storybook/test";
import { installEnvironmentFixture } from "../../support/capability-gaps/environments";
import type { FixtureState } from "../../support/capability-gaps/api";
function Environments() {
  return (
    <>
      <Routes>
        <Route
          path="/PAP/company/settings/instance/environments"
          element={<CompanyEnvironments />}
        />
        <Route
          path="/PAP/company/settings/instance/environments/:environmentId/edit"
          element={<CompanyEnvironments mode="edit" />}
        />
      </Routes>
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-execution-environments",
  title:
    "Projects and execution/Execution environments/Configuration, capabilities, and probes",
  component: Environments,
  parameters: {
    layout: "padded",
    initialEntries: ["/PAP/company/settings/instance/environments"],
    docs: {
      description: {
        component:
          "Production environment admin page. API replies are fictional; no probe connects to a provider. List loading/errors currently fall back to empty saved environments rather than dedicated feedback.",
      },
    },
    paperclip: {
      "capabilities": [
        "execution-environments/configuration",
        "execution-environments/capabilities",
        "execution-environments/probe"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CompanyEnvironments configuration/edit, unsupported capabilities and probe pending/failure/success. No provider contacted. List read/loading failures expose shipped fallback behavior, not dedicated error UI."
    },
  },
  beforeEach: ({ parameters }) =>
    installEnvironmentFixture(
      parameters.fixtureState as FixtureState,
      parameters.image,
      parameters.unsupported,
    ).cleanup,
} satisfies Meta<typeof Environments>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Configured: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Release sandbox");
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const UnsupportedProvider: Story = { parameters: { unsupported: true } };
export const ProbeSucceeded: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Test provider",
      }),
    );
    await within(document.body).findAllByText("Provider connection succeeded.");
  },
};
export const Probing: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Test provider",
      }),
    );
    await expect(
      await within(canvasElement).findByRole("button", { name: "Testing..." }),
    ).toBeDisabled();
  },
};
export const ProbeFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", {
        name: "Test provider",
      }),
    );
    await within(document.body).findAllByText(
      "The request failed. Please try again.",
    );
  },
};
export const EditConfiguration: Story = {
  parameters: {
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
};
