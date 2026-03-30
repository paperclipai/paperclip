import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { credentialsApi } from "../api/credentials";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Check, Send, KeyRound, Trash2, Star, Pencil, X, Users, Shield, UserPlus, Copy, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
  HintIcon
} from "../components/agent-config-primitives";
import type { CompanySettings as CompanySettingsType, CompanyMembership, CredentialType, JoinRequest, PermissionKey, ProviderCredential, TelegramNotificationLevel } from "@paperclipai/shared";
import { PERMISSION_KEYS, ROLE_PRESETS } from "@paperclipai/shared";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [telegramNotificationLevel, setTelegramNotificationLevel] = useState<TelegramNotificationLevel>("important");

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    const s = selectedCompany.settings as CompanySettingsType | undefined;
    setTelegramChatId(s?.telegram?.chatId ?? "");
    setTelegramNotificationLevel(s?.telegram?.notificationLevel ?? "important");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "agent"
      }),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : "Failed to create invite"
      );
    }
  });

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);
  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field label="Company name" hint="The display name for your company.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the company profile."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional company description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-2">
              <Field
                label="Brand color"
                hint="Sets the hue for the company icon. Leave empty for auto-generated color."
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder="Auto"
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                ? generalMutation.error.message
                : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
          />
        </div>
      </div>

      {/* Notifications */}
      <TelegramSection
        companyId={selectedCompanyId!}
        telegramChatId={telegramChatId}
        setTelegramChatId={setTelegramChatId}
        savedChatId={(selectedCompany.settings as CompanySettingsType | undefined)?.telegram?.chatId ?? ""}
        notificationLevel={telegramNotificationLevel}
        setNotificationLevel={setTelegramNotificationLevel}
        savedNotificationLevel={(selectedCompany.settings as CompanySettingsType | undefined)?.telegram?.notificationLevel ?? "important"}
      />

      {/* Credentials */}
      <CredentialsSection companyId={selectedCompanyId!} />

      {/* Members & Permissions */}
      <MembersSection companyId={selectedCompanyId!} />

      {/* Invites */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Generate an agent snippet for join flows.
            </span>
            <HintIcon text="Creates an agent-only invite (10m) and renders a copy-ready snippet." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? "Generating..."
                : "Generate agent snippet"}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  Agent Snippet
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    Copied
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied ? "Copied snippet" : "Copy snippet"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : selectedCompany.status === "archived"
                ? "Already archived"
                : "Archive company"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive company"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Permission display helpers ----

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  "agents:create": "Create agents",
  "users:invite": "Invite people",
  "users:manage_permissions": "Manage permissions",
  "tasks:assign": "Assign issues",
  "tasks:assign_scope": "Assign (scoped)",
  "joins:approve": "Approve joins",
  "projects:manage": "Manage projects",
  "goals:manage": "Manage goals",
  "secrets:manage": "Manage secrets",
  "credentials:manage": "Manage credentials",
  "company:settings": "Company settings",
  "company:export": "Export & import",
  "approvals:review": "Review approvals",
  "issues:manage": "Manage issues",
};

const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  "agents:create": "Create new agents in the company.",
  "users:invite": "Invite people (humans or agents) to the company.",
  "users:manage_permissions": "Grant and revoke permissions for members.",
  "tasks:assign": "Assign issues to agents.",
  "tasks:assign_scope": "Assign issues with scope restrictions.",
  "joins:approve": "Approve or reject join requests.",
  "projects:manage": "Create, update, and archive projects.",
  "goals:manage": "Create, update, and delete goals.",
  "secrets:manage": "Manage company secrets and environment variables.",
  "credentials:manage": "Manage provider credentials (API keys, OAuth).",
  "company:settings": "Modify company settings and configuration.",
  "company:export": "Export and import company data.",
  "approvals:review": "Review and resolve approval requests.",
  "issues:manage": "Create, update, and delete issues and labels.",
};

// ---- Members & Permissions Section ----

function MembersSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  // State
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);
  const [editingGrants, setEditingGrants] = useState<Record<PermissionKey, boolean>>({} as Record<PermissionKey, boolean>);
  const [showHumanInvite, setShowHumanInvite] = useState(false);
  const [humanInviteUrl, setHumanInviteUrl] = useState<string | null>(null);
  const [humanInviteCopied, setHumanInviteCopied] = useState(false);

  // Fetch members
  const {
    data: members = [],
    isLoading: membersLoading,
    isError: membersError,
  } = useQuery({
    queryKey: queryKeys.access.members(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    retry: false,
  });

  // Fetch join requests (pending)
  const {
    data: pendingJoinRequests = [],
    isLoading: joinRequestsLoading,
  } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId),
    queryFn: () => accessApi.listJoinRequests(companyId, "pending_approval"),
    retry: false,
  });

  // Update permissions mutation
  const permissionsMutation = useMutation({
    mutationFn: ({
      memberId,
      grants,
    }: {
      memberId: string;
      grants: Array<{ permissionKey: PermissionKey }>;
    }) => accessApi.updateMemberPermissions(companyId, memberId, grants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.access.members(companyId) });
      setExpandedMemberId(null);
    },
  });

  // Approve/reject join request mutations
  const approveMutation = useMutation({
    mutationFn: (requestId: string) =>
      accessApi.approveJoinRequest(companyId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.members(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) =>
      accessApi.rejectJoinRequest(companyId, requestId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.access.joinRequests(companyId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(companyId),
      });
    },
  });

  // Human invite mutation
  const humanInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createHumanInvite(companyId, { allowedJoinTypes: "human" }),
    onSuccess: (invite) => {
      const base = window.location.origin.replace(/\/+$/, "");
      const url = `${base}/invite/${invite.token}`;
      setHumanInviteUrl(url);
      setHumanInviteCopied(false);
    },
  });

  function startEditPermissions(member: CompanyMembership) {
    if (expandedMemberId === member.id) {
      setExpandedMemberId(null);
      return;
    }
    const initial = {} as Record<PermissionKey, boolean>;
    for (const key of PERMISSION_KEYS) {
      initial[key] = (member.grants ?? []).includes(key);
    }
    setEditingGrants(initial);
    setExpandedMemberId(member.id);
  }

  function handleSavePermissions(memberId: string) {
    const grants: Array<{ permissionKey: PermissionKey }> = [];
    for (const key of PERMISSION_KEYS) {
      if (editingGrants[key]) {
        grants.push({ permissionKey: key });
      }
    }
    permissionsMutation.mutate({ memberId, grants });
  }

  function memberStatusColor(status: string) {
    switch (status) {
      case "active":
        return "bg-green-500/10 text-green-600";
      case "pending":
        return "bg-yellow-500/10 text-yellow-600";
      case "suspended":
        return "bg-red-500/10 text-red-600";
      default:
        return "bg-muted text-muted-foreground";
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Members & Permissions
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <div className="flex items-center gap-1.5">
          <Users className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Manage company members and their permissions.
          </span>
          <HintIcon text="Members include both human users and agents. Permissions control what actions they can perform." />
        </div>

        {/* Member list */}
        {membersLoading ? (
          <p className="text-xs text-muted-foreground">Loading members...</p>
        ) : membersError ? (
          <p className="text-xs text-muted-foreground">
            Unable to load members. You may not have the required permission.
          </p>
        ) : members.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No members found.
          </p>
        ) : (
          <div className="space-y-1">
            {members.map((member) => (
              <div key={member.id}>
                {/* Member row */}
                <div
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => startEditPermissions(member)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {member.displayName || member.email || member.principalId}
                    </span>
                    {member.email && member.displayName && (
                      <span className="shrink-0 text-xs text-muted-foreground truncate max-w-[200px]">
                        {member.email}
                      </span>
                    )}
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {member.principalType}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${memberStatusColor(
                        member.status
                      )}`}
                    >
                      {member.status}
                    </span>
                    {member.membershipRole && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {member.membershipRole}
                      </span>
                    )}
                    {(member.grants?.length ?? 0) > 0 && (
                      <span className="shrink-0 rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">
                        {member.grants!.length} permissions
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                    {expandedMemberId === member.id ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                </div>

                {/* Permission editor (expanded) */}
                {expandedMemberId === member.id && (
                  <div className="mt-1 space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium text-muted-foreground">
                        Permissions
                      </div>
                      <div className="flex items-center gap-1">
                        {ROLE_PRESETS.map((preset) => (
                          <button
                            key={preset.id}
                            onClick={() => {
                              const next: Record<string, boolean> = {};
                              for (const k of PERMISSION_KEYS) next[k] = false;
                              for (const k of preset.permissions) next[k] = true;
                              setEditingGrants(next);
                            }}
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                            title={preset.description}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1">
                      {PERMISSION_KEYS.map((key) => (
                        <ToggleField
                          key={key}
                          label={PERMISSION_LABELS[key]}
                          hint={PERMISSION_DESCRIPTIONS[key]}
                          checked={!!editingGrants[key]}
                          onChange={(v) =>
                            setEditingGrants((prev) => ({
                              ...prev,
                              [key]: v,
                            }))
                          }
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => handleSavePermissions(member.id)}
                        disabled={permissionsMutation.isPending}
                      >
                        {permissionsMutation.isPending
                          ? "Saving..."
                          : "Save permissions"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedMemberId(null)}
                      >
                        Cancel
                      </Button>
                      {permissionsMutation.isError && (
                        <span className="text-xs text-destructive">
                          {permissionsMutation.error instanceof Error
                            ? permissionsMutation.error.message
                            : "Failed to save permissions"}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Invite Human Members */}
        <div className="border-t border-border pt-3 mt-3">
          <div className="flex items-center gap-1.5 mb-2">
            <UserPlus className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              Invite a human member to join this company.
            </span>
          </div>

          {showHumanInvite ? (
            <div className="space-y-2">
              {humanInviteUrl ? (
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">
                      Invite link (expires in 10 minutes)
                    </div>
                    {humanInviteCopied && (
                      <span className="flex items-center gap-1 text-xs text-green-600 animate-pulse">
                        <Check className="h-3 w-3" />
                        Copied
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                      value={humanInviteUrl}
                      readOnly
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(humanInviteUrl);
                          setHumanInviteCopied(true);
                          setTimeout(() => setHumanInviteCopied(false), 2000);
                        } catch {
                          /* clipboard may not be available */
                        }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 mr-1" />
                      Copy
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => humanInviteMutation.mutate()}
                    disabled={humanInviteMutation.isPending}
                  >
                    {humanInviteMutation.isPending
                      ? "Generating..."
                      : "Generate invite link"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowHumanInvite(false)}
                  >
                    Cancel
                  </Button>
                </div>
              )}
              {humanInviteMutation.isError && (
                <p className="text-xs text-destructive">
                  {humanInviteMutation.error instanceof Error
                    ? humanInviteMutation.error.message
                    : "Failed to create invite"}
                </p>
              )}
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowHumanInvite(true);
                setHumanInviteUrl(null);
                setHumanInviteCopied(false);
              }}
            >
              <UserPlus className="h-3.5 w-3.5 mr-1" />
              Invite human member
            </Button>
          )}
        </div>

        {/* Pending Join Requests */}
        {!joinRequestsLoading && pendingJoinRequests.length > 0 && (
          <div className="border-t border-border pt-3 mt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                Pending join requests
              </span>
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                {pendingJoinRequests.length}
              </span>
            </div>
            <div className="space-y-1">
              {pendingJoinRequests.map((jr: JoinRequest) => (
                <div
                  key={jr.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {jr.requestType === "agent"
                        ? jr.agentName ?? "Unnamed agent"
                        : jr.requestEmailSnapshot ?? "Unknown user"}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {jr.requestType}
                    </span>
                    {jr.adapterType && (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {jr.adapterType}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {new Date(jr.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => approveMutation.mutate(jr.id)}
                      disabled={
                        approveMutation.isPending || rejectMutation.isPending
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => rejectMutation.mutate(jr.id)}
                      disabled={
                        approveMutation.isPending || rejectMutation.isPending
                      }
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {(approveMutation.isError || rejectMutation.isError) && (
              <p className="text-xs text-destructive mt-1">
                {(approveMutation.error ?? rejectMutation.error) instanceof Error
                  ? ((approveMutation.error ?? rejectMutation.error) as Error).message
                  : "Action failed"}
              </p>
            )}
          </div>
        )}

        {/* Loading state for join requests */}
        {joinRequestsLoading && (
          <div className="border-t border-border pt-3 mt-3">
            <p className="text-xs text-muted-foreground">Loading join requests...</p>
          </div>
        )}
      </div>
    </div>
  );
}

const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  claude_oauth: "Claude OAuth",
  qwen_api_key: "Qwen API Key",
};

const CREDENTIAL_TYPE_OPTIONS: CredentialType[] = ["claude_oauth", "qwen_api_key"];

function credentialPlaceholder(type: CredentialType): string {
  return type === "claude_oauth"
    ? "Paste OAuth access token..."
    : "Paste DashScope API key...";
}

function buildCredentialPayload(
  type: CredentialType,
  token: string,
): Record<string, unknown> {
  return type === "claude_oauth"
    ? { accessToken: token }
    : { apiKey: token };
}

function CredentialsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  // Fetch credentials
  const { data: credentials = [], isLoading } = useQuery({
    queryKey: queryKeys.credentials.list(companyId),
    queryFn: () => credentialsApi.list(companyId),
  });

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<CredentialType>("claude_oauth");
  const [addToken, setAddToken] = useState("");
  const [addIsDefault, setAddIsDefault] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editToken, setEditToken] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Claude login flow state
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<"idle" | "starting" | "pending" | "complete" | "failed" | "expired">("idle");
  const [loginError, setLoginError] = useState<string | null>(null);

  const resetAddForm = () => {
    setShowAddForm(false);
    setAddName("");
    setAddType("claude_oauth");
    setAddToken("");
    setAddIsDefault(false);
  };

  const startEdit = (cred: ProviderCredential) => {
    setEditingId(cred.id);
    setEditName(cred.name);
    setEditToken("");
    setEditIsDefault(cred.isDefault);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditToken("");
    setEditIsDefault(false);
  };

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.credentials.list(companyId),
    });

  const createMutation = useMutation({
    mutationFn: () =>
      credentialsApi.create(companyId, {
        name: addName.trim(),
        type: addType,
        credential: buildCredentialPayload(addType, addToken.trim()),
        isDefault: addIsDefault,
      }),
    onSuccess: () => {
      invalidate();
      resetAddForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof credentialsApi.update>[1];
    }) => credentialsApi.update(id, data),
    onSuccess: () => {
      invalidate();
      cancelEdit();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.remove(id),
    onSuccess: () => {
      invalidate();
      setConfirmDeleteId(null);
    },
  });

  function handleSaveEdit(cred: ProviderCredential) {
    const data: Parameters<typeof credentialsApi.update>[1] = {};
    if (editName.trim() && editName.trim() !== cred.name)
      data.name = editName.trim();
    if (editToken.trim())
      data.credential = buildCredentialPayload(cred.type, editToken.trim());
    if (editIsDefault !== cred.isDefault) data.isDefault = editIsDefault;
    if (Object.keys(data).length === 0) {
      cancelEdit();
      return;
    }
    updateMutation.mutate({ id: cred.id, data });
  }

  const startLoginMutation = useMutation({
    mutationFn: () =>
      credentialsApi.startClaudeLogin(companyId, { isDefault: credentials.length === 0 }),
    onSuccess: (data) => {
      setLoginSessionId(data.loginSessionId);
      setLoginUrl(data.loginUrl);
      setLoginStatus("pending");
      setLoginError(null);
      if (data.loginUrl) {
        window.open(data.loginUrl, "_blank", "noopener");
      }
    },
    onError: (err) => {
      setLoginStatus("failed");
      setLoginError(err instanceof Error ? err.message : "Failed to start login");
    },
  });

  useEffect(() => {
    if (loginStatus !== "pending" || !loginSessionId) return;
    const interval = setInterval(async () => {
      try {
        const result = await credentialsApi.pollClaudeLogin(companyId, loginSessionId);
        if (result.loginUrl && !loginUrl) {
          setLoginUrl(result.loginUrl);
          window.open(result.loginUrl, "_blank", "noopener");
        }
        if (result.status === "complete") {
          setLoginStatus("complete");
          invalidate();
          clearInterval(interval);
          setTimeout(() => {
            setLoginSessionId(null);
            setLoginUrl(null);
            setLoginStatus("idle");
          }, 3000);
        } else if (result.status === "failed" || result.status === "expired") {
          setLoginStatus(result.status);
          setLoginError(result.error ?? "Login failed");
          clearInterval(interval);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [loginStatus, loginSessionId, companyId, loginUrl]);

  const resetLogin = () => {
    if (loginSessionId) {
      credentialsApi.cancelClaudeLogin(companyId, loginSessionId).catch(() => {});
    }
    setLoginSessionId(null);
    setLoginUrl(null);
    setLoginStatus("idle");
    setLoginError(null);
  };

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Credentials
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            Provider credentials used by agents for LLM access.
          </span>
          <HintIcon text="Credentials are encrypted at rest. Tokens are never displayed after creation." />
        </div>

        {/* Credential list */}
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : credentials.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No credentials configured yet.
          </p>
        ) : (
          <div className="space-y-2">
            {credentials.map((cred) => (
              <div key={cred.id}>
                {editingId === cred.id ? (
                  /* Inline edit form */
                  <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
                    <Field label="Name">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Replace token"
                      hint="Leave empty to keep the existing token."
                    >
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                        type="password"
                        value={editToken}
                        placeholder={credentialPlaceholder(cred.type)}
                        onChange={(e) => setEditToken(e.target.value)}
                      />
                    </Field>
                    <ToggleField
                      label="Default credential"
                      hint="If set, agents without an explicit credential will use this one."
                      checked={editIsDefault}
                      onChange={setEditIsDefault}
                    />
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => handleSaveEdit(cred)}
                        disabled={updateMutation.isPending}
                      >
                        {updateMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                      >
                        Cancel
                      </Button>
                      {updateMutation.isError && (
                        <span className="text-xs text-destructive">
                          {updateMutation.error instanceof Error
                            ? updateMutation.error.message
                            : "Failed to save"}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Display row */
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">
                        {cred.name}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {CREDENTIAL_TYPE_LABELS[cred.type] ?? cred.type}
                      </span>
                      {cred.isDefault && (
                        <span className="shrink-0 flex items-center gap-0.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                          <Star className="h-2.5 w-2.5" />
                          default
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {new Date(cred.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => startEdit(cred)}
                        title="Edit credential"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {confirmDeleteId === cred.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 text-xs px-2"
                            onClick={() => deleteMutation.mutate(cred.id)}
                            disabled={deleteMutation.isPending}
                          >
                            {deleteMutation.isPending ? "..." : "Delete"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirmDeleteId(cred.id)}
                          title="Delete credential"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add credential form */}
        {showAddForm ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
            <Field label="Name" hint="A human-readable label for this credential.">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                type="text"
                value={addName}
                placeholder="e.g. Production Claude Key"
                onChange={(e) => setAddName(e.target.value)}
              />
            </Field>
            <Field label="Type">
              <select
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                value={addType}
                onChange={(e) => setAddType(e.target.value as CredentialType)}
              >
                {CREDENTIAL_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {CREDENTIAL_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Token / Key">
              <input
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                type="password"
                value={addToken}
                placeholder={credentialPlaceholder(addType)}
                onChange={(e) => setAddToken(e.target.value)}
              />
            </Field>
            <ToggleField
              label="Set as default"
              hint="If set, agents without an explicit credential will use this one."
              checked={addIsDefault}
              onChange={setAddIsDefault}
            />
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={
                  createMutation.isPending ||
                  !addName.trim() ||
                  !addToken.trim()
                }
              >
                {createMutation.isPending ? "Saving..." : "Save"}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetAddForm}>
                Cancel
              </Button>
              {createMutation.isError && (
                <span className="text-xs text-destructive">
                  {createMutation.error instanceof Error
                    ? createMutation.error.message
                    : "Failed to create credential"}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            {loginStatus === "idle" ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setLoginStatus("starting");
                  startLoginMutation.mutate();
                }}
                disabled={startLoginMutation.isPending}
              >
                Login with Claude
              </Button>
            ) : loginStatus === "starting" ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                Starting login...
              </div>
            ) : loginStatus === "pending" ? (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-3 w-3 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
                  Waiting for login...
                </div>
                {loginUrl && (
                  <a
                    href={loginUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 underline underline-offset-2"
                  >
                    Open login page
                  </a>
                )}
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={resetLogin}>
                  Cancel
                </Button>
              </div>
            ) : loginStatus === "complete" ? (
              <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <Check className="h-3.5 w-3.5" />
                Claude login successful!
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-destructive">
                  {loginError ?? "Login failed"}
                </span>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={resetLogin}>
                  Retry
                </Button>
              </div>
            )}
            <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setShowAddForm(true)}>
              Add manually
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const NOTIFICATION_LEVEL_OPTIONS: { value: TelegramNotificationLevel; label: string; description: string }[] = [
  { value: "all", label: "All", description: "Every comment, status change, and run failure" },
  { value: "important", label: "Important", description: "Human-directed comments, blocked/review issues, approval requests, issue-related run failures" },
  { value: "critical", label: "Critical only", description: "Only blocked issues and approval requests" },
];

function TelegramSection({
  companyId,
  telegramChatId,
  setTelegramChatId,
  savedChatId,
  notificationLevel,
  setNotificationLevel,
  savedNotificationLevel,
}: {
  companyId: string;
  telegramChatId: string;
  setTelegramChatId: (v: string) => void;
  savedChatId: string;
  notificationLevel: TelegramNotificationLevel;
  setNotificationLevel: (v: TelegramNotificationLevel) => void;
  savedNotificationLevel: TelegramNotificationLevel;
}) {
  const queryClient = useQueryClient();
  const dirty = telegramChatId !== savedChatId || notificationLevel !== savedNotificationLevel;

  const saveMutation = useMutation({
    mutationFn: () =>
      companiesApi.update(companyId, {
        settings: {
          telegram: {
            chatId: telegramChatId.trim() || undefined,
            notificationLevel,
          },
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Notifications
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <Field
          label="Telegram Chat ID"
          hint="Telegram group/channel chat ID for this workspace. Overrides the global default. Use a bot like @userinfobot or the Telegram Bot API getUpdates to find the chat ID."
        >
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="-100xxxxxxxxxx"
            />
          </div>
        </Field>
        <Field
          label="Notification level"
          hint="Controls which events send Telegram notifications. 'Important' filters out agent-to-agent chatter and routine heartbeat failures."
        >
          <select
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            value={notificationLevel}
            onChange={(e) => setNotificationLevel(e.target.value as TelegramNotificationLevel)}
          >
            {NOTIFICATION_LEVEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} — {opt.description}
              </option>
            ))}
          </select>
        </Field>
        {dirty && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
            {saveMutation.isSuccess && (
              <span className="text-xs text-muted-foreground">Saved</span>
            )}
            {saveMutation.isError && (
              <span className="text-xs text-destructive">
                {saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : "Failed to save"}
              </span>
            )}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          When set, Telegram notifications for this workspace (comments, blocked/review issues, failed runs) are sent to this chat instead of the global default.
        </p>
      </div>
    </div>
  );
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.
Suggested steps:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.
Suggested command:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test callback reachability, call: ${resolutionTestUrl}?url=<urlencoded-webhook-url> (well using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a webhook URL that Paperclip can access. Check your config and include that URL.${resolutionLine}

---

In order for Paperclip to work smoothly, you need to enable \`gateway.http.endpoints.responses.enabled=true\` in your OpenClaw config.

Please enable that setting and notify your user that we did so.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "paperclip-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

`;
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
