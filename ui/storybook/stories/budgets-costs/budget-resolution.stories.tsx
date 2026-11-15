import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BudgetIncident } from "@paperclipai/shared";
import { expect, userEvent, within, waitFor } from "storybook/test";
import type { ComponentProps } from "react";
import { Costs } from "@/pages/Costs";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const incident: BudgetIncident = {
  id: "budget-gap",
  companyId: "company-storybook",
  policyId: "policy-gap",
  scopeType: "company",
  scopeId: "company-storybook",
  scopeName: "Acme Research",
  metric: "billed_cents",
  windowKind: "calendar_month_utc",
  windowStart: new Date("2026-10-01"),
  windowEnd: new Date("2026-11-01"),
  thresholdType: "hard",
  amountLimit: 10000,
  amountObserved: 12000,
  status: "open",
  approvalId: null,
  approvalStatus: null,
  resolvedAt: null,
  createdAt: new Date("2026-10-12"),
  updatedAt: new Date("2026-10-12"),
};

let currentIncident: BudgetIncident;
function BudgetHost(props: NonNullable<ComponentProps<typeof Costs>>) {
  return <Costs {...props} />;
}
const meta = {
  id: "feature-budget-resolution",
  title: "Oversight and operation/Costs and budgets/Resolve a budget incident",
  component: BudgetHost,
  args: { embedded: true, initialTab: "budgets", lockTab: true },
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "budgets-costs/resolution"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Shipped Costs budget tab with empty/read failures, invalid amount, raise-and-resume, keep-paused and write failure/pending. Fixture incident transitions only; real overlapping holds and hard stops remain separate. The upstream budget UI distinguishes soft warnings from hard stops; hard incidents retain raise-and-resume and keep-paused controls."
    },
  },
  beforeEach: ({ parameters }) => {
    currentIncident = { ...incident };
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/budgets/overview",
          read: () => ({
            companyId: "company-storybook",
            policies: [],
            activeIncidents:
              parameters.fixtureState === "empty" ||
              currentIncident.status !== "open"
                ? []
                : [currentIncident],
            pausedAgentCount: parameters.fixtureState==="empty"?0:currentIncident.status === "open" ? 1 : 0,
            pausedProjectCount: 0,
            pendingApprovalCount: 0,
          }),
        },
        {
          path: "/api/companies/company-storybook/budget-incidents/budget-gap/resolve",
          method: "POST",
          read: ({ body }) => {
            currentIncident = {
              ...currentIncident,
              status: body.action === "keep_paused" ? "dismissed" : "resolved",
              resolvedAt: new Date(),
              amountLimit: Number(body.amount ?? currentIncident.amountLimit),
            };
            return currentIncident;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof BudgetHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DecisionRequired: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByRole("button", {
      name: "Raise budget & resume",
    });
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const LoadFailed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const InvalidAmount: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await c.findByRole("button", { name: "Raise budget & resume" });
    const input = c.getByPlaceholderText("0.00");
    await userEvent.clear(input);
    await userEvent.type(input, "100", { delay: 15 });
    await expect(
      c.getByRole("button", { name: "Raise budget & resume" }),
    ).toBeDisabled();
  },
};
export const RaiseAndResume: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Raise budget & resume" }),
    );
    await waitFor(() => expect(currentIncident.status).toBe("resolved"));
    await waitFor(() =>
      expect(
        c.queryByRole("button", { name: "Raise budget & resume" }),
      ).not.toBeInTheDocument(),
    );
  },
};
export const KeepPaused: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Keep paused" }),
    );
    await waitFor(() => expect(currentIncident.status).toBe("dismissed"));
  },
};
export const Saving: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Raise budget & resume" }),
    );
    await expect(
      await c.findByRole("button", { name: "Applying..." }),
    ).toBeDisabled();
  },
};
export const SaveFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Raise budget & resume" }),
    );
    await c.findByRole("alert");
    await expect(
      c.getByRole("button", { name: "Raise budget & resume" }),
    ).toBeEnabled();
  },
};
