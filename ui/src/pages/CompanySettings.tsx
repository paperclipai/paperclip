import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";
import type { CredentialType } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import {
  credentialsApi,
  type CodexCredDeviceAuthPollResponse,
  type CredentialUsage,
  type ProviderCredential,
} from "../api/credentials";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Settings,
  Check,
  Download,
  Upload,
  KeyRound,
  LogIn,
  Trash2,
  Star,
  Pencil,
  X,
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Zap,
  Clock,
} from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { CodexDeviceAuthDialog } from "../components/CodexDeviceAuthDialog";
import {
  Field,
  ToggleField,
  HintIcon,
} from "../components/agent-config-primitives";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
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
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
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

  const feedbackSharingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        feedbackDataSharingEnabled: enabled,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
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

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

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
      brandColor: brandColor || null,
      attachmentMaxBytes
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
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">Uploading logo...</span>
                  )}
                </div>
              </Field>
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
              <Field
                label="Attachment size limit"
                hint={`Accepted range: 1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.`}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <span className="text-xs text-destructive">
                      Enter a whole number from 1 to {MAX_COMPANY_ATTACHMENT_MAX_MIB}.
                    </span>
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
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
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
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Feedback Sharing
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
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
        </div>
      </div>

      {/* Credentials */}
      <CredentialsSection companyId={selectedCompanyId!} />

      {/* Invites */}
      <div className="space-y-4" data-testid="company-settings-invites-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              Generate an OpenClaw agent invite snippet.
            </span>
            <HintIcon text="Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="company-settings-invites-generate-button"
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? "Generating..."
                : "Generate OpenClaw Invite Prompt"}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div
              className="rounded-md border border-border bg-muted/30 p-2"
              data-testid="company-settings-invites-snippet"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  OpenClaw Invite Prompt
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
                  data-testid="company-settings-invites-snippet-textarea"
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    data-testid="company-settings-invites-copy-button"
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

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Company Packages
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Import and export have moved to dedicated pages accessible from the{" "}
            <a href="/org" className="underline hover:text-foreground">Org Chart</a> header.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Import
              </a>
            </Button>
          </div>
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
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}

const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  claude_oauth: "Claude OAuth (Max)",
  claude_api_key: "Claude API Key",
  codex_oauth: "Codex OAuth (ChatGPT)",
  gemini_api_key: "Gemini API Key",
  openai_api_key: "OpenAI API Key",
  openrouter_api_key: "OpenRouter API Key",
  deepseek_api_key: "DeepSeek API Key",
  mimo_api_key: "MiMo (Xiaomi) API Key",
};

const CREDENTIAL_TYPE_OPTIONS: CredentialType[] = [
  "claude_oauth",
  "claude_api_key",
  "codex_oauth",
  "gemini_api_key",
  "openai_api_key",
  "openrouter_api_key",
  "deepseek_api_key",
  "mimo_api_key",
];

function credentialPlaceholder(type: CredentialType): string {
  switch (type) {
    case "claude_oauth":
      return "sk-ant-oat01-...";
    case "claude_api_key":
      return "Paste sk-ant-... key...";
    case "codex_oauth":
      return "eyJ... (or paste full ~/.codex/auth.json)";
    case "gemini_api_key":
      return "Paste AIza... key...";
    case "openai_api_key":
      return "Paste sk-... key...";
    case "openrouter_api_key":
      return "Paste sk-or-... key...";
    case "deepseek_api_key":
      return "Paste sk-... key...";
    case "mimo_api_key":
      return "Paste tp-... or sk-... key...";
  }
}

// Compact "time remaining" label for a credential parked on rotation cooldown.
// Returns null when there is no active cooldown.
function formatCredentialCooldown(cooldownUntil: string | null): string | null {
  if (!cooldownUntil) return null;
  const ms = new Date(cooldownUntil).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return mins % 60 > 0 ? `${hrs}h ${mins % 60}m` : `${hrs}h`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Long-lived tokens from `claude setup-token` are inference-only OAuth tokens
// with the `sk-ant-oat<digits>-` prefix. They have no refresh/expiry metadata
// and are routed through the CLAUDE_CODE_OAUTH_TOKEN env var at runtime.
const CLAUDE_LONG_LIVED_TOKEN_RE = /^sk-ant-oat\d*-/;

function isClaudeLongLivedToken(token: string): boolean {
  return CLAUDE_LONG_LIVED_TOKEN_RE.test(token.trim());
}

function buildCredentialPayload(
  type: CredentialType,
  token: string,
): Record<string, unknown> {
  if (type === "claude_oauth") {
    const trimmed = token.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const inner =
          parsed && typeof parsed.claudeAiOauth === "object" && parsed.claudeAiOauth !== null
            ? (parsed.claudeAiOauth as Record<string, unknown>)
            : parsed;
        const out: Record<string, unknown> = {};
        if (typeof inner.accessToken === "string") out.accessToken = inner.accessToken;
        if (typeof inner.refreshToken === "string") out.refreshToken = inner.refreshToken;
        if (typeof inner.expiresAt === "number") out.expiresAt = inner.expiresAt;
        if (Array.isArray(inner.scopes)) out.scopes = inner.scopes.filter((s): s is string => typeof s === "string");
        if (typeof inner.subscriptionType === "string") out.subscriptionType = inner.subscriptionType;
        if (typeof inner.rateLimitTier === "string") out.rateLimitTier = inner.rateLimitTier;
        if (typeof out.accessToken === "string") return out;
      } catch {
        // fall through — treat as bare token
      }
    }
    if (isClaudeLongLivedToken(trimmed)) {
      return { accessToken: trimmed, tokenKind: "long_lived" };
    }
    return { accessToken: trimmed };
  }

  if (type === "codex_oauth") {
    const trimmed = token.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const tokens =
          parsed && typeof parsed.tokens === "object" && parsed.tokens !== null
            ? (parsed.tokens as Record<string, unknown>)
            : null;
        const out: Record<string, unknown> = {};
        const accessToken =
          (tokens && typeof tokens.access_token === "string" ? tokens.access_token : null)
          ?? (typeof parsed.accessToken === "string" ? parsed.accessToken : null);
        const refreshToken =
          (tokens && typeof tokens.refresh_token === "string" ? tokens.refresh_token : null)
          ?? (typeof parsed.refreshToken === "string" ? parsed.refreshToken : null);
        const idToken =
          (tokens && typeof tokens.id_token === "string" ? tokens.id_token : null)
          ?? (typeof parsed.idToken === "string" ? parsed.idToken : null);
        const accountId =
          (tokens && typeof tokens.account_id === "string" ? tokens.account_id : null)
          ?? (typeof parsed.accountId === "string" ? parsed.accountId : null);
        const lastRefresh = typeof parsed.last_refresh === "string"
          ? parsed.last_refresh
          : typeof parsed.lastRefresh === "string" ? parsed.lastRefresh : null;
        if (accessToken) out.accessToken = accessToken;
        if (refreshToken) out.refreshToken = refreshToken;
        if (idToken) out.idToken = idToken;
        if (accountId) out.accountId = accountId;
        if (lastRefresh) out.lastRefresh = lastRefresh;
        if (typeof out.accessToken === "string") return out;
      } catch {
        // fall through — treat as bare token
      }
    }
    return { accessToken: trimmed };
  }

  return { apiKey: token };
}

function CredentialsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();

  const { data: credentials = [], isLoading } = useQuery({
    queryKey: queryKeys.credentials.list(companyId),
    queryFn: () => credentialsApi.list(companyId),
  });

  // Per-credential token/cost usage (trailing 30 days) for the usage column.
  const { data: usageResp } = useQuery({
    queryKey: ["credentials", "usage", companyId],
    queryFn: () => credentialsApi.usage(companyId),
  });
  const { data: quotaRows = [] } = useQuery({
    queryKey: queryKeys.credentials.quotaWindows(companyId),
    queryFn: () => credentialsApi.quotaWindows(companyId),
    refetchInterval: 60_000,
  });
  const usageByCredential = useMemo(() => {
    const map = new Map<string, CredentialUsage>();
    for (const u of usageResp?.usage ?? []) map.set(u.credentialId, u);
    return map;
  }, [usageResp]);
  const quotaByCredential = useMemo(() => {
    const map = new Map(quotaRows.map((row) => [row.credentialId, row]));
    return map;
  }, [quotaRows]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState("");
  const [addType, setAddType] = useState<CredentialType>("claude_api_key");
  const [addToken, setAddToken] = useState("");
  const [addIsDefault, setAddIsDefault] = useState(false);
  // ChatGPT device-auth flow: when the user clicks "Sign in with ChatGPT",
  // we open a modal driven by these state vars. On success the captured
  // auth.json content is pushed into addToken/editToken, the modal closes,
  // and the user just hits Save to persist via the normal CREATE/UPDATE.
  const [codexAuthScope, setCodexAuthScope] = useState<"add" | "edit" | null>(null);
  const [codexAuthSessionId, setCodexAuthSessionId] = useState<string | null>(null);
  const [codexAuthState, setCodexAuthState] = useState<CodexCredDeviceAuthPollResponse | null>(null);
  const [codexAuthStartError, setCodexAuthStartError] = useState<string | null>(null);
  // Whether the "Or paste auth.json manually" disclosure is expanded for
  // the add/edit forms. Default collapsed — paste-from-file is now the fallback,
  // not the primary path.

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editToken, setEditToken] = useState("");
  const [editIsDefault, setEditIsDefault] = useState(false);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [formProbe, setFormProbe] = useState<
    { scope: "add" | "edit"; ok: boolean; message: string } | null
  >(null);
  const [formProbing, setFormProbing] = useState<"add" | "edit" | null>(null);

  const handleFormProbe = async (
    scope: "add" | "edit",
    type: CredentialType,
    token: string,
  ) => {
    setFormProbing(scope);
    setFormProbe(null);
    try {
      const payload = buildCredentialPayload(type, token.trim());
      const result = await credentialsApi.probe(type, payload);
      setFormProbe({ scope, ok: result.ok, message: result.message });
    } catch (err) {
      setFormProbe({
        scope,
        ok: false,
        message: err instanceof Error ? err.message : "Probe failed",
      });
    } finally {
      setFormProbing(null);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await credentialsApi.test(id);
      setTestResult({ id, ok: result.ok, message: result.message });
    } catch (err) {
      setTestResult({
        id,
        ok: false,
        message: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setTestingId(null);
    }
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setAddName("");
    setAddType("claude_api_key");
    setAddToken("");
    setAddIsDefault(false);
    setFormProbe((prev) => (prev?.scope === "add" ? null : prev));
  };

  const handleReveal = async (id: string) => {
    if (revealedId === id) {
      setRevealedId(null);
      setRevealedValue(null);
      return;
    }
    try {
      const result = await credentialsApi.reveal(id);
      const value =
        result.credential?.accessToken ??
        result.credential?.apiKey ??
        JSON.stringify(result.credential);
      setRevealedId(id);
      setRevealedValue(String(value));
      setTimeout(() => {
        setRevealedId(null);
        setRevealedValue(null);
      }, 10000);
    } catch {
      // Permission denied or error
    }
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
    setFormProbe((prev) => (prev?.scope === "edit" ? null : prev));
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

  const reenableMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.reenable(id),
    onSuccess: () => invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => credentialsApi.remove(id, true),
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

  const startCodexAuth = useMutation({
    mutationFn: () => credentialsApi.startCodexDeviceAuth(companyId),
    onMutate: () => {
      setCodexAuthStartError(null);
      setCodexAuthState(null);
    },
    onSuccess: (data) => {
      setCodexAuthSessionId(data.sessionId);
    },
    onError: (err) => {
      setCodexAuthStartError(err instanceof Error ? err.message : "Failed to start ChatGPT login");
    },
  });

  function openCodexAuth(scope: "add" | "edit") {
    setCodexAuthScope(scope);
    setCodexAuthStartError(null);
    setCodexAuthState(null);
    startCodexAuth.mutate();
  }

  function closeCodexAuth() {
    setCodexAuthSessionId(null);
    setCodexAuthState(null);
    setCodexAuthScope(null);
  }

  // Poll the device-auth session until it reaches a terminal state. The first
  // poll that observes status==="success" carries the captured auth.json string
  // — push it into the active form (add or edit) and close the modal. The
  // server has already wiped the temp dir + session by this point.
  useEffect(() => {
    if (!codexAuthSessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const next = await credentialsApi.pollCodexDeviceAuth(companyId, codexAuthSessionId);
        if (cancelled) return;
        setCodexAuthState(next);
        if (next.status === "success" && next.authJson) {
          if (codexAuthScope === "add") {
            setAddToken(next.authJson);
            // Auto-populate a friendly default name like "ChatGPT — May 2, 2026"
            // if the user hasn't already typed something. They can rename before saving.
            setAddName((prev) => {
              if (prev.trim().length > 0) return prev;
              const today = new Date().toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              });
              return `ChatGPT — ${today}`;
            });
          } else if (codexAuthScope === "edit") {
            setEditToken(next.authJson);
          }
          // Close the modal a beat later so the user sees the success tick.
          setTimeout(() => {
            if (!cancelled) closeCodexAuth();
          }, 800);
          return;
        }
        if (next.status === "error") return;
        timer = setTimeout(poll, 1500);
      } catch (err) {
        if (cancelled) return;
        setCodexAuthStartError(err instanceof Error ? err.message : "Failed to poll ChatGPT login session");
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // codexAuthScope is intentionally read at success-time only; it won't change
    // during a single session lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexAuthSessionId, companyId]);

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
          <HintIcon text="Credentials are encrypted at rest with AES-256-GCM. Tokens are never displayed after creation unless explicitly revealed." />
        </div>

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
                  <div className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-3">
                    <Field label="Name">
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    </Field>
                    {cred.type === "codex_oauth" ? (
                      <div className="rounded-md border border-border bg-background px-3 py-3 space-y-2">
                        <Button
                          size="sm"
                          onClick={() => openCodexAuth("edit")}
                          disabled={
                            startCodexAuth.isPending || codexAuthSessionId !== null
                          }
                          className="gap-1.5"
                        >
                          <LogIn className="h-3.5 w-3.5" />
                          {startCodexAuth.isPending && codexAuthScope === "edit"
                            ? "Starting…"
                            : "Re-login with ChatGPT"}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          We'll generate a one-time code. You'll open openai.com in a new tab,
                          paste the code, and approve. Done. Last updated{" "}
                          {new Date(cred.updatedAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                          .
                        </p>
                        {editToken.trim().length > 0 && (
                          <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                            <CheckCircle2 className="h-3 w-3" />
                            New login captured. Click Save to replace.
                          </div>
                        )}
                        {codexAuthStartError && codexAuthScope === "edit" && (
                          <p className="text-xs text-destructive">{codexAuthStartError}</p>
                        )}
                      </div>
                    ) : (
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
                    )}
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
                        variant="outline"
                        onClick={() => handleFormProbe("edit", cred.type, editToken)}
                        disabled={formProbing === "edit" || !editToken.trim()}
                        className="gap-1.5"
                        title="Test the token in the field above"
                      >
                        <Zap className="h-3.5 w-3.5" />
                        {formProbing === "edit" ? "Testing…" : "Test"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={cancelEdit}>
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
                    {formProbe?.scope === "edit" && (
                      <div
                        className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs ${
                          formProbe.ok
                            ? "bg-green-500/10 text-green-700 dark:text-green-300"
                            : "bg-destructive/10 text-destructive"
                        }`}
                      >
                        {formProbe.ok ? (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        )}
                        <span className="break-all">{formProbe.message}</span>
                      </div>
                    )}
                  </div>
                ) : (
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
                      {cred.disabledAt && (
                        <span
                          className="shrink-0 flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                          title={cred.disabledReason ?? "Disabled after repeated failures. Agents skip it until you re-enable it (or save a fresh key)."}
                        >
                          <XCircle className="h-2.5 w-2.5" />
                          needs attention
                        </span>
                      )}
                      {!cred.disabledAt && formatCredentialCooldown(cred.cooldownUntil) && (
                        <span
                          className="shrink-0 flex items-center gap-0.5 rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-600"
                          title={`Cooling down after a failure${cred.cooldownReason ? ` (${cred.cooldownReason})` : ""}${cred.consecutiveFailureCount > 0 ? ` · ${cred.consecutiveFailureCount} consecutive` : ""}. Runs rotate to another bound credential of this type until the window elapses.`}
                        >
                          <Clock className="h-2.5 w-2.5" />
                          cooling {formatCredentialCooldown(cred.cooldownUntil)}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {new Date(cred.createdAt).toLocaleDateString()}
                      </span>
                      {(() => {
                        const u = usageByCredential.get(cred.id);
                        if (!u) return null;
                        const tokens = u.inputTokens + u.outputTokens;
                        if (tokens === 0 && u.costCents === 0) return null;
                        return (
                          <span
                            className="shrink-0 text-[10px] text-muted-foreground"
                            title={`${u.events} run(s) · ${u.inputTokens.toLocaleString()} in / ${u.outputTokens.toLocaleString()} out tokens · $${(u.costCents / 100).toFixed(2)} (last 30 days)`}
                          >
                            {formatTokenCount(tokens)} tok · ${(u.costCents / 100).toFixed(2)}
                          </span>
                        );
                      })()}
                      {(() => {
                        const quota = quotaByCredential.get(cred.id);
                        if (!quota) return null;
                        if (!quota.supported) {
                          return (
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              quota n/a
                            </span>
                          );
                        }
                        if (!quota.ok) {
                          return (
                            <span
                              className="shrink-0 text-[10px] text-amber-600"
                              title={quota.error ?? "Quota unavailable"}
                            >
                              quota unavailable
                            </span>
                          );
                        }
                        const window = quota.quotaWindows.find((entry) => entry.usedPercent != null) ?? quota.quotaWindows[0];
                        if (!window) return null;
                        return (
                          <span
                            className="shrink-0 text-[10px] text-muted-foreground"
                            title={quota.quotaWindows
                              .map((entry) => `${entry.label}: ${entry.usedPercent != null ? `${Math.round(entry.usedPercent)}% used` : entry.valueLabel ?? "reported"}`)
                              .join(" · ")}
                          >
                            {window.label}: {window.usedPercent != null ? `${Math.round(100 - window.usedPercent)}% left` : window.valueLabel ?? "quota ok"}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {cred.disabledAt && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px] text-destructive"
                          onClick={() => reenableMutation.mutate(cred.id)}
                          disabled={reenableMutation.isPending}
                          title="Re-enable this credential so agents use it again"
                        >
                          Re-enable
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => handleTest(cred.id)}
                        disabled={testingId === cred.id}
                        title="Test credential against provider API"
                      >
                        <Zap className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => handleReveal(cred.id)}
                        title={
                          revealedId === cred.id
                            ? "Hide credential"
                            : "Reveal credential"
                        }
                      >
                        {revealedId === cred.id ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </Button>
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
                {(testingId === cred.id || testResult?.id === cred.id) && (
                  <div
                    className={`mt-1 flex items-start gap-2 rounded px-2 py-1.5 text-xs ${
                      testingId === cred.id
                        ? "bg-muted/50 text-muted-foreground"
                        : testResult?.ok
                          ? "bg-green-500/10 text-green-700 dark:text-green-300"
                          : "bg-destructive/10 text-destructive"
                    }`}
                  >
                    {testingId === cred.id ? (
                      <span>Testing…</span>
                    ) : testResult?.ok ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span className="break-all">{testResult.message}</span>
                      </>
                    ) : (
                      <>
                        <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span className="break-all">{testResult?.message}</span>
                      </>
                    )}
                  </div>
                )}
                {revealedId === cred.id && revealedValue && (
                  <div className="mt-1 flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5">
                    <code className="text-xs font-mono text-foreground break-all flex-1">
                      {revealedValue}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(revealedValue);
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {showAddForm ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 px-3 py-3">
            <Field
              label="Name"
              hint="A human-readable label for this credential."
            >
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
                className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none appearance-none cursor-pointer"
                value={addType}
                onChange={(e) => {
                  // Token format differs per type — never carry a token across
                  // type changes. Otherwise the codex_oauth section would
                  // misread a stale Claude/OpenAI key as a "captured login".
                  setAddType(e.target.value as CredentialType);
                  setAddToken("");
                }}
              >
                {CREDENTIAL_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {CREDENTIAL_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            {addType === "codex_oauth" ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-3 space-y-2">
                <Button
                  size="sm"
                  onClick={() => openCodexAuth("add")}
                  disabled={startCodexAuth.isPending || codexAuthSessionId !== null}
                  className="gap-1.5"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  {startCodexAuth.isPending && codexAuthScope === "add"
                    ? "Starting…"
                    : addToken.trim().length > 0
                      ? "Re-sign in with ChatGPT"
                      : "Sign in with ChatGPT"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  We'll generate a one-time code. You'll open openai.com in a new tab,
                  paste the code, and approve. Done.
                </p>
                {addToken.trim().length > 0 && (
                  <div className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Login captured. Click Save to store this credential.
                  </div>
                )}
                {codexAuthStartError && codexAuthScope === "add" && (
                  <p className="text-xs text-destructive">{codexAuthStartError}</p>
                )}
              </div>
            ) : (
              <Field
                label={addType === "claude_oauth" ? "Access Token" : "API Key"}
                hint={
                  addType === "claude_oauth"
                    ? "Paste a long-lived setup-token (sk-ant-oat01-..., recommended), an OAuth access token, or the full ~/.claude/.credentials.json."
                    : undefined
                }
              >
                <input
                  className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  type="password"
                  value={addToken}
                  placeholder={credentialPlaceholder(addType)}
                  onChange={(e) => setAddToken(e.target.value)}
                />
              </Field>
            )}
            {addType === "claude_oauth" && (
              <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
                <div className="font-medium text-foreground">Long-lived token (recommended for production)</div>
                <ol className="list-decimal pl-4 space-y-0.5">
                  <li>
                    Open{" "}
                    <a
                      href="https://claude.ai/auth/setup-token"
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
                    >
                      https://claude.ai/auth/setup-token
                    </a>
                  </li>
                  <li>Authorize and copy the token shown.</li>
                  <li>Paste it above. Long-lived tokens (sk-ant-oat01-...) don't expire on the same cadence as OAuth sessions.</li>
                </ol>
                {isClaudeLongLivedToken(addToken) && (
                  <div className="text-green-700 dark:text-green-400 flex items-center gap-1 pt-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Long-lived token detected — will be wired via CLAUDE_CODE_OAUTH_TOKEN.
                  </div>
                )}
              </div>
            )}
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleFormProbe("add", addType, addToken)}
                disabled={formProbing === "add" || !addToken.trim()}
                className="gap-1.5"
              >
                <Zap className="h-3.5 w-3.5" />
                {formProbing === "add" ? "Testing…" : "Test"}
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
            {formProbe?.scope === "add" && (
              <div
                className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs ${
                  formProbe.ok
                    ? "bg-green-500/10 text-green-700 dark:text-green-300"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {formProbe.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                )}
                <span className="break-all">{formProbe.message}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setShowAddForm(true);
              }}
            >
              <KeyRound className="h-3.5 w-3.5" />
              Add credential
            </Button>
          </div>
        )}
      </div>
      <CodexDeviceAuthDialog
        open={codexAuthSessionId !== null}
        onOpenChange={(open) => {
          if (!open) closeCodexAuth();
        }}
        state={codexAuthState}
        successMessage="Captured. Saving credential…"
      />
    </div>
  );
}
