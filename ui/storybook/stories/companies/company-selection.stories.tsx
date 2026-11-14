import type { Meta, StoryObj } from "@storybook/react-vite";
import { Companies } from "@/pages/Companies";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { storybookCompanies } from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const meta = {
  id: "feature-company-selection",
  title:
    "Getting started and access/Companies and portability/Selection and archived organizations",
  component: Companies,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "companies/selection",
        "companies/archive"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Companies list, selection storage and archived-company restoration with loading/empty/error/403. This covers the archive list/restoration side; CompanySettings archive confirmation remains an additional UI scenario."
    },
  },
  beforeEach: ({ parameters }) => {
    let companies =
      parameters.fixtureState === "empty"
        ? []
        : [
            ...storybookCompanies.map((c) => ({ ...c })),
            {
              ...storybookCompanies[0],
              id: "archived-gap",
              name: "Archived Research",
              issuePrefix: "ARC",
              status: "archived",
            },
          ];
    return prepareFixtureApi(
      [
        { path: "/api/companies", read: () => companies },
        { path: "/api/companies/stats", read: () => ({}) },
        {
          path: "/api/companies/archived-gap",
          method: "PATCH",
          read: ({ body }) => {
            companies = companies.map((c) =>
              c.id === "archived-gap" ? { ...c, ...body } : c,
            );
            return companies.find((c) => c.id === "archived-gap");
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof Companies>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Organizations: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const SelectOrganization: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const card = await c.findByRole("button", { name: /Archived Research/ });
    await userEvent.click(card);
    await waitFor(() =>
      expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe(
        "archived-gap",
      ),
    );
  },
};
export const Unarchive: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const card = (await c.findByText("Archived Research")).closest(
      '[role="button"]',
    ) as HTMLElement;
    await userEvent.click(
      card.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!,
    );
    await userEvent.click(
      await within(document.body).findByRole("menuitem", { name: "Unarchive" }),
    );
    await waitFor(() => {
      const restored = within(canvasElement)
        .getByText("Archived Research")
        .closest('[role="button"]') as HTMLElement;
      expect(within(restored).getByText("active")).toBeVisible();
    });
  },
};
