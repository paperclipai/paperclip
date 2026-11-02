import type { Meta, StoryObj } from "@storybook/react-vite";
import { CompanyImport } from "@/pages/CompanyImport";
import { expect, userEvent, within } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const files = {
  ".paperclip.yaml": "schema: paperclip/v1\n",
  "agents/reviewer/AGENTS.md": "# Reviewer\n\nReview release evidence.",
};
const preview = {
  include: { company: true, agents: true, projects: true, issues: true },
  targetCompanyId: null,
  targetCompanyName: null,
  collisionStrategy: "rename",
  selectedAgentSlugs: ["reviewer"],
  plan: {
    companyAction: "create",
    agentPlans: [
      {
        slug: "reviewer",
        action: "create",
        plannedName: "Reviewer",
        existingAgentId: null,
        reason: null,
      },
    ],
    projectPlans: [],
    issuePlans: [],
  },
  manifest: {
    agents: [
      {
        slug: "reviewer",
        name: "Reviewer",
        path: "agents/reviewer/AGENTS.md",
        adapterType: "claude_local",
      },
    ],
    projects: [],
    issues: [],
    skills: [],
    company: null,
  },
  files,
  envInputs: [],
  warnings: [],
  errors: [],
};
const meta = {
  id: "feature-company-import",
  title: "Getting started and access/Companies and portability/Import preview",
  component: CompanyImport,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "companies/portability"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Shipped CompanyImport GitHub-source preview, warnings, pending, error and 403. Plan/package replies are fictional; export, final import and real package fidelity remain separate scenarios/contracts."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      [
        {
          path: "/api/companies/import/preview",
          method: "POST",
          read: () => ({
            ...preview,
            warnings: parameters.warning
              ? ["Provider credentials are not included in this package."]
              : [],
          }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof CompanyImport>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseSource: Story = {};
async function previewPackage(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  await userEvent.type(
    await c.findByPlaceholderText(
      "https://github.com/owner/repo/tree/main/company",
    ),
    "https://github.com/example/release-team",
    { delay: 15 },
  );
  await userEvent.click(c.getByRole("button", { name: "Preview import" }));
}
export const PreviewReady: Story = {
  play: async ({ canvasElement }) => {
    await previewPackage(canvasElement);
    await within(canvasElement).findByText("Reviewer");
  },
};
export const PreviewWithWarning: Story = {
  parameters: { warning: true },
  play: async ({ canvasElement }) => {
    await previewPackage(canvasElement);
    await within(canvasElement).findByText(
      "Provider credentials are not included in this package.",
    );
  },
};
export const PreviewLoading: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    await previewPackage(canvasElement);
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Previewing...",
      }),
    ).toBeDisabled();
  },
};
export const PreviewFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await previewPackage(canvasElement);
    await within(canvasElement).findByText(/The request failed/);
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "mutation-permission" },
  play: async ({ canvasElement }) => {
    await previewPackage(canvasElement);
    await within(canvasElement).findByText(/You do not have permission/);
  },
};
