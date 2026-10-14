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
  id: "feature-environment-images",
  title: "Projects and execution/Execution environments/Custom images",
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
        "execution-environments/images"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CompanyEnvironments image metadata: unconfigured, captured, unsupported, failed, loading and 403. No live setup terminal, provider capture, rollback or relink is executed."
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
export const NoImage: Story = {
  parameters: {
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
};
export const CapturedImage: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Active template");
  },
  parameters: {
    image: "captured",
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
};
export const ImageReadFailed: Story = {
  parameters: {
    image: "failed",
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
};
export const UnsupportedProvider: Story = {
  parameters: {
    unsupported: true,
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
};

export const ImageLoading: Story = {
  parameters: {
    image: "loading",
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Loading template setup...");
  },
};
export const ImagePermissionDenied: Story = {
  parameters: {
    image: "denied",
    initialEntries: [
      "/PAP/company/settings/instance/environments/environment-gap/edit",
    ],
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "You do not have permission to inspect this image.",
    );
  },
};
