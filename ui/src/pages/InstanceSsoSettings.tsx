import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstanceSsoProviderEntry, SsoProviderType } from "@paperclipai/shared";
import { Shield, Plus, Trash2 } from "lucide-react";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

const SSO_PROVIDER_TYPES: { value: SsoProviderType; label: string }[] = [
  { value: "keycloak", label: "Keycloak" },
  { value: "auth0", label: "Auth0" },
  { value: "okta", label: "Okta" },
  { value: "microsoft_entra_id", label: "Microsoft Entra ID" },
  { value: "oidc", label: "Generic OIDC" },
];

const PROVIDER_TYPE_LABELS: Record<SsoProviderType, string> = Object.fromEntries(
  SSO_PROVIDER_TYPES.map((t) => [t.value, t.label]),
) as Record<SsoProviderType, string>;

function providerIdFromType(type: SsoProviderType): string {
  return type.replace(/_/g, "-");
}

interface ProviderFormState {
  type: SsoProviderType;
  providerId: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  discoveryUrl: string;
  tenantId: string;
  domain: string;
  displayName: string;
  rolesEnabled: boolean;
  claimPath: string;
  roles: string;
}

function emptyForm(): ProviderFormState {
  return {
    type: "keycloak",
    providerId: providerIdFromType("keycloak"),
    clientId: "",
    clientSecret: "",
    issuer: "",
    discoveryUrl: "",
    tenantId: "",
    domain: "",
    displayName: "",
    rolesEnabled: false,
    claimPath: "",
    roles: "",
  };
}

function formToEntry(form: ProviderFormState): InstanceSsoProviderEntry {
  const entry: InstanceSsoProviderEntry = {
    providerId: form.providerId.trim() || providerIdFromType(form.type),
    type: form.type,
    clientId: form.clientId.trim(),
    clientSecret: form.clientSecret.trim(),
  };
  if (form.issuer.trim()) entry.issuer = form.issuer.trim();
  if (form.discoveryUrl.trim()) entry.discoveryUrl = form.discoveryUrl.trim();
  if (form.tenantId.trim()) entry.tenantId = form.tenantId.trim();
  if (form.domain.trim()) entry.domain = form.domain.trim();
  if (form.displayName.trim()) entry.displayName = form.displayName.trim();
  if (form.rolesEnabled && form.claimPath.trim() && form.roles.trim()) {
    entry.requiredRoles = {
      claimPath: form.claimPath.trim(),
      roles: form.roles
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    };
  }
  return entry;
}

function entryToForm(entry: InstanceSsoProviderEntry): ProviderFormState {
  return {
    type: entry.type,
    providerId: entry.providerId,
    clientId: entry.clientId,
    clientSecret: entry.clientSecret,
    issuer: entry.issuer ?? "",
    discoveryUrl: entry.discoveryUrl ?? "",
    tenantId: entry.tenantId ?? "",
    domain: entry.domain ?? "",
    displayName: entry.displayName ?? "",
    rolesEnabled: Boolean(entry.requiredRoles),
    claimPath: entry.requiredRoles?.claimPath ?? "",
    roles: entry.requiredRoles?.roles?.join(", ") ?? "",
  };
}

function typeNeedsIssuer(type: SsoProviderType): boolean {
  return type === "keycloak" || type === "okta";
}

function typeNeedsTenantId(type: SsoProviderType): boolean {
  return type === "microsoft_entra_id";
}

function typeNeedsDomain(type: SsoProviderType): boolean {
  return type === "auth0";
}

function typeNeedsDiscoveryUrl(type: SsoProviderType): boolean {
  return type === "oidc";
}

function FormField({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
    </div>
  );
}

function ProviderForm({
  form,
  onChange,
  onRemove,
  index,
}: {
  form: ProviderFormState;
  onChange: (form: ProviderFormState) => void;
  onRemove: () => void;
  index: number;
}) {
  const update = useCallback(
    (patch: Partial<ProviderFormState>) => onChange({ ...form, ...patch }),
    [form, onChange],
  );

  const inputCls =
    "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50";

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Provider {index + 1}: {PROVIDER_TYPE_LABELS[form.type] ?? form.type}
        </h3>
        <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Remove
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <FormField label="Provider Type">
          <select
            className={inputCls}
            value={form.type}
            onChange={(e) => {
              const newType = e.target.value as SsoProviderType;
              const patch: Partial<ProviderFormState> = { type: newType };
              if (form.providerId === providerIdFromType(form.type)) {
                patch.providerId = providerIdFromType(newType);
              }
              update(patch);
            }}
          >
            {SSO_PROVIDER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Provider ID" hint="Unique ID for Better Auth registration">
          <input
            className={inputCls}
            value={form.providerId}
            onChange={(e) => update({ providerId: e.target.value })}
            placeholder={providerIdFromType(form.type)}
          />
        </FormField>

        <FormField label="Display Name" hint="Button label on the login page">
          <input
            className={inputCls}
            value={form.displayName}
            onChange={(e) => update({ displayName: e.target.value })}
            placeholder={`Sign in with ${PROVIDER_TYPE_LABELS[form.type]}`}
          />
        </FormField>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <FormField label="Client ID">
          <input
            className={inputCls}
            value={form.clientId}
            onChange={(e) => update({ clientId: e.target.value })}
            placeholder="my-app-client-id"
          />
        </FormField>

        <FormField label="Client Secret">
          <input
            className={inputCls}
            type="password"
            value={form.clientSecret}
            onChange={(e) => update({ clientSecret: e.target.value })}
            placeholder="••••••••"
          />
        </FormField>
      </div>

      {typeNeedsIssuer(form.type) && (
        <FormField
          label="Issuer URL"
          hint={
            form.type === "keycloak"
              ? "e.g. https://keycloak.example.com/realms/my-realm"
              : "e.g. https://dev-12345.okta.com"
          }
        >
          <input
            className={inputCls}
            value={form.issuer}
            onChange={(e) => update({ issuer: e.target.value })}
            placeholder="https://"
          />
        </FormField>
      )}

      {typeNeedsDomain(form.type) && (
        <FormField label="Domain or Issuer" hint="e.g. my-tenant.auth0.com or full issuer URL">
          <input
            className={inputCls}
            value={form.domain || form.issuer}
            onChange={(e) => update({ domain: e.target.value })}
            placeholder="my-tenant.auth0.com"
          />
        </FormField>
      )}

      {typeNeedsTenantId(form.type) && (
        <FormField label="Tenant ID" hint="Azure AD / Entra ID tenant identifier">
          <input
            className={inputCls}
            value={form.tenantId}
            onChange={(e) => update({ tenantId: e.target.value })}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </FormField>
      )}

      {typeNeedsDiscoveryUrl(form.type) && (
        <FormField label="Discovery URL" hint="OIDC discovery endpoint (.well-known/openid-configuration)">
          <input
            className={inputCls}
            value={form.discoveryUrl}
            onChange={(e) => update({ discoveryUrl: e.target.value })}
            placeholder="https://idp.example.com/.well-known/openid-configuration"
          />
        </FormField>
      )}

      <div className="border-t border-border/50 pt-4 space-y-3">
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={form.rolesEnabled}
            onCheckedChange={(checked) => update({ rolesEnabled: checked })}
            aria-label="Enable role-based access restriction"
          />
          <div>
            <span className="text-sm font-medium">Role-based access restriction</span>
            <p className="text-xs text-muted-foreground">
              Only allow users with specific roles from the identity provider
            </p>
          </div>
        </div>

        {form.rolesEnabled && (
          <div className="grid grid-cols-2 gap-4 pl-1">
            <FormField
              label="Claim Path"
              hint="Dot-separated path in the id_token JWT"
            >
              <input
                className={inputCls}
                value={form.claimPath}
                onChange={(e) => update({ claimPath: e.target.value })}
                placeholder="resource_access.paperclip.roles"
              />
            </FormField>
            <FormField label="Required Roles" hint="Comma-separated list">
              <input
                className={inputCls}
                value={form.roles}
                onChange={(e) => update({ roles: e.target.value })}
                placeholder="human, admin"
              />
            </FormField>
          </div>
        )}
      </div>
    </section>
  );
}

export function InstanceSsoSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [forms, setForms] = useState<ProviderFormState[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "SSO" }]);
  }, [setBreadcrumbs]);

  const ssoQuery = useQuery({
    queryKey: queryKeys.instance.ssoSettings,
    queryFn: () => instanceSettingsApi.getSso(),
  });

  useEffect(() => {
    if (ssoQuery.data && !dirty) {
      setEnabled(ssoQuery.data.enabled);
      setForms(ssoQuery.data.providers.map(entryToForm));
    }
  }, [ssoQuery.data, dirty]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const providers = forms.map(formToEntry);
      return instanceSettingsApi.updateSso({ enabled, providers });
    },
    onSuccess: async () => {
      setActionError(null);
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.ssoSettings });
      await queryClient.invalidateQueries({ queryKey: ["auth", "sso-providers"] });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to save SSO settings.");
    },
  });

  const handleFormChange = useCallback((index: number, form: ProviderFormState) => {
    setForms((prev) => prev.map((f, i) => (i === index ? form : f)));
    setDirty(true);
  }, []);

  const handleRemove = useCallback((index: number) => {
    setForms((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }, []);

  const handleAddProvider = useCallback(() => {
    setForms((prev) => [...prev, emptyForm()]);
    setDirty(true);
  }, []);

  const handleToggleEnabled = useCallback((checked: boolean) => {
    setEnabled(checked);
    setDirty(true);
  }, []);

  const canSave =
    !saveMutation.isPending &&
    dirty &&
    forms.every((f) => f.clientId.trim() && f.clientSecret.trim());

  if (ssoQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading SSO settings...</div>;
  }

  if (ssoQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {ssoQuery.error instanceof Error
          ? ssoQuery.error.message
          : "Failed to load SSO settings."}
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Single Sign-On (SSO)</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure OpenID Connect providers for SSO login. When enabled, a "Sign in with SSO"
          button appears on the login page.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable SSO</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              When enabled, configured SSO providers override the{" "}
              <code className="text-xs">PAPERCLIP_SSO_PROVIDERS</code> environment variable.
              Users who log in via SSO are automatically provisioned into all existing companies.
            </p>
          </div>
          <ToggleSwitch
            checked={enabled}
            onCheckedChange={handleToggleEnabled}
            disabled={saveMutation.isPending}
            aria-label="Toggle SSO"
          />
        </div>
      </section>

      {enabled && (
        <>
          {forms.map((form, index) => (
            <ProviderForm
              key={index}
              form={form}
              index={index}
              onChange={(f) => handleFormChange(index, f)}
              onRemove={() => handleRemove(index)}
            />
          ))}

          <Button variant="outline" onClick={handleAddProvider} disabled={saveMutation.isPending}>
            <Plus className="h-4 w-4 mr-1.5" />
            Add SSO Provider
          </Button>
        </>
      )}

      <div className="flex items-center gap-3 pt-2">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={!canSave}
          className={cn(!canSave && "opacity-50")}
        >
          {saveMutation.isPending ? "Saving..." : "Save SSO Settings"}
        </Button>
        {dirty && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
        {!dirty && saveMutation.isSuccess && (
          <span className="text-xs text-emerald-500">Saved</span>
        )}
      </div>

      <section className="rounded-xl border border-border/50 bg-card/50 p-5 space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Important Notes</h2>
        <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
          <li>
            Changes take effect immediately — the auth handler is rebuilt on save without a server restart.
          </li>
          <li>
            SSO users who pass the role check are automatically added to all
            existing companies on first login.
          </li>
          <li>
            The <code>PAPERCLIP_SSO_PROVIDERS</code> environment variable still works as a
            fallback when SSO is not enabled in this UI.
          </li>
        </ul>
      </section>
    </div>
  );
}
