import { t, useTranslation } from "@/i18n";
import { createContext, useContext, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, KeyRound, Loader2, Plus, X } from "lucide-react";
import type { CompanySecret, SecretVersionSelector } from "@paperclipai/shared";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "../lib/utils";

export interface SecretBindingValue {
  secretId: string;
  version?: SecretVersionSelector;
}

/**
 * Metadata for bound secrets the current company's list cannot show — e.g.
 * an instance-scoped environment referencing a secret owned by another
 * company. Keyed by secret id. Editors that can read instance-level
 * secret-ref descriptors provide it; everywhere else the context is absent
 * and the picker falls back to its generic missing-secret treatment.
 */
export interface SecretRefHint {
  name: string;
  status: string;
  companyId: string;
  companyName: string | null;
}

/**
 * `status` reports the descriptor request itself, so the picker never claims
 * a secret is missing while the lookup is still loading or has failed —
 * only a `ready` map is authoritative about unknown ids.
 */
export interface SecretRefHintsContextValue {
  status: "loading" | "error" | "ready";
  hints: Record<string, SecretRefHint>;
}

export const SecretRefHintsContext = createContext<SecretRefHintsContextValue | undefined>(undefined);

interface SecretBindingPickerProps {
  value: SecretBindingValue | null;
  onChange: (next: SecretBindingValue | null) => void;
  label?: string;
  placeholder?: string;
  allowVersionSelector?: boolean;
  emptyHint?: string;
  className?: string;
  disabled?: boolean;
  /**
   * Optional whitelist of secret statuses to show. Defaults to "active".
   * Pass null to disable the filter and show every secret in the company.
   */
  statusFilter?: Array<CompanySecret["status"]> | null;
}

const VERSION_LATEST: SecretVersionSelector = "latest";

function describeSecret(secret: CompanySecret): string {
  const provider = secret.provider === "local_encrypted"
    ? t("localizationSecrets.localEncryptedProvider")
    : secret.provider.replaceAll("_", " ");
  if (secret.managedMode === "external_reference") {
    return t("localizationSecrets.externalProvider", { provider });
  }
  return provider;
}

function statusTone(status: CompanySecret["status"]): string {
  switch (status) {
    case "active":
      return "text-emerald-600 dark:text-emerald-400";
    case "disabled":
      return "text-amber-600 dark:text-amber-400";
    case "archived":
      return "text-muted-foreground";
    case "deleted":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

export function SecretBindingPicker({
  value,
  onChange,
  label = t("localizationSecrets.secret47"),
  placeholder = t("localizationSecrets.selectSecret48"),
  allowVersionSelector = true,
  emptyHint = t("localizationSecrets.noMatchingSecretsCreateOneToBindItHere49"),
  className,
  disabled,
  statusFilter = ["active"],
}: SecretBindingPickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.list(selectedCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const filteredSecrets = useMemo(() => {
    const all = secretsQuery.data ?? [];
    if (statusFilter === null) return all;
    return all.filter((secret) => statusFilter.includes(secret.status));
  }, [secretsQuery.data, statusFilter]);

  const selectedSecret = useMemo(() => {
    if (!value) return null;
    return (secretsQuery.data ?? []).find((secret) => secret.id === value.secretId) ?? null;
  }, [secretsQuery.data, value]);

  const selectedMissing = Boolean(value && !selectedSecret);
  const hintsContext = useContext(SecretRefHintsContext);
  const missingHint = selectedMissing && value ? hintsContext?.hints[value.secretId] : undefined;
  // Only an active cross-company secret is healthy: runtime resolution
  // rejects disabled/archived/deleted secrets, so those must not be
  // presented as working bindings.
  const crossCompanyHint = missingHint && missingHint.status === "active" ? missingHint : undefined;
  const hintsPending = selectedMissing && !missingHint && hintsContext !== undefined && hintsContext.status !== "ready";
  const calmMissing = Boolean(crossCompanyHint) || hintsPending;

  const createMutation = useMutation({
    mutationFn: () =>
      secretsApi.create(selectedCompanyId!, {
        name: createName.trim(),
        value: createValue,
        description: createDescription.trim() || null,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
      onChange({ secretId: created.id, version: VERSION_LATEST });
      setCreateOpen(false);
      setCreateName("");
      setCreateValue("");
      setCreateDescription("");
      setCreateError(null);
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error.message : t("localizationSecrets.failedToCreateSecret50"));
    },
  });

  const versionDisplay = (selector: SecretVersionSelector | undefined) => {
    if (selector === undefined || selector === VERSION_LATEST) return t("localizationRoutineHistory.latest");
    return `v${selector}`;
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between text-xs font-medium text-foreground/80">
          <span>{label}</span>
          {value ? (
            <button
              type="button"
              className="text-(length:--text-micro) text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              onClick={() => onChange(null)}
              disabled={disabled}
            >
              <X className="h-3 w-3" />{t("localizationSecrets.clear51")}</button>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <KeyRound className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <select
            className={cn(
              "h-9 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60",
              selectedMissing && !calmMissing && "border-destructive text-destructive",
            )}
            value={value?.secretId ?? ""}
            onChange={(event) => {
              const next = event.target.value;
              if (!next) {
                onChange(null);
                return;
              }
              onChange({ secretId: next, version: value?.version ?? VERSION_LATEST });
            }}
            disabled={disabled || secretsQuery.isPending}
          >
            <option value="">{secretsQuery.isPending ? t("localizationSecrets.loading52") : placeholder}</option>
            {selectedMissing && value ? (
              <option value={value.secretId}>
                {missingHint
                  ? `${missingHint.name} — ${missingHint.companyName ?? t("localizationSecrets.anotherOrganization54")}`
                  : hintsPending
                    ? t("localizationSecrets.secretReference", { id: value.secretId.slice(0, 8) })
                    : t("localizationSecrets.missingReference", { id: value.secretId.slice(0, 8) })}
              </option>
            ) : null}
            {filteredSecrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name} — {describeSecret(secret)}
              </option>
            ))}
          </select>
        </div>
        {allowVersionSelector ? (
          <select
            className="h-9 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
            value={value?.version === undefined ? VERSION_LATEST : String(value.version)}
            onChange={(event) => {
              if (!value) return;
              const raw = event.target.value;
              const next: SecretVersionSelector = raw === VERSION_LATEST ? VERSION_LATEST : Number.parseInt(raw, 10);
              onChange({ ...value, version: next });
            }}
            disabled={disabled || !value || !selectedSecret}
            aria-label={t("localizationSkills.version189")}
          >
            <option value={VERSION_LATEST}>{t("localizationRoutineHistory.latest")}</option>
            {selectedSecret
              ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => {
                  const version = selectedSecret.latestVersion - index;
                  if (version <= 0) return null;
                  return (
                    <option key={version} value={version}>
                      v{version}
                    </option>
                  );
                })
              : null}
          </select>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={disabled || !selectedCompanyId}
          aria-label={t("localizationSecrets.createSecret57")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {selectedSecret ? (
        <p className={cn("text-(length:--text-micro) text-muted-foreground", statusTone(selectedSecret.status))}>
          {selectedSecret.status !== "active" ? t("localizationSecrets.secretStatus", { status: t(`pages.secrets.status.${selectedSecret.status}`).toLocaleLowerCase() }) : null}
          {t("localizationSecrets.boundVersion", { version: versionDisplay(value?.version), key: selectedSecret.key })}
        </p>
      ) : crossCompanyHint ? (
        <p className="text-(length:--text-micro) text-muted-foreground flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {crossCompanyHint.companyName ? t("localizationSecrets.otherOwnerNamed", { company: crossCompanyHint.companyName }) : t("localizationSecrets.otherOwner")}
        </p>
      ) : missingHint ? (
        <p className="text-(length:--text-micro) text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {missingHint.status === "deleted"
            ? t("localizationSecrets.thePreviouslySelectedSecretWasDeletedPickAnot63")
            : t("localizationSecrets.inactiveSecret", { status: t(`pages.secrets.status.${missingHint.status}`, { defaultValue: missingHint.status }).toLocaleLowerCase() })}
        </p>
      ) : hintsPending ? (
        <p className="text-(length:--text-micro) text-muted-foreground flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {hintsContext?.status === "error"
            ? t("localizationSecrets.couldNotLoadThisSecretReferenceSDetails65")
            : t("localizationSecrets.checkingThisSecretReference66")}
        </p>
      ) : selectedMissing ? (
        <p className="text-(length:--text-micro) text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />{t("localizationSecrets.thePreviouslySelectedSecretIsNoLongerAvailabl67")}</p>
      ) : (filteredSecrets.length === 0 && !secretsQuery.isPending) ? (
        <p className="text-(length:--text-micro) text-muted-foreground">{emptyHint}</p>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("localizationSecrets.createNewSecret68")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-name">{t("localizationSecrets.name69")}</label>
              <Input
                id="secret-name"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="OPENAI_API_KEY"
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-value">{t("pages.secrets.fields.value")}</label>
              <Textarea
                id="secret-value"
                value={createValue}
                onChange={(event) => setCreateValue(event.target.value)}
                rows={3}
                placeholder={t("localizationSecrets.pasteTheSecretValue71")}
                className="font-mono text-xs"
              />
              <p className="text-(length:--text-micro) text-muted-foreground mt-1">{t("localizationSecrets.theValueIsStoredOnceAndNeverReDisplayedRotate72")}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-foreground/80" htmlFor="secret-description">{t("localizationSecrets.description73")}</label>
              <Input
                id="secret-description"
                value={createDescription}
                onChange={(event) => setCreateDescription(event.target.value)}
                placeholder={t("localizationSecrets.optionalNotesNoValues74")}
              />
            </div>
            {createError ? <p className="text-xs text-destructive">{createError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>{t("localizationSecrets.cancel75")}</Button>
            <Button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!createName.trim() || !createValue || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{t("localizationSecrets.createBind76")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
