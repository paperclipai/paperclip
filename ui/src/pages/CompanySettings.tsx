import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { getCompanyLogoPath } from "../lib/companyBranding";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { Field, ToggleField, HintIcon } from "../components/agent-config-primitives";

export function CompanySettings() {
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [logoAssetId, setLogoAssetId] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setLogoAssetId(selectedCompany.logoAssetId ?? null);
  }, [selectedCompany]);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      logoAssetId !== (selectedCompany.logoAssetId ?? null));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      logoAssetId: string | null;
    }) =>
      companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });
  const logoUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!selectedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(selectedCompanyId, file, "companies/logos");
    },
    onSuccess: (asset) => {
      setLogoAssetId(asset.assetId);
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "both",
        expiresInHours: 72,
      }),
    onSuccess: (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const absoluteUrl = invite.inviteUrl.startsWith("http")
        ? invite.inviteUrl
        : `${base}${invite.inviteUrl}`;
      setInviteLink(absoluteUrl);
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
    onError: (err) => {
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" },
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
      logoAssetId,
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
          <Field label="Description" hint="Optional description shown in the company profile.">
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
                logoSrc={getCompanyLogoPath(logoAssetId)}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-2">
              <Field
                label="Company logo"
                hint="PNG, JPG, WEBP, or GIF. Upload overrides the generated icon."
              >
                <div className="flex items-center gap-2">
                  <input
                    ref={logoInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      logoUploadMutation.mutate(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoUploadMutation.isPending}
                  >
                    {logoUploadMutation.isPending ? "Uploading..." : "Upload logo"}
                  </Button>
                  {logoAssetId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setLogoAssetId(null)}
                      className="text-xs text-muted-foreground"
                    >
                      Remove logo
                    </Button>
                  )}
                </div>
                {logoUploadMutation.isError && (
                  <p className="text-xs text-destructive">
                    {logoUploadMutation.error instanceof Error
                      ? logoUploadMutation.error.message
                      : "Failed to upload logo"}
                  </p>
                )}
              </Field>
              <Field label="Brand color" hint="Sets the hue for the company icon. Leave empty for auto-generated color.">
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

      {/* Invites */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Invites
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Generate a link to invite humans or agents to this company.</span>
            <HintIcon text="Invite links expire after 72 hours and allow both human and agent joins." />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => inviteMutation.mutate()} disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? "Creating..." : "Create invite link"}
            </Button>
            {inviteLink && (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteLink);
                }}
              >
                Copy link
              </Button>
            )}
          </div>
          {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
          {inviteLink && (
            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="text-xs text-muted-foreground">Share link</div>
              <div className="mt-1 break-all font-mono text-xs">{inviteLink}</div>
            </div>
          )}
        </div>
      </div>

      {/* Archive */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-amber-700 uppercase tracking-wide">
          Archive
        </div>
        <div className="space-y-3 rounded-md border border-amber-300/60 bg-amber-100/30 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this company to hide it from the sidebar. This persists in the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={archiveMutation.isPending || selectedCompany.status === "archived"}
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`,
                );
                if (!confirmed) return;
                const nextCompanyId = companies.find((company) =>
                  company.id !== selectedCompanyId && company.status !== "archived")?.id ?? null;
                archiveMutation.mutate({ companyId: selectedCompanyId, nextCompanyId });
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
