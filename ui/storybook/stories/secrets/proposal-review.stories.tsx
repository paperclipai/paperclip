import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SecretProposalView } from "@paperclipai/shared";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { ProposalsTab } from "@/pages/secrets/ProposalsTab";
import { ToastViewport } from "@/components/ToastViewport";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const proposal: SecretProposalView = {
  id: "proposal-gap",
  companyId: "company-storybook",
  kind: "secret",
  status: "pending",
  justification: "The deploy task needs access to the GitHub API.",
  proposedName: "dev/github/token",
  proposedKey: "token",
  proposedDescription: null,
  valueFingerprintSha256: "abcdef0123456789abcdef",
  valueLength: 40,
  secretId: null,
  secretName: null,
  secretProposalId: null,
  secretProposalName: null,
  targetType: null,
  target: null,
  configPath: null,
  proposedBy: { id: "agent-coder", name: "Codex Coder", icon: "code" },
  originIssue: { id: "task-gap", key: "PAP-42", title: "Deploy preview" },
  originRunId: "run-gap",
  expiresAt: "2099-10-13T12:00:00Z",
  createdAt: "2026-10-12T12:00:00Z",
  resolvedByUserId: null,
  resolvedAt: null,
  resolutionReason: null,
  createdSecretId: null,
  appliedBindingConfigPath: null,
  viewerCanApprove: true,
  approveBlockReason: null,
};
let rows: SecretProposalView[] = [];
function ProposalReview() {
  return (
    <>
      <ProposalsTab companyId="company-storybook" providerConfigs={[]} />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-secret-proposal-review",
  title: "Apps, channels, and extensions/Secrets and proposals/Proposal review",
  component: ProposalReview,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "secrets/proposals"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Pending proposal, authority preflight block, list states and rejected proposal/rejection error. ProposalsTab and its dialogs are shipped; secret creation, values and grant authority are not exercised."
    },
  },
  beforeEach: ({ parameters }) => {
    rows =
      parameters.fixtureState === "empty"
        ? []
        : [
            {
              ...proposal,
              viewerCanApprove: !parameters.blocked,
              approveBlockReason: parameters.blocked
                ? "Only an authorized secret administrator can approve this proposal."
                : null,
            },
          ];
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/secret-proposals",
          read: () => rows,
        },
        {
          path: /^\/api\/companies\/company-storybook\/secret-proposals\/proposal-gap\/(approve|reject)$/,
          method: "POST",
          read: ({ url, body }) => {
            const result = {
              ...rows[0],
              status: url.pathname.endsWith("approve")
                ? ("approved" as const)
                : ("rejected" as const),
              resolutionReason: String(body.reason ?? ""),
              resolvedAt: "2026-10-13T12:00:00Z",
            };
            rows = [];
            return result;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof ProposalReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionBlocked: Story = {
  parameters: { blocked: true },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", { name: "Approve" }),
    ).toBeDisabled();
  },
};
export const RejectProposal: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("button", { name: "Reject" }));
    const body = within(document.body);
    await userEvent.type(
      await body.findByRole("textbox"),
      "The task can use the existing managed connection.",
      { delay: 15 },
    );
    await userEvent.click(
      within(body.getByRole("dialog")).getByRole("button", { name: "Reject" }),
    );
    await waitFor(() => expect(rows).toHaveLength(0));
    await body.findByText("Proposal rejected");
  },
};
export const RejectFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Reject" }),
    );
    const body = within(document.body);
    await userEvent.type(
      await body.findByRole("textbox"),
      "Use the existing connection.",
      { delay: 15 },
    );
    await userEvent.click(
      within(body.getByRole("dialog")).getByRole("button", { name: "Reject" }),
    );
    await body.findByText("The request failed. Please try again.");
  },
};
