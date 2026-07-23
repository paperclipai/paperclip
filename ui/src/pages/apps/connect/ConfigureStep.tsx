import { useMemo, useState } from "react";
import { ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import {
  DEFAULT_OWNERSHIP_AVAILABILITY,
  type AppDefinition,
  type ConnectionMethodDef,
  type FieldDef,
  type ToolConnectionOwnership,
} from "@paperclipai/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { InlineBanner } from "@/components/InlineBanner";
import { CopyField } from "@/components/CopyField";
import { cn } from "@/lib/utils";
import { generateWhimsicalName, slugify } from "@/lib/whimsical-name";
import { FieldInput, InlineMarkdown } from "./field-input";

/** Assembled result the wizard maps onto the connect API. */
export interface ConfigureSubmit {
  name: string;
  uidSuffix: string;
  ownership: ToolConnectionOwnership;
  variantKey: string | null;
  /** tenant + credential + extension field values, keyed by FieldDef.key */
  fieldValues: Record<string, string>;
  /** api_key multi-key rows */
  apiKeys: Array<{ value: string; scope: string; expiresAt: string }>;
  /** generic OAuth OIDC discovery input */
  discoveryServerUrl: string | null;
}

/**
 * Out-of-band setup step (Snowflake-SQL pattern, plan-wizard-ux §2.3). Spec'd in
 * the grammar but not yet part of the shipped `ConnectionMethodDef` (no Wave-1
 * provider uses it — Snowflake is Wave 2), so we read it defensively; the UI
 * lights up automatically once the catalog type/data add the field.
 */
interface OutOfBandStep {
  id: string;
  instructionMd: string;
  copyableBlock?: string;
  confirmLabel: string;
}

function outOfBandStepsFor(method: ConnectionMethodDef): OutOfBandStep[] {
  const raw = (method as { outOfBandSteps?: unknown }).outOfBandSteps;
  return Array.isArray(raw) ? (raw as OutOfBandStep[]) : [];
}

const OWNERSHIP_LABELS: Record<ToolConnectionOwnership, string> = {
  platform_shared: "Managed by Paperclip",
  platform_provisioned: "Provisioned by Paperclip",
  customer: "Your own credentials",
  dcr: "Dynamic registration",
};

function namespaceFor(def: AppDefinition, method: ConnectionMethodDef): string {
  if (method.auth === "api_key" && method.defaults?.serviceHost) return method.defaults.serviceHost;
  if (def.slug === "oauth-generic") return "oauth";
  if (def.slug === "api-key-generic") return "api";
  return def.slug;
}

/**
 * Ownership modes that are actually available. Managed modes (platform_shared,
 * platform_provisioned) stay hidden until the connector service + provider app
 * exist for the provider (plan-catalog §5). When a def declares no availability
 * we fall back to the shared rails default, which keeps managed modes off — the
 * same gate {@link getAvailableConnectionMethod} applies — so an undefined
 * availability never accidentally surfaces a managed mode in the wizard.
 */
function availableOwnership(def: AppDefinition, method: ConnectionMethodDef): ToolConnectionOwnership[] {
  const avail = def.ownershipAvailability ?? DEFAULT_OWNERSHIP_AVAILABILITY;
  return method.ownershipModes.filter((mode) => avail[mode] !== false);
}

function isByoOAuth(method: ConnectionMethodDef, ownership: ToolConnectionOwnership): boolean {
  return method.auth === "oauth" && (ownership === "customer" || ownership === "dcr");
}

export interface ConfigureStepProps {
  def: AppDefinition;
  method: ConnectionMethodDef;
  /** Effective callback URL for redirect-URI callouts (instance-local or brokered). */
  redirectUriBase?: string;
  submitting?: boolean;
  onSubmit?: (payload: ConfigureSubmit) => void;
  /** Rotation surface reuses the field engine but never shows CTA/name. */
  rotation?: boolean;
}

/**
 * The Configure step of the Add-Connection wizard (plan-wizard-ux §2.3): the
 * per-method form assembled entirely from the {@link AppDefinition} data —
 * ownership tabs, guidance box + console links, tenant/credential/extension
 * fields, redirect-URI callout, out-of-band confirm gates, OIDC discovery,
 * multi-key rows, an auto-generated whimsical name + UID adornment, a specific
 * CTA, and the ownership footer.
 *
 * Self-contained form state so the preview harness can render every archetype
 * without a backend, and the wizard just consumes `onSubmit`.
 */
export function ConfigureStep({
  def,
  method,
  redirectUriBase = "https://connect.paperclip.ing/callback",
  submitting,
  onSubmit,
  rotation,
}: ConfigureStepProps) {
  const ownershipModes = useMemo(() => availableOwnership(def, method), [def, method]);
  const [ownership, setOwnership] = useState<ToolConnectionOwnership>(ownershipModes[0] ?? "customer");
  const [variantKey, setVariantKey] = useState<string | null>(method.variants?.[0]?.key ?? null);

  // Whimsical name is generated ONCE and stable until regenerated (not per-render).
  const [name, setName] = useState(() => `${def.name} ${generateWhimsicalName().split("-")[1]}`.trim());
  const [uidSuffix, setUidSuffix] = useState("");

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [apiKeys, setApiKeys] = useState<Array<{ value: string; scope: string; expiresAt: string }>>([
    { value: "", scope: "", expiresAt: "" },
  ]);
  const [discoveryServerUrl, setDiscoveryServerUrl] = useState("");
  const [discovered, setDiscovered] = useState(false);
  const [confirmedOob, setConfirmedOob] = useState<Set<string>>(new Set());

  const namespace = namespaceFor(def, method);
  const effectiveUid = `${namespace}/${uidSuffix.trim() || slugify(name) || "connection"}`;

  const activeVariant = method.variants?.find((v) => v.key === variantKey) ?? null;
  const tenantFields: FieldDef[] = [...(method.tenantFields ?? []), ...(activeVariant?.tenantFields ?? [])];
  const credentialFields = method.credentialFields ?? [];
  const extensionFields = method.extensionFields ?? [];
  const isApiKey = method.auth === "api_key";
  const isGenericOAuth = method.auth === "oauth" && def.slug === "oauth-generic";
  const byoOAuth = isByoOAuth(method, ownership);

  const setField = (key: string, value: string) =>
    setFieldValues((prev) => ({ ...prev, [key]: value }));

  const oobSteps = outOfBandStepsFor(method);
  const allOobConfirmed = oobSteps.every((s) => confirmedOob.has(s.id));
  const discoveryReady = !isGenericOAuth || discovered || !method.defaults?.metadataUrl;
  const canSubmit = !submitting && allOobConfirmed && discoveryReady;

  const ctaLabel = useMemo(() => {
    const verb = method.auth === "oauth" ? "Register OAuth Connector for" : "Create";
    // Assisted setup: the customer signs in and Paperclip creates the app for them.
    if (method.auth === "oauth" && ownership === "platform_provisioned") {
      return `Sign in & set up ${def.name}`;
    }
    if (method.auth === "oauth" && ownership !== "customer" && ownership !== "dcr") {
      return `Connect ${def.name}`;
    }
    return `${verb} ${def.name}${method.auth === "oauth" ? "" : " Connector"}`;
  }, [def.name, method.auth, ownership]);

  const consoleLinks = method.consoleLinks ?? {};

  return (
    <div className="space-y-5">
      {/* Guidance box — register-app steps + sharp caveats, above the form */}
      {method.guidanceMd && (
        <InlineBanner
          tone="info"
          title="Before you connect"
          actions={
            <div className="flex flex-wrap gap-1.5">
              {consoleLinks.register && (
                <ConsoleLink href={consoleLinks.register} icon={Settings2} label="Register app" />
              )}
              {consoleLinks.keys && <ConsoleLink href={consoleLinks.keys} icon={KeyRound} label="API keys" />}
              {(consoleLinks.docs ?? def.docsUrl) && (
                <ConsoleLink href={(consoleLinks.docs ?? def.docsUrl)!} icon={ExternalLink} label="Docs" />
              )}
            </div>
          }
        >
          <InlineMarkdown>{method.guidanceMd}</InlineMarkdown>
        </InlineBanner>
      )}

      {method.warnings?.map((w) => (
        <InlineBanner key={w} tone="warning">
          <InlineMarkdown>{w}</InlineMarkdown>
        </InlineBanner>
      ))}

      {/* Ownership tabs — real ARIA tabs, only when >1 mode available */}
      {ownershipModes.length > 1 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">Credential ownership</p>
          <Tabs value={ownership} onValueChange={(v) => setOwnership(v as ToolConnectionOwnership)}>
            <TabsList>
              {ownershipModes.map((mode) => (
                <TabsTrigger key={mode} value={mode}>
                  {OWNERSHIP_LABELS[mode]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Variant cards — protocol/topology forks as sibling cards */}
      {method.variants && method.variants.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Server type</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {method.variants.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => setVariantKey(v.key)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  variantKey === v.key
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-foreground/30 hover:bg-accent/40",
                )}
              >
                <p className="text-sm font-medium text-foreground">{v.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{v.whenToUse}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Connection name + UID adornment */}
      {!rotation && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="conn-name" className="text-sm font-medium text-foreground">
              Connection name
            </label>
            <div className="flex items-center gap-2">
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Generate a new name"
                onClick={() => setName(`${def.name} ${generateWhimsicalName().split("-")[1]}`)}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="conn-uid" className="text-sm font-medium text-foreground">
              Connection ID
            </label>
            <div className="flex items-stretch rounded-md border border-input">
              <span className="flex items-center whitespace-nowrap rounded-l-md border-r border-input bg-muted px-2.5 font-mono text-sm text-muted-foreground">
                {namespace}/
              </span>
              <Input
                id="conn-uid"
                value={uidSuffix}
                onChange={(e) => setUidSuffix(e.target.value)}
                placeholder={slugify(name) || "derive-from-name"}
                className="rounded-l-none border-0 font-mono focus-visible:ring-0"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Used by SDKs and the CLI — leave blank to derive from the name.
            </p>
          </div>
        </div>
      )}

      {/* OIDC discovery for generic OAuth */}
      {isGenericOAuth && (
        <div className="space-y-1.5">
          <label htmlFor="oidc-url" className="text-sm font-medium text-foreground">
            Server URL
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="oidc-url"
              value={discoveryServerUrl}
              onChange={(e) => {
                setDiscoveryServerUrl(e.target.value);
                setDiscovered(false);
              }}
              placeholder="https://auth.example.com"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!discoveryServerUrl.trim()}
              onClick={() => setDiscovered(true)}
            >
              {discovered ? "Change" : "Discover"}
            </Button>
          </div>
          {discovered && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Discovered authorization and token endpoints.
            </p>
          )}
        </div>
      )}

      {/* Tenant fields — instance params before credentials */}
      {tenantFields.length > 0 && (
        <div className="space-y-4">
          {tenantFields.map((f) => (
            <FieldInput
              key={f.key}
              id={`tenant-${f.key}`}
              field={f}
              value={fieldValues[f.key] ?? ""}
              onChange={(v) => setField(f.key, v)}
              rotation={rotation}
            />
          ))}
        </div>
      )}

      {/* Multi-key entry for api_key methods */}
      {isApiKey ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">API keys</p>
          {apiKeys.map((row, i) => (
            <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_140px_160px_auto]">
              <div className="space-y-1">
                {i === 0 && <span className="text-xs text-muted-foreground">Key</span>}
                <Input
                  type="password"
                  value={row.value}
                  placeholder={credentialFields[0]?.placeholder ?? "sk_live_…"}
                  autoComplete="off"
                  onChange={(e) =>
                    setApiKeys((prev) => prev.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                  }
                />
              </div>
              <div className="space-y-1">
                {i === 0 && <span className="text-xs text-muted-foreground">Scope (optional)</span>}
                <Input
                  value={row.scope}
                  placeholder="default"
                  onChange={(e) =>
                    setApiKeys((prev) => prev.map((r, j) => (j === i ? { ...r, scope: e.target.value } : r)))
                  }
                />
              </div>
              <div className="space-y-1">
                {i === 0 && <span className="text-xs text-muted-foreground">Expires (optional)</span>}
                <Input
                  type="date"
                  value={row.expiresAt}
                  onChange={(e) =>
                    setApiKeys((prev) => prev.map((r, j) => (j === i ? { ...r, expiresAt: e.target.value } : r)))
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={apiKeys.length === 1}
                onClick={() => setApiKeys((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setApiKeys((prev) => [...prev, { value: "", scope: "", expiresAt: "" }])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Add key
          </Button>
        </div>
      ) : (
        (credentialFields.length > 0 || extensionFields.length > 0) && (
          <div className="space-y-4">
            {credentialFields.map((f) => (
              <FieldInput
                key={f.key}
                id={`cred-${f.key}`}
                field={f}
                value={fieldValues[f.key] ?? ""}
                onChange={(v) => setField(f.key, v)}
                rotation={rotation}
              />
            ))}
            {extensionFields.map((f) => (
              <FieldInput
                key={f.key}
                id={`ext-${f.key}`}
                field={f}
                value={fieldValues[f.key] ?? ""}
                onChange={(v) => setField(f.key, v)}
                rotation={rotation}
              />
            ))}
          </div>
        )
      )}

      {/* Redirect-URI callout for BYO OAuth */}
      {byoOAuth && (
        <InlineBanner tone="warning" title="Add this redirect URI to your OAuth app">
          <p className="mb-2 text-sm">
            In your {def.name} app settings, add this exact callback URL:
          </p>
          <CopyField
            value={`${redirectUriBase}?connection=${slugify(name) || "connection"}`}
            label="Copy redirect URI"
          />
        </InlineBanner>
      )}

      {/* Out-of-band steps — copyable block + confirm gate */}
      {oobSteps.map((step) => (
        <div key={step.id} className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm text-foreground">
            <InlineMarkdown>{step.instructionMd}</InlineMarkdown>
          </p>
          {step.copyableBlock && <CopyField value={step.copyableBlock} label="Copy" />}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={confirmedOob.has(step.id)}
              onCheckedChange={(next) =>
                setConfirmedOob((prev) => {
                  const set = new Set(prev);
                  if (next === true) set.add(step.id);
                  else set.delete(step.id);
                  return set;
                })
              }
            />
            {step.confirmLabel}
          </label>
        </div>
      ))}

      {/* Ownership footer — honest copy about what gets created where (plan-wizard-ux §5.4) */}
      {!rotation && (
        <p className="text-xs text-muted-foreground">
          {ownership === "customer" || ownership === "dcr" ? (
            <>You are responsible for managing your {def.name} client credentials.</>
          ) : ownership === "platform_provisioned" ? (
            <>
              You sign in to {def.name} and Paperclip creates a dedicated {def.name} app in your own
              workspace. You won't copy or manage any keys — Paperclip securely holds the created
              app's credentials for you.
            </>
          ) : (
            <>
              You authorize Paperclip's {def.name} app; the consent screen will show Paperclip.
            </>
          )}
        </p>
      )}

      {!rotation && (
        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit?.({
                name: name.trim(),
                uidSuffix: uidSuffix.trim(),
                ownership,
                variantKey,
                fieldValues,
                apiKeys: apiKeys.filter((r) => r.value.trim()),
                discoveryServerUrl: isGenericOAuth ? discoveryServerUrl.trim() : null,
              })
            }
          >
            {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {ctaLabel}
          </Button>
        </div>
      )}

      {/* effectiveUid is surfaced for the wizard summary chip */}
      <input type="hidden" value={effectiveUid} readOnly aria-hidden />
    </div>
  );
}

function ConsoleLink({ href, icon: Icon, label }: { href: string; icon: typeof ExternalLink; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
    >
      <Icon className="h-3 w-3" /> {label}
    </a>
  );
}
