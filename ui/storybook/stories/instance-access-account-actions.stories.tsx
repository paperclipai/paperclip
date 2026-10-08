import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminUserDirectoryEntry, UserCompanyAccessResponse } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { InstanceAccess } from "@/pages/InstanceAccess";

/**
 * Instance settings > Access: an instance admin disables, re-enables or deletes
 * another user's account. The page selects the first user in the list, so each
 * story puts the account it shows first.
 */

const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";

const company = {
  id: "company-storybook",
  name: "Acme Robotics",
  issuePrefix: "ACM",
  status: "active",
};

const admin: AdminUserDirectoryEntry = {
  id: ADMIN_ID,
  email: "admin@example.com",
  name: "Avery Admin",
  image: null,
  isInstanceAdmin: true,
  activeCompanyMembershipCount: 1,
  status: "active",
  disabledAt: null,
  disabledByUserId: null,
  disabledReason: null,
};

const member: AdminUserDirectoryEntry = {
  ...admin,
  id: MEMBER_ID,
  email: "sam@example.com",
  name: "Sam Signup",
  isInstanceAdmin: false,
};

const disabledMember: AdminUserDirectoryEntry = {
  ...member,
  status: "disabled",
  disabledAt: "2026-10-01T09:30:00.000Z",
  disabledByUserId: ADMIN_ID,
  disabledReason: "Spam sign-up",
};

function seededClient(users: AdminUserDirectoryEntry[]) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  client.setQueryData(queryKeys.auth.session, {
    session: { id: "session-admin", userId: ADMIN_ID },
    user: { id: ADMIN_ID, email: admin.email, name: admin.name },
  });
  client.setQueryData(queryKeys.access.adminUsers(""), users);
  client.setQueryData(queryKeys.companies.directory(ADMIN_ID), [company]);
  for (const user of users) {
    const access: UserCompanyAccessResponse = {
      user: { id: user.id, email: user.email, name: user.name, image: null, isInstanceAdmin: user.isInstanceAdmin },
      companyAccess: [{
        id: `membership-${user.id}`,
        companyId: company.id,
        principalType: "user",
        principalId: user.id,
        status: "active",
        membershipRole: "operator",
        createdAt: "2026-09-20T12:00:00.000Z",
        updatedAt: "2026-09-20T12:00:00.000Z",
        companyName: company.name,
        companyStatus: "active",
      }],
    };
    client.setQueryData(queryKeys.access.userCompanyAccess(user.id), access);
  }
  return client;
}

/**
 * Clicks an account action once it renders, so the story opens on its dialog.
 * The search stays inside this story's container: the Docs view renders every
 * story on one page, and the others have the same buttons.
 */
function useOpenAction(container: RefObject<HTMLDivElement | null>, label: string | undefined) {
  useEffect(() => {
    if (!label) return;
    const tick = window.setInterval(() => {
      const action = Array.from(container.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])
        .find((button) => button.textContent === label);
      if (!action) return;
      window.clearInterval(tick);
      action.click();
    }, 50);
    return () => window.clearInterval(tick);
  }, [container, label]);
}

function InstanceAccessHost({ users, openAction }: { users: AdminUserDirectoryEntry[]; openAction?: string }) {
  const client = useMemo(() => seededClient(users), [users]);
  const container = useRef<HTMLDivElement>(null);
  useOpenAction(container, openAction);
  return (
    <QueryClientProvider client={client}>
      <div ref={container} className="mx-auto max-w-5xl p-6">
        <InstanceAccess />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Instance settings/Access account actions",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const ActiveUser: Story = {
  name: "Active user",
  render: () => <InstanceAccessHost users={[member, admin]} />,
};

export const DisableConfirmation: Story = {
  name: "Disable confirmation",
  render: () => <InstanceAccessHost users={[member, admin]} openAction="Disable user" />,
};

export const DeleteConfirmation: Story = {
  name: "Delete confirmation",
  render: () => <InstanceAccessHost users={[member, admin]} openAction="Delete user" />,
};

export const DisabledUser: Story = {
  name: "Disabled user",
  render: () => <InstanceAccessHost users={[disabledMember, admin]} />,
};
