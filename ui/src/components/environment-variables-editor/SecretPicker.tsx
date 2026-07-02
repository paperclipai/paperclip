import { useMemo } from "react";
import { KeyRound, Plus } from "lucide-react";
import type { CompanySecret, SecretStatus } from "@paperclipai/shared";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SecretOption extends SearchableSelectOption {
  secret?: CompanySecret;
  missing?: boolean;
  status?: SecretStatus;
}

function statusBadge(status: SecretStatus | undefined) {
  if (!status || status === "active") return null;
  return (
    <Badge variant="outline" className="ml-auto text-[10px] font-normal text-muted-foreground">
      {status}
    </Badge>
  );
}

export interface SecretPickerProps {
  /** Currently-bound secret id, or "" when unbound. */
  secretId: string;
  secrets: readonly CompanySecret[];
  recentlyUsedSecrets?: readonly CompanySecret[];
  disabled?: boolean;
  onSelect: (secretId: string) => void;
  /** Open the create-secret popover, seeded with the current query. */
  onCreateNew: (query: string) => void;
  triggerClassName?: string;
  /** SearchableSelect auto-opens on focus; suppress for programmatic control. */
  disablePortal?: boolean;
}

/**
 * Fuzzy secret combobox (plan §6.4). Reuses {@link SearchableSelect}, adds the
 * Recently-used group, greys non-active secrets (non-selectable for new
 * bindings), surfaces a missing-secret sentinel, and pins a `+ Create secret`
 * creatable item.
 */
export function SecretPicker({
  secretId,
  secrets,
  recentlyUsedSecrets,
  disabled,
  onSelect,
  onCreateNew,
  triggerClassName,
  disablePortal,
}: SecretPickerProps) {
  const boundSecret = useMemo(
    () => secrets.find((secret) => secret.id === secretId) ?? null,
    [secrets, secretId],
  );
  const boundMissing = Boolean(secretId) && !boundSecret;

  const groups = useMemo<SearchableSelectGroup<string, SecretOption>[]>(() => {
    const result: SearchableSelectGroup<string, SecretOption>[] = [];

    // Missing (deleted) secret still needs a resolvable option so the trigger
    // can render the destructive "Missing secret" chip.
    if (boundMissing) {
      result.push({
        id: "current-missing",
        label: "Current",
        options: [
          {
            key: `missing-${secretId}`,
            value: secretId,
            label: `Missing secret (${secretId.slice(0, 8)}…)`,
            missing: true,
            disabled: true,
          },
        ],
      });
    }

    const recent = (recentlyUsedSecrets ?? []).filter(
      (secret) => secret.status === "active" && secret.id !== secretId,
    );
    if (recent.length > 0) {
      result.push({
        id: "recently-used",
        label: "Recently used",
        options: recent.map((secret) => ({
          key: `recent-${secret.id}`,
          value: secret.id,
          label: secret.name,
          searchText: secret.key,
          secret,
          status: secret.status,
        })),
      });
    }

    result.push({
      id: "all-secrets",
      label: recent.length > 0 ? "All secrets" : undefined,
      options: secrets.map((secret) => ({
        key: `all-${secret.id}`,
        value: secret.id,
        label: secret.name,
        searchText: secret.key,
        secret,
        status: secret.status,
        // Non-active secrets are not selectable for new bindings, but the
        // already-bound one stays selectable (it's the current value).
        disabled: secret.status !== "active" && secret.id !== secretId,
      })),
    });

    return result;
  }, [boundMissing, recentlyUsedSecrets, secretId, secrets]);

  return (
    <SearchableSelect<string, SecretOption>
      value={secretId || ""}
      groups={groups}
      onValueChange={(next) => onSelect(next)}
      disabled={disabled}
      disablePortal={disablePortal}
      placeholder="Select secret…"
      searchPlaceholder="Search secrets…"
      emptyMessage="No matching secrets"
      triggerClassName={cn(
        "h-[34px] min-h-[34px] font-mono text-sm",
        boundMissing && "border-destructive text-destructive",
        boundSecret && boundSecret.status !== "active" && "border-amber-500/60",
        triggerClassName,
      )}
      renderValue={(option) => {
        if (!option) {
          return <span className="text-muted-foreground">Select secret…</span>;
        }
        if (option.missing) {
          return (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-destructive">
              <KeyRound className="size-3.5 shrink-0" />
              <span className="truncate">{option.label}</span>
            </span>
          );
        }
        const nonActive = option.status && option.status !== "active";
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <KeyRound className={cn("size-3.5 shrink-0", nonActive ? "text-amber-600" : "text-muted-foreground")} />
            <span className="truncate">{option.label}</span>
            {nonActive ? <span className="text-amber-600">({option.status})</span> : null}
          </span>
        );
      }}
      renderOption={(option, { selected }) => (
        <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", option.disabled && "opacity-60")}>
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("min-w-0 truncate font-mono text-sm", selected && "font-medium")}>{option.label}</span>
          {statusBadge(option.status)}
        </span>
      )}
      createItem={{
        render: (query) => (
          <span className="flex items-center gap-1.5 text-sm">
            <Plus className="size-3.5 shrink-0" />
            {query.trim() ? (
              <span>
                Create secret <span className="font-mono">&ldquo;{query.trim()}&rdquo;</span>…
              </span>
            ) : (
              <span>Create new secret…</span>
            )}
          </span>
        ),
        onSelect: (query) => onCreateNew(query),
      }}
    />
  );
}
