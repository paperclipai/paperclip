import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { IssueAccessGrant } from "@paperclipai/shared";
import { IssueShareSheet, type ShareSheetImplicitPrincipal } from "@/components/IssueShareSheet";
import { queryKeys } from "@/lib/queryKeys";

const ISSUE_ID = "issue-share-1";
const COMPANY_ID = "company-storybook";
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 60 * 60 * 1000);

function grant(id: string, overrides: Partial<IssueAccessGrant>): IssueAccessGrant {
  return {
    id,
    issueId: ISSUE_ID,
    subjectType: "user",
    subjectId: `subject-${id}`,
    source: "explicit",
    grantedByUserId: "granter",
    grantedByAgentId: null,
    createdAt: THREE_HOURS_AGO,
    revokedAt: null,
    subjectDisplayName: "Ada Lovelace",
    subjectAvatarUrl: null,
    subjectInitials: "AL",
    agentVisibility: null,
    ...overrides,
  };
}

const IMPLICIT: ShareSheetImplicitPrincipal[] = [
  { id: "user:owner", displayName: "Grace Hopper", roleLabel: "Owner", initials: "GH" },
];

const POPULATED_GRANTS: IssueAccessGrant[] = [
  grant("g1", { source: "explicit", subjectDisplayName: "Ada Lovelace", subjectInitials: "AL" }),
  grant("g2", {
    source: "assignment",
    subjectType: "agent",
    subjectDisplayName: "ClaudeCoder",
    subjectInitials: "CC",
    agentVisibility: "discoverable",
  }),
  grant("g3", { source: "project", subjectDisplayName: "Design Guild", subjectInitials: "DG" }),
];

// A shared (discoverable) agent so the add-flow caution renders.
const SHARED_AGENT = {
  id: "agent-shared",
  companyId: COMPANY_ID,
  name: "Researcher",
  permissions: { authorizationPolicy: { agentVisibility: { mode: "discoverable" } } },
};

function makeClient(grants: IssueAccessGrant[] | undefined, opts: { loading?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false, gcTime: Infinity } },
  });
  const grantsKey = queryKeys.issues.accessGrants(ISSUE_ID);
  if (opts.loading) {
    // Seed the query as perpetually fetching so the skeleton stays up for the
    // screenshot (the mounting observer won't kick off a second fetch).
    const query = client.getQueryCache().build(client, { queryKey: grantsKey });
    query.setState({ status: "pending", fetchStatus: "fetching" } as never);
  } else {
    client.setQueryData(grantsKey, grants ?? []);
  }
  client.setQueryData(queryKeys.agents.list(COMPANY_ID), [SHARED_AGENT]);
  client.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), { users: [] });
  return client;
}

function StoryHost({
  grants,
  canManage = true,
  implicitPrincipals = [],
  initialView,
  initialAddSelection,
  loading,
}: {
  grants?: IssueAccessGrant[];
  canManage?: boolean;
  implicitPrincipals?: ShareSheetImplicitPrincipal[];
  initialView?: "list" | "add";
  initialAddSelection?: string;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const client = useMemo(() => makeClient(grants, { loading }), [grants, loading]);
  return (
    <QueryClientProvider client={client}>
      <div className="p-6">
        <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => setOpen(true)}>
          Open share sheet
        </button>
        <IssueShareSheet
          issueId={ISSUE_ID}
          companyId={COMPANY_ID}
          canManage={canManage}
          open={open}
          onOpenChange={setOpen}
          implicitPrincipals={implicitPrincipals}
          initialView={initialView}
          initialAddSelection={initialAddSelection}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof StoryHost> = {
  title: "Privacy/IssueShareSheet",
  component: StoryHost,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof StoryHost>;

export const Default: Story = {
  args: { grants: POPULATED_GRANTS, implicitPrincipals: IMPLICIT, canManage: true },
};

export const Empty: Story = {
  args: { grants: [], canManage: true },
};

export const Loading: Story = {
  args: { loading: true, canManage: true },
};

export const NonSetter: Story = {
  args: { grants: POPULATED_GRANTS, implicitPrincipals: IMPLICIT, canManage: false },
};

export const AddWithSharedAgentCaution: Story = {
  args: {
    grants: POPULATED_GRANTS,
    canManage: true,
    initialView: "add",
    initialAddSelection: "agent:agent-shared",
  },
};
