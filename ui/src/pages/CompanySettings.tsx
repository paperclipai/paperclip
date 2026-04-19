import { ChangeEvent, useEffect, useMemo, useState, type ComponentType } from "react";
import { Link, Navigate, NavLink, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION } from "@paperclipai/shared";
import {
  Boxes,
  Brush,
  Check,
  Copy,
  Database,
  Download,
  KeyRound,
  Moon,
  Palette,
  Plug,
  Repeat,
  Rocket,
  Save,
  Settings,
  ShieldCheck,
  Sun,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wallet,
  Monitor,
} from "lucide-react";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { budgetsApi } from "../api/budgets";
import { companiesApi } from "../api/companies";
import { companySkillsApi } from "../api/companySkills";
import { pluginsApi } from "../api/plugins";
import { routinesApi } from "../api/routines";
import { secretsApi } from "../api/secrets";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Field, HintIcon, ToggleField } from "../components/agent-config-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useTheme, type ThemePreference } from "../context/ThemeContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

type CompanySettingsSection =
  | "general"
  | "appearance"
  | "access"
  | "budgets"
  | "routines"
  | "data"
  | "skills"
  | "integrations"
  | "danger";

type SettingsNavItem = {
  id: CompanySettingsSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const SETTINGS_SECTIONS: SettingsNavItem[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "access", label: "Access & Invites", icon: Users },
  { id: "budgets", label: "Budgets", icon: Wallet },
  { id: "routines", label: "Routines", icon: Repeat },
  { id: "data", label: "Data Controls", icon: Database },
  { id: "skills", label: "Skills", icon: Boxes },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "danger", label: "Danger Zone", icon: ShieldCheck },
];

const SECTION_IDS = new Set<CompanySettingsSection>(SETTINGS_SECTIONS.map((section) => section.id));
const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

function normalizeSection(value: string | undefined): CompanySettingsSection | null {
  if (!value) return "general";
  return SECTION_IDS.has(value as CompanySettingsSection) ? (value as CompanySettingsSection) : null;
}

function formatDollarInput(cents: number) {
  if (!Number.isFinite(cents) || cents <= 0) return "";
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

function parseDollarInput(value: string): number | null {
  const trimmed = value.trim().replace(/[$,]/g, "");
  if (!trimmed) return 0;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function parsePositiveIntegerInput(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function isValidBrandColor(value: string) {
  return value === "" || /^#[0-9a-fA-F]{6}$/.test(value);
}

function absoluteAppUrl(pathOrUrl: string) {
  if (pathOrUrl.startsWith("http")) return pathOrUrl;
  const base = window.location.origin.replace(/\/+$/, "");
  return `${base}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

function SectionHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <p className="max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-md border border-border bg-card px-4 py-4", className)}>
      {children}
    </section>
  );
}

function StatusLine({
  pending,
  success,
  error,
  pendingText = "Saving...",
}: {
  pending?: boolean;
  success?: boolean;
  error?: unknown;
  pendingText?: string;
}) {
  if (pending) return <span className="text-xs text-muted-foreground">{pendingText}</span>;
  if (error) {
    return (
      <span className="text-xs text-destructive">
        {error instanceof Error ? error.message : "Action failed"}
      </span>
    );
  }
  if (success) return <span className="text-xs text-muted-foreground">Saved</span>;
  return null;
}

function SecretProviderLabel({ secret }: { secret: CompanySecret }) {
  return (
    <span className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {secret.provider.replaceAll("_", " ")}
    </span>
  );
}

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId,
  } = useCompany();
  const { section } = useParams<{ section?: string }>();
  const activeSection = normalizeSection(section);
  const activeSectionMeta = SETTINGS_SECTIONS.find((item) => item.id === activeSection) ?? SETTINGS_SECTIONS[0]!;
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { effectiveTheme, themePreference, setThemePreference } = useTheme();

  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [devHourlyRateDraft, setDevHourlyRateDraft] = useState("");
  const [devTokensPerHourDraft, setDevTokensPerHourDraft] = useState("");

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [genericInviteUrl, setGenericInviteUrl] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);
  const [genericInviteCopied, setGenericInviteCopied] = useState(false);

  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretDescription, setSecretDescription] = useState("");
  const [editingSecretId, setEditingSecretId] = useState<string | null>(null);
  const [editingSecretName, setEditingSecretName] = useState("");
  const [editingSecretDescription, setEditingSecretDescription] = useState("");
  const [rotationSecretValues, setRotationSecretValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoUrl(selectedCompany.logoUrl ?? "");
    setBudgetDraft(formatDollarInput(selectedCompany.budgetMonthlyCents));
    setDevHourlyRateDraft(formatDollarInput(selectedCompany.devValueHourlyRateCents));
    setDevTokensPerHourDraft(String(selectedCompany.devValueTokensPerHour));
  }, [selectedCompany]);

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setGenericInviteUrl(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
    setGenericInviteCopied(false);
  }, [selectedCompanyId]);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings/general" },
      { label: activeSectionMeta.label },
    ]);
  }, [activeSectionMeta.label, selectedCompany?.name, setBreadcrumbs]);

  const routinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.routines.list(selectedCompanyId) : ["routines", "none"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeSection === "routines",
  });

  const companySkillsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companySkills.list(selectedCompanyId) : ["company-skills", "none"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeSection === "skills",
  });

  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    enabled: activeSection === "integrations",
  });

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeSection === "integrations",
  });

  const budgetCents = parseDollarInput(budgetDraft);
  const devHourlyRateCents = parseDollarInput(devHourlyRateDraft);
  const devTokensPerHour = parsePositiveIntegerInput(devTokensPerHourDraft);
  const brandColorValid = isValidBrandColor(brandColor);
  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? ""));
  const budgetDirty =
    !!selectedCompany &&
    budgetCents !== null &&
    budgetCents !== selectedCompany.budgetMonthlyCents;
  const devValueDirty =
    !!selectedCompany &&
    devHourlyRateCents !== null &&
    devTokensPerHour !== null &&
    (devHourlyRateCents !== selectedCompany.devValueHourlyRateCents ||
      devTokensPerHour !== selectedCompany.devValueTokensPerHour);

  const routineCounts = useMemo(() => {
    const rows = routinesQuery.data ?? [];
    return {
      total: rows.length,
      active: rows.filter((routine) => routine.status === "active").length,
      paused: rows.filter((routine) => routine.status === "paused").length,
      draft: rows.filter((routine) => routine.status !== "archived" && !routine.assigneeAgentId).length,
    };
  }, [routinesQuery.data]);

  const skillCounts = useMemo(() => {
    const rows = companySkillsQuery.data ?? [];
    return {
      total: rows.length,
      compatible: rows.filter((skill) => skill.compatibility === "compatible").length,
    };
  }, [companySkillsQuery.data]);

  const pluginCounts = useMemo(() => {
    const rows = pluginsQuery.data ?? [];
    return {
      total: rows.length,
      ready: rows.filter((plugin) => plugin.status === "ready").length,
    };
  }, [pluginsQuery.data]);

  const invalidateCompany = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
    }
  };

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: invalidateCompany,
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: invalidateCompany,
  });

  const budgetMutation = useMutation({
    mutationFn: (budgetMonthlyCents: number) =>
      budgetsApi.updateCompanyBudget(selectedCompanyId!, { budgetMonthlyCents }),
    onSuccess: () => {
      invalidateCompany();
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(selectedCompanyId) });
      }
    },
  });

  const devValueMutation = useMutation({
    mutationFn: (input: { devValueHourlyRateCents: number; devValueTokensPerHour: number }) =>
      companiesApi.update(selectedCompanyId!, input),
    onSuccess: invalidateCompany,
  });

  const feedbackSharingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        feedbackDataSharingEnabled: enabled,
      }),
    onSuccess: (_company, enabled) => {
      invalidateCompany();
      pushToast({
        title: enabled ? "Feedback sharing enabled" : "Feedback sharing disabled",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update feedback sharing",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const openClawInviteMutation = useMutation({
    mutationFn: () => accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = absoluteAppUrl(onboardingTextLink);
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl: manifest.onboarding.connectivity?.testResolutionEndpoint?.url ?? null,
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null,
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        // Clipboard may not be available.
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!),
      });
    },
    onError: (err) => {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });

  const genericInviteMutation = useMutation({
    mutationFn: () => accessApi.createCompanyInvite(selectedCompanyId!, { allowedJoinTypes: "both" }),
    onSuccess: async (invite) => {
      const inviteUrl = absoluteAppUrl(invite.inviteUrl);
      setGenericInviteUrl(inviteUrl);
      setGenericInviteCopied(false);
      try {
        await navigator.clipboard.writeText(inviteUrl);
        setGenericInviteCopied(true);
        setTimeout(() => setGenericInviteCopied(false), 2000);
      } catch {
        // Clipboard may not be available.
      }
    },
    onError: (err) => {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      setLogoUrl(company.logoUrl ?? "");
      setLogoUploadError(null);
      invalidateCompany();
    },
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      setLogoUrl(company.logoUrl ?? "");
      invalidateCompany();
    },
  });

  const createSecretMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(selectedCompanyId!, {
        name: secretName.trim(),
        value: secretValue,
        description: secretDescription.trim() || null,
      }),
    onSuccess: () => {
      setSecretName("");
      setSecretValue("");
      setSecretDescription("");
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
    },
  });

  const updateSecretMutation = useMutation({
    mutationFn: (input: { id: string; name: string; description: string | null }) =>
      secretsApi.update(input.id, {
        name: input.name,
        description: input.description,
      }),
    onSuccess: () => {
      setEditingSecretId(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
    },
  });

  const rotateSecretMutation = useMutation({
    mutationFn: (input: { id: string; value: string }) =>
      secretsApi.rotate(input.id, { value: input.value }),
    onSuccess: (_secret, input) => {
      setRotationSecretValues((current) => {
        const next = { ...current };
        delete next[input.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
    },
  });

  const deleteSecretMutation = useMutation({
    mutationFn: (id: string) => secretsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId,
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats,
      });
    },
  });

  if (!activeSection) {
    return <Navigate to="/company/settings/general" replace />;
  }

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
    });
  }

  async function copyText(value: string, onCopied: () => void) {
    try {
      await navigator.clipboard.writeText(value);
      onCopied();
    } catch {
      pushToast({ title: "Clipboard unavailable", tone: "error" });
    }
  }

  function beginEditSecret(secret: CompanySecret) {
    setEditingSecretId(secret.id);
    setEditingSecretName(secret.name);
    setEditingSecretDescription(secret.description ?? "");
  }

  const sectionContent = (() => {
    switch (activeSection) {
      case "general":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Settings}
              title="General"
              description="The company identity and hiring approval defaults used across this board."
            />
            <SettingsPanel className="space-y-4">
              <Field label="Company name" hint="The display name for your company.">
                <Input
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                />
              </Field>
              <Field label="Description" hint="Optional description shown in the company profile.">
                <Input
                  value={description}
                  placeholder="Optional company description"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleSaveGeneral}
                  disabled={generalMutation.isPending || !companyName.trim() || !generalDirty}
                >
                  <Save className="h-3.5 w-3.5" />
                  Save changes
                </Button>
                <StatusLine
                  pending={generalMutation.isPending}
                  success={generalMutation.isSuccess && !generalDirty}
                  error={generalMutation.error}
                />
              </div>
            </SettingsPanel>
            <SettingsPanel>
              <ToggleField
                label="Require board approval for new hires"
                hint="New agent hires stay pending until approved by board."
                checked={!!selectedCompany.requireBoardApprovalForNewAgents}
                onChange={(value) => settingsMutation.mutate(value)}
                toggleTestId="company-settings-team-approval-toggle"
              />
              <div className="mt-2">
                <StatusLine
                  pending={settingsMutation.isPending}
                  success={settingsMutation.isSuccess}
                  error={settingsMutation.error}
                />
              </div>
            </SettingsPanel>
          </div>
        );

      case "appearance":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Palette}
              title="Appearance"
              description="Company branding and the local display preference for this browser."
            />
            <SettingsPanel className="space-y-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <CompanyPatternIcon
                  companyName={companyName || selectedCompany.name}
                  logoUrl={logoUrl || null}
                  brandColor={brandColor || null}
                  className="rounded-[14px]"
                />
                <div className="min-w-0 flex-1 space-y-4">
                  <Field label="Logo" hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.">
                    <div className="space-y-2">
                      <Input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                        onChange={handleLogoFileChange}
                        className="file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                      />
                      {logoUrl ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => clearLogoMutation.mutate()}
                          disabled={clearLogoMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                        </Button>
                      ) : null}
                      {(logoUploadMutation.isError || logoUploadError) && (
                        <span className="text-xs text-destructive">
                          {logoUploadError ??
                            (logoUploadMutation.error instanceof Error
                              ? logoUploadMutation.error.message
                              : "Logo upload failed")}
                        </span>
                      )}
                      {clearLogoMutation.isError ? (
                        <span className="text-xs text-destructive">{clearLogoMutation.error.message}</span>
                      ) : null}
                      {logoUploadMutation.isPending ? (
                        <span className="text-xs text-muted-foreground">Uploading logo...</span>
                      ) : null}
                    </div>
                  </Field>
                  <Field label="Brand color" hint="Sets the hue for the company icon. Leave empty for auto-generated color.">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="color"
                        value={brandColor || "#6366f1"}
                        onChange={(event) => setBrandColor(event.target.value)}
                        className="h-9 w-10 cursor-pointer rounded-md border border-border bg-transparent p-0"
                      />
                      <Input
                        value={brandColor}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "" || /^#[0-9a-fA-F]{0,6}$/.test(value)) {
                            setBrandColor(value);
                          }
                        }}
                        placeholder="Auto"
                        className="w-32 font-mono"
                      />
                      {brandColor ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setBrandColor("")}
                          className="text-muted-foreground"
                        >
                          Clear
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        onClick={handleSaveGeneral}
                        disabled={generalMutation.isPending || !companyName.trim() || !generalDirty || !brandColorValid}
                      >
                        <Save className="h-3.5 w-3.5" />
                        Save branding
                      </Button>
                    </div>
                    {!brandColorValid ? (
                      <p className="text-xs text-destructive">Use a full hex color, for example #5c5fff.</p>
                    ) : null}
                  </Field>
                </div>
              </div>
            </SettingsPanel>
            <SettingsPanel className="space-y-3">
              <div className="space-y-1">
                <div className="text-sm font-medium">Theme</div>
                <div className="text-xs text-muted-foreground">Current effective theme: {effectiveTheme}</div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                  { value: "system", label: "Follow System", icon: Monitor },
                ] satisfies Array<{ value: ThemePreference; label: string; icon: ComponentType<{ className?: string }> }>).map((option) => {
                  const OptionIcon = option.icon;
                  const active = themePreference === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`theme-option-${option.value}`}
                      onClick={() => setThemePreference(option.value)}
                      className={cn(
                        "flex min-h-20 items-center gap-3 rounded-md border px-3 py-3 text-left transition-colors",
                        active
                          ? "border-foreground bg-accent text-foreground"
                          : "border-border bg-background hover:bg-accent/50",
                      )}
                    >
                      <OptionIcon className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </SettingsPanel>
          </div>
        );

      case "access":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Users}
              title="Access & Invites"
              description="Create board and agent invite links for this company."
            />
            <SettingsPanel className="space-y-4" data-testid="company-settings-invites-section">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">Generic company invite</span>
                <HintIcon text="Creates a short-lived invite link that can be used for human or agent join requests." />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => genericInviteMutation.mutate()}
                  disabled={genericInviteMutation.isPending}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  {genericInviteMutation.isPending ? "Generating..." : "Generate Invite Link"}
                </Button>
                {genericInviteCopied ? <span className="text-xs text-muted-foreground">Copied</span> : null}
              </div>
              {genericInviteUrl ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input value={genericInviteUrl} readOnly className="font-mono text-xs" />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyText(genericInviteUrl, () => setGenericInviteCopied(true))}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </Button>
                </div>
              ) : null}
            </SettingsPanel>
            <SettingsPanel className="space-y-3">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">OpenClaw agent invite prompt</span>
                <HintIcon text="Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." />
              </div>
              <Button
                data-testid="company-settings-invites-generate-button"
                size="sm"
                onClick={() => openClawInviteMutation.mutate()}
                disabled={openClawInviteMutation.isPending}
              >
                {openClawInviteMutation.isPending ? "Generating..." : "Generate OpenClaw Invite Prompt"}
              </Button>
              {inviteError ? <p className="text-sm text-destructive">{inviteError}</p> : null}
              {inviteSnippet ? (
                <div
                  className="rounded-md border border-border bg-muted/30 p-2"
                  data-testid="company-settings-invites-snippet"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-muted-foreground">OpenClaw Invite Prompt</div>
                    {snippetCopied ? (
                      <span
                        key={snippetCopyDelightId}
                        className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                      >
                        <Check className="h-3 w-3" />
                        Copied
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 space-y-1.5">
                    <Textarea
                      data-testid="company-settings-invites-snippet-textarea"
                      className="h-[28rem] font-mono text-xs"
                      value={inviteSnippet}
                      readOnly
                    />
                    <div className="flex justify-end">
                      <Button
                        data-testid="company-settings-invites-copy-button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          copyText(inviteSnippet, () => {
                            setSnippetCopied(true);
                            setSnippetCopyDelightId((prev) => prev + 1);
                            setTimeout(() => setSnippetCopied(false), 2000);
                          })
                        }
                      >
                        {snippetCopied ? "Copied snippet" : "Copy snippet"}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}
            </SettingsPanel>
          </div>
        );

      case "budgets":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Wallet}
              title="Budgets"
              description="Set the company monthly hard-stop budget and jump to the detailed cost controls."
            />
            <SettingsPanel className="space-y-4">
              <Field label="Monthly company budget (USD)" hint="0 or blank means unlimited. Budget enforcement uses the monthly UTC window.">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={budgetDraft}
                    onChange={(event) => setBudgetDraft(event.target.value)}
                    placeholder="Unlimited"
                    className="max-w-xs"
                  />
                  <Button
                    size="sm"
                    disabled={budgetMutation.isPending || !budgetDirty || budgetCents === null}
                    onClick={() => budgetCents !== null && budgetMutation.mutate(budgetCents)}
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save budget
                  </Button>
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Current: {selectedCompany.budgetMonthlyCents > 0 ? formatCents(selectedCompany.budgetMonthlyCents) : "Unlimited"}</span>
                <span>Spent this month: {formatCents(selectedCompany.spentMonthlyCents)}</span>
              </div>
              {budgetCents === null ? <p className="text-xs text-destructive">Enter a valid non-negative dollar amount.</p> : null}
              <StatusLine pending={budgetMutation.isPending} success={budgetMutation.isSuccess} error={budgetMutation.error} />
              <div>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/costs?tab=budgets">
                    <Wallet className="h-3.5 w-3.5" />
                    Open Cost Controls
                  </Link>
                </Button>
              </div>
            </SettingsPanel>
            <SettingsPanel className="space-y-4">
              <Field
                label="Developer value estimate"
                hint="Used on Dashboard and Costs to estimate what tracked agent tokens would cost as human developer time."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">Developer hourly rate (USD)</span>
                    <Input
                      value={devHourlyRateDraft}
                      onChange={(event) => setDevHourlyRateDraft(event.target.value)}
                      placeholder="150"
                      className="max-w-xs"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">Tokens per developer hour</span>
                    <Input
                      value={devTokensPerHourDraft}
                      onChange={(event) => setDevTokensPerHourDraft(event.target.value)}
                      placeholder="100000"
                      className="max-w-xs"
                    />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={
                      devValueMutation.isPending ||
                      !devValueDirty ||
                      devHourlyRateCents === null ||
                      devTokensPerHour === null
                    }
                    onClick={() => {
                      if (devHourlyRateCents === null || devTokensPerHour === null) return;
                      devValueMutation.mutate({
                        devValueHourlyRateCents: devHourlyRateCents,
                        devValueTokensPerHour: devTokensPerHour,
                      });
                    }}
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save estimate
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Current: {formatCents(selectedCompany.devValueHourlyRateCents)}/hr · {selectedCompany.devValueTokensPerHour.toLocaleString()} tokens/hr
                  </span>
                </div>
              </Field>
              {devHourlyRateCents === null ? <p className="text-xs text-destructive">Enter a valid non-negative hourly rate.</p> : null}
              {devTokensPerHour === null ? <p className="text-xs text-destructive">Enter a positive whole-number token rate.</p> : null}
              <StatusLine pending={devValueMutation.isPending} success={devValueMutation.isSuccess} error={devValueMutation.error} />
            </SettingsPanel>
          </div>
        );

      case "routines":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Repeat}
              title="Routines"
              description="Scheduled company work stays in the routines workspace; this section keeps it discoverable."
            />
            <SettingsPanel className="space-y-4">
              {routinesQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading routines...</p>
              ) : routinesQuery.error ? (
                <p className="text-sm text-destructive">Failed to load routines.</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-4">
                  {[
                    ["Total", routineCounts.total],
                    ["Active", routineCounts.active],
                    ["Paused", routineCounts.paused],
                    ["Draft", routineCounts.draft],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border border-border bg-background p-3">
                      <div className="text-xs text-muted-foreground">{label}</div>
                      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
                    </div>
                  ))}
                </div>
              )}
              <Button size="sm" variant="outline" asChild>
                <Link to="/routines">
                  <Repeat className="h-3.5 w-3.5" />
                  Open Routines
                </Link>
              </Button>
            </SettingsPanel>
          </div>
        );

      case "data":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Database}
              title="Data Controls"
              description="Company package import/export and voted-output sharing controls."
            />
            <SettingsPanel className="space-y-3">
              <ToggleField
                label="Allow sharing voted AI outputs with Paperclip Labs"
                hint="Only AI-generated outputs you explicitly vote on are eligible for feedback sharing."
                checked={!!selectedCompany.feedbackDataSharingEnabled}
                onChange={(enabled) => feedbackSharingMutation.mutate(enabled)}
              />
              <p className="text-sm text-muted-foreground">
                Votes are always saved locally. This setting controls whether voted AI outputs may also be marked for sharing with Paperclip Labs.
              </p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>
                  Terms version: {selectedCompany.feedbackDataSharingTermsVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION}
                </div>
                {selectedCompany.feedbackDataSharingConsentAt ? (
                  <div>
                    Enabled {new Date(selectedCompany.feedbackDataSharingConsentAt).toLocaleString()}
                    {selectedCompany.feedbackDataSharingConsentByUserId
                      ? ` by ${selectedCompany.feedbackDataSharingConsentByUserId}`
                      : ""}
                  </div>
                ) : (
                  <div>Sharing is currently disabled.</div>
                )}
                {FEEDBACK_TERMS_URL ? (
                  <a
                    href={FEEDBACK_TERMS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex text-foreground underline underline-offset-4"
                  >
                    Read our terms of service
                  </a>
                ) : null}
              </div>
            </SettingsPanel>
            <SettingsPanel className="space-y-3">
              <div className="text-sm font-medium">Company packages</div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to="/company/export">
                    <Download className="h-3.5 w-3.5" />
                    Export
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/company/import">
                    <Upload className="h-3.5 w-3.5" />
                    Import
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/company/rollouts">
                    <Rocket className="h-3.5 w-3.5" />
                    Rollouts
                  </Link>
                </Button>
              </div>
            </SettingsPanel>
          </div>
        );

      case "skills":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Boxes}
              title="Skills"
              description="Company-scoped skills used by agents in this organization."
            />
            <SettingsPanel className="space-y-4">
              {companySkillsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading skills...</p>
              ) : companySkillsQuery.error ? (
                <p className="text-sm text-destructive">Failed to load skills.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{skillCounts.total} total</Badge>
                  <Badge variant="outline">{skillCounts.compatible} compatible</Badge>
                </div>
              )}
              <Button size="sm" variant="outline" asChild>
                <Link to="/skills">
                  <Boxes className="h-3.5 w-3.5" />
                  Open Skills
                </Link>
              </Button>
            </SettingsPanel>
          </div>
        );

      case "integrations":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={Plug}
              title="Integrations"
              description="Plugins, adapter registrations, and company secrets used by agents and workspaces."
            />
            <SettingsPanel className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  {pluginsQuery.isLoading ? "Loading plugins" : `${pluginCounts.ready} ready / ${pluginCounts.total} plugins`}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" asChild>
                  <Link to="/instance/settings/plugins">
                    <Plug className="h-3.5 w-3.5" />
                    Plugins
                  </Link>
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link to="/instance/settings/adapters">
                    <Brush className="h-3.5 w-3.5" />
                    Adapters
                  </Link>
                </Button>
              </div>
            </SettingsPanel>
            <SettingsPanel className="space-y-4">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">Company secrets</div>
              </div>
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Input
                  value={secretName}
                  onChange={(event) => setSecretName(event.target.value)}
                  placeholder="Secret name"
                />
                <Input
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  placeholder="Secret value"
                  type="password"
                />
              </div>
              <Textarea
                value={secretDescription}
                onChange={(event) => setSecretDescription(event.target.value)}
                placeholder="Optional description"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  disabled={createSecretMutation.isPending || !secretName.trim() || !secretValue}
                  onClick={() => createSecretMutation.mutate()}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {createSecretMutation.isPending ? "Creating..." : "Create secret"}
                </Button>
                <StatusLine
                  pending={createSecretMutation.isPending}
                  success={createSecretMutation.isSuccess}
                  error={createSecretMutation.error}
                />
              </div>
              <div className="divide-y divide-border rounded-md border border-border">
                {secretsQuery.isLoading ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">Loading secrets...</div>
                ) : secretsQuery.error ? (
                  <div className="px-3 py-3 text-sm text-destructive">Failed to load secrets.</div>
                ) : (secretsQuery.data ?? []).length === 0 ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No company secrets yet.</div>
                ) : (
                  (secretsQuery.data ?? []).map((secret) => {
                    const isEditing = editingSecretId === secret.id;
                    const rotationValue = rotationSecretValues[secret.id] ?? "";
                    return (
                      <div key={secret.id} className="space-y-3 px-3 py-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium">{secret.name}</span>
                              <SecretProviderLabel secret={secret} />
                              <span className="text-xs text-muted-foreground">v{secret.latestVersion}</span>
                            </div>
                            {secret.description ? (
                              <p className="text-xs text-muted-foreground">{secret.description}</p>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="ghost" onClick={() => beginEditSecret(secret)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              disabled={deleteSecretMutation.isPending}
                              onClick={() => {
                                const confirmed = window.confirm(`Delete secret "${secret.name}"?`);
                                if (confirmed) deleteSecretMutation.mutate(secret.id);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </Button>
                          </div>
                        </div>
                        {isEditing ? (
                          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                            <Input value={editingSecretName} onChange={(event) => setEditingSecretName(event.target.value)} />
                            <Input
                              value={editingSecretDescription}
                              onChange={(event) => setEditingSecretDescription(event.target.value)}
                              placeholder="Description"
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                disabled={updateSecretMutation.isPending || !editingSecretName.trim()}
                                onClick={() =>
                                  updateSecretMutation.mutate({
                                    id: secret.id,
                                    name: editingSecretName.trim(),
                                    description: editingSecretDescription.trim() || null,
                                  })
                                }
                              >
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingSecretId(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <div className="flex flex-col gap-2 sm:flex-row">
                          <Input
                            value={rotationValue}
                            onChange={(event) =>
                              setRotationSecretValues((current) => ({
                                ...current,
                                [secret.id]: event.target.value,
                              }))
                            }
                            placeholder="New value"
                            type="password"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={rotateSecretMutation.isPending || !rotationValue}
                            onClick={() => rotateSecretMutation.mutate({ id: secret.id, value: rotationValue })}
                          >
                            Rotate
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </SettingsPanel>
          </div>
        );

      case "danger":
        return (
          <div className="space-y-5">
            <SectionHeader
              icon={ShieldCheck}
              title="Danger Zone"
              description="High-impact company actions that affect visibility and operations."
            />
            <SettingsPanel className="space-y-3 border-destructive/40 bg-destructive/5">
              <p className="text-sm text-muted-foreground">
                Archive this company to hide it from the sidebar. This persists in the database.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={archiveMutation.isPending || selectedCompany.status === "archived"}
                  onClick={() => {
                    if (!selectedCompanyId) return;
                    const confirmed = window.confirm(
                      `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`,
                    );
                    if (!confirmed) return;
                    const nextCompanyId =
                      companies.find(
                        (company) =>
                          company.id !== selectedCompanyId &&
                          company.status !== "archived",
                      )?.id ?? null;
                    archiveMutation.mutate({
                      companyId: selectedCompanyId,
                      nextCompanyId,
                    });
                  }}
                >
                  {archiveMutation.isPending
                    ? "Archiving..."
                    : selectedCompany.status === "archived"
                      ? "Already archived"
                      : "Archive company"}
                </Button>
                <StatusLine error={archiveMutation.error} />
              </div>
            </SettingsPanel>
          </div>
        );
    }
  })();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Company Settings</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-1 lg:sticky lg:top-6 lg:self-start">
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={`/company/settings/${item.id}`}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-9 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            );
          })}
        </aside>
        <div className="min-w-0">{sectionContent}</div>
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
    ? `\nYou MUST test Paperclip-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.${resolutionLine}

---

This onboarding flow is for OpenClaw Gateway.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

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
      "/test-resolution",
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}
