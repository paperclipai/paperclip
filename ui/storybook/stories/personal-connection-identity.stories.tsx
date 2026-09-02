import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCapabilities,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { IdentitiesSection } from "@/pages/apps/app-detail/IdentitiesSection";

// ---------------------------------------------------------------------------
// PAP-17835 — personal connection identity UX review harness.
//
// One story per item in the design's "Test and screenshot gate", so the whole
// gate can be rendered and inspected at 1440x900 and 390x844 without seeding a
// live company. Fixtures are self-contained.
// ---------------------------------------------------------------------------

const CURRENT_USER = "user-carol";

const MEMBERS = [
  { userId: CURRENT_USER, name: "Carol Danvers", email: "carol@example.com" },
  { userId: "user-dotta", name: "Dotta", email: "dotta@example.com" },
  { userId: "user-sam", name: "Sam Rivera", email: "sam@example.com" },
  { userId: "user-priya", name: "Priya Raman", email: "priya@example.com" },
];

const MEMBER_CAPABILITIES: ToolConnectionCapabilities = {
  canConfigure: true,
  canCreateOrganizationGrant: true,
  canSetCompanyInstall: true,
  canConnectAsCurrentUser: true,
  canManageAgentInstalls: true,
  canViewOtherPersonalIdentities: false,
  editableAgentIds: ["a-outreach", "a-research"],
};

const MANAGER_CAPABILITIES: ToolConnectionCapabilities = {
  ...MEMBER_CAPABILITIES,
  canViewOtherPersonalIdentities: true,
};

/** A viewer sees the same legible state with no mutation controls at all. */
const VIEWER_CAPABILITIES: ToolConnectionCapabilities = {
  canConfigure: false,
  canCreateOrganizationGrant: false,
  canSetCompanyInstall: false,
  canConnectAsCurrentUser: false,
  canManageAgentInstalls: false,
  canViewOtherPersonalIdentities: false,
  editableAgentIds: [],
};

function grant(overrides: Partial<ConnectionGrant> = {}): ConnectionGrant {
  return {
    id: "grant-org",
    companyId: "company-1",
    connectionId: "conn-1",
    kind: "organization",
    subjectUserId: null,
    providerTenant: null,
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
    createdByAgentId: null,
    createdByUserId: CURRENT_USER,
    revokedAt: null,
    revokedByAgentId: null,
    revokedByUserId: null,
    lastUsedAt: null,
    createdAt: new Date("2026-08-01T10:00:00Z"),
    updatedAt: new Date("2026-08-01T10:00:00Z"),
    members: [],
    capabilities: { canRevoke: true, canEditAudience: true },
    ...overrides,
  };
}

function audienceMembers(userIds: string[]) {
  return userIds.map((userId, index) => ({
    id: `member-${index}`,
    companyId: "company-1",
    grantId: "grant-org",
    subjectType: "user" as const,
    subjectId: userId,
    createdAt: new Date("2026-08-01T10:00:00Z"),
  }));
}

function personalGrant(overrides: Partial<ConnectionGrant> = {}): ConnectionGrant {
  return grant({
    id: "grant-carol",
    kind: "user",
    subjectUserId: CURRENT_USER,
    isDefault: false,
    lastUsedAt: new Date("2026-08-19T09:12:00Z"),
    capabilities: { canRevoke: true, canEditAudience: false },
    ...overrides,
  });
}

/** Renders the fixed account surface used on the Setup tab. */
function IdentitiesHarness({
  credentialPolicy = "per_user",
  grants,
  capabilities = MEMBER_CAPABILITIES,
  loading = false,
  error = false,
  audienceGrantId = null,
  audienceError = null,
}: {
  credentialPolicy?: ToolConnectionCredentialPolicy;
  grants: ConnectionGrant[];
  capabilities?: ToolConnectionCapabilities;
  loading?: boolean;
  error?: boolean;
  audienceGrantId?: string | null;
  audienceError?: string | null;
}) {
  const [openAudience, setOpenAudience] = useState<string | null>(audienceGrantId);
  const response: ConnectionGrantsResponse = {
    connection: { id: "conn-1", uid: "conn-1" },
    grants,
    capabilities,
    currentUserId: CURRENT_USER,
    members: MEMBERS,
  };
  return (
    <div className="mx-auto max-w-4xl bg-background p-8">
      <IdentitiesSection
        appName="Gmail"
        credentialPolicy={credentialPolicy}
        ownerUserId={CURRENT_USER}
        connectedUser={{ label: "Carol", image: null }}
        grantsQuery={loading || error ? undefined : response}
        loading={loading}
        error={error}
        connectPending={false}
        audiencePending={false}
        audienceError={audienceError}
        audienceGrantId={openAudience}
        onOpenAudience={setOpenAudience}
        onCloseAudience={() => setOpenAudience(null)}
        onConnectAsMe={() => {}}
        onConnectOrganization={() => {}}
        onReplaceAudience={() => {}}
      />
    </div>
  );
}

const meta: Meta = {
  title: "Reviews/PAP-17835 Personal connection identity",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// --- Gate 3: fixed personal identity ---------------------------------------

export const SetupPersonalConnectedOrganizationHidden: Story = {
  name: "3 · Setup — your identity connected, organization hidden",
  render: () => (
    <IdentitiesHarness
      grants={[personalGrant({ providerTenant: { name: "carol@example.com" } })]}
    />
  ),
};

export const SetupPersonalNotConnected: Story = {
  name: "3b · Setup — your identity not connected (no silent fallback)",
  render: () => <IdentitiesHarness grants={[]} />,
};

// --- Gate 4: legacy alternates stay hidden after setup ---------------------

export const SetupFixedPersonalIdentity: Story = {
  name: "4 · Setup — fixed personal identity",
  render: () => (
    <IdentitiesHarness
      credentialPolicy="per_user_with_fallback"
      capabilities={MANAGER_CAPABILITIES}
      grants={[
        grant({
          providerTenant: { name: "Shared Gmail account" },
          members: audienceMembers(["user-dotta", "user-sam"]),
        }),
        personalGrant({ providerTenant: { name: "carol@example.com" } }),
        personalGrant({
          id: "grant-sam",
          subjectUserId: "user-sam",
          providerTenant: { name: "sam@example.com" },
          status: "needs_reauthorization",
        }),
        personalGrant({
          id: "grant-priya",
          subjectUserId: "user-priya",
          providerTenant: null,
          status: "revoked",
        }),
      ]}
    />
  ),
};

// --- Gate 5: audience editor, both scopes ----------------------------------

export const AudienceEditorAllMembers: Story = {
  name: "5 · Audience editor — all organization members",
  render: () => (
    <IdentitiesHarness
      credentialPolicy="shared"
      grants={[grant({ providerTenant: { name: "Shared Gmail account" } })]}
      audienceGrantId="grant-org"
    />
  ),
};

export const AudienceEditorSelectedMembers: Story = {
  name: "5b · Audience editor — selected members",
  render: () => (
    <IdentitiesHarness
      credentialPolicy="shared"
      grants={[
        grant({
          providerTenant: { name: "Shared Gmail account" },
          members: audienceMembers(["user-dotta", "user-sam"]),
        }),
      ]}
      audienceGrantId="grant-org"
    />
  ),
};

// --- Gate 6: post-revoke state --------------------------------------------

export const SetupAfterRevoke: Story = {
  name: "6 · Setup — after revoke, row stays with a reconnect path",
  render: () => (
    <IdentitiesHarness
      grants={[
        grant({ providerTenant: { name: "Shared Gmail account" } }),
        personalGrant({ status: "revoked", providerTenant: { name: "carol@example.com" } }),
      ]}
    />
  ),
};

// --- Gate 7: viewer read-only --------------------------------------------

export const SetupViewerReadOnly: Story = {
  name: "7 · Setup — viewer read-only",
  render: () => (
    <IdentitiesHarness
      credentialPolicy="shared"
      capabilities={VIEWER_CAPABILITIES}
      grants={[
        grant({
          providerTenant: { name: "Shared Gmail account" },
          members: audienceMembers(["user-dotta"]),
          capabilities: { canRevoke: false, canEditAudience: false },
        }),
      ]}
    />
  ),
};

// --- Gate 9: loading, empty, and a server denial --------------------------

export const SetupLoading: Story = {
  name: "9 · Setup — loading",
  render: () => <IdentitiesHarness grants={[]} loading />,
};

export const SetupLoadFailed: Story = {
  name: "9b · Setup — identities could not be loaded",
  render: () => <IdentitiesHarness grants={[]} error />,
};

/**
 * A refused audience save keeps the dialog open with the selection intact and
 * explains itself inline, rather than dropping the work into a toast.
 */
export const AudienceEditorServerDenial: Story = {
  name: "9c · Audience editor — server denial keeps the selection",
  render: () => (
    <IdentitiesHarness
      credentialPolicy="shared"
      grants={[
        grant({
          providerTenant: { name: "Shared Gmail account" },
          members: audienceMembers(["user-sam"]),
        }),
      ]}
      audienceGrantId="grant-org"
      audienceError="Every audience member must be an active company member."
    />
  ),
};
