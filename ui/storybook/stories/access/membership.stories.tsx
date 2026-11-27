import type { Meta, StoryObj } from "@storybook/react-vite";
import { Layout } from "@/components/Layout";
import { ToastViewport } from "@/components/ToastViewport";
import { Route, Routes } from "@/lib/router";
import { CompanyAccess } from "@/pages/CompanyAccess";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { expect, userEvent, within, waitFor } from "storybook/test";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
let member = {
  id: "member-gap",
  companyId: "company-storybook",
  principalType: "user",
  principalId: "user-review",
  status: "active",
  membershipRole: "operator",
  user: {
    id: "user-review",
    email: "reviewer@example.test",
    name: "Release reviewer",
    image: null,
  },
  grants: [],
  createdAt: "2026-10-12T12:00:00Z",
  updatedAt: "2026-10-12T12:00:00Z",
};
function MembershipHost() {
  return (
    <>
      <CompanyAccess />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-membership",
  title:
    "Getting started and access/Login, invitations, and access/Organization membership",
  component: MembershipHost,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "access/membership"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "CompanyAccess member list and role change with loading/empty/failure/403 and failed mutation toast. Backend actor authority, invite lifecycle and durable membership are not verified."
    },
  },
  beforeEach: ({ parameters }) => {
    member = { ...member, membershipRole: "operator", status: "active" };
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/members",
          read: () => ({
            members: parameters.fixtureState === "empty" ? [] : [member],
            access: {
              currentUserRole: "owner",
              canManageMembers: true,
              canInviteUsers: true,
              canApproveJoinRequests: true,
            },
          }),
        },
        {
          path: "/api/companies/company-storybook/join-requests",
          read: () => [],
        },
        {
          path: "/api/companies/company-storybook/members/member-gap",
          method: "PATCH",
          read: ({ body }) => {
            member = { ...member, ...body };
            return member;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof MembershipHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Members: Story = {};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const UpdateRole: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Edit" }),
    );
    const c = within(document.body);
    await userEvent.selectOptions(
      c.getByRole("combobox", { name: "Organization role" }),
      "viewer",
    );
    await userEvent.click(c.getByRole("button", { name: "Save member" }));
    await waitFor(() => expect(member.membershipRole).toBe("viewer"));
    await waitFor(() =>
      expect(c.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  },
};
export const SaveFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("button", { name: "Edit" }),
    );
    const c = within(document.body);
    await userEvent.selectOptions(
      c.getByRole("combobox", { name: "Organization role" }),
      "viewer",
    );
    await userEvent.click(c.getByRole("button", { name: "Save member" }));
    await c.findByText("The request failed. Please try again.");
  },
};
export const MembersMobile: Story = {
  globals: { viewport: { value: "mobile", isRotated: false } },
  parameters: {
    layout: "fullscreen",
    waitForViewport: true,
    initialEntries: ["/PAP/company/settings/members"],
  },
  render: () => (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="company/settings/members" element={<CompanyAccess />} />
        </Route>
      </Routes>
      <ToastViewport />
    </PluginLauncherProvider>
  ),
  play: async () => {
    const page = within(document.body);
    await expect(await page.findByRole("heading", { name: "Organization Members" })).toBeVisible();
    const table = await page.findByRole("table");
    const scroller = table.parentElement as HTMLElement;
    await waitFor(() => {
      const rect = scroller.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    });
    if (scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = scroller.scrollWidth;
      const headers = within(table).getAllByRole("columnheader");
      const lastHeader = headers[headers.length - 1]!;
      await waitFor(() => {
        expect(lastHeader.getBoundingClientRect().right).toBeLessThanOrEqual(
          scroller.getBoundingClientRect().right + 1,
        );
      });
    }
  },
};
