import { useCallback, useMemo, useState } from "react";
import { CornerUpLeft, Folder, KeyRound, Plus } from "lucide-react";
import type { CompanySecret, SecretStatus } from "@paperclipai/shared";
import {
  SearchableSelect,
  type SearchableSelectGroup,
  type SearchableSelectOption,
} from "@/components/SearchableSelect";
import { Badge } from "@/components/ui/badge";
import { normalizeSearchText } from "@/lib/searchable-select";
import { cn } from "@/lib/utils";

interface SecretOption extends SearchableSelectOption {
  kind?: "secret" | "folder" | "back";
  secret?: CompanySecret;
  missing?: boolean;
  status?: SecretStatus;
  folderPath?: string;
  pathHint?: string;
}

const FOLDER_VALUE_PREFIX = "__secret_folder__:";

function statusBadge(status: SecretStatus | undefined) {
  if (!status || status === "active") return null;
  return (
    <Badge variant="outline" className="ml-auto text-(length:--text-nano) font-normal text-muted-foreground">
      {status}
    </Badge>
  );
}

function splitSecretPath(name: string) {
  return name.split("/").filter((part) => part.length > 0);
}

function pathKey(parts: readonly string[]) {
  return parts.join("/");
}

function pathLabel(parts: readonly string[]) {
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

function pathStartsWith(parts: readonly string[], prefix: readonly string[]) {
  if (parts.length < prefix.length) return false;
  return prefix.every((part, index) => parts[index] === part);
}

function folderValue(parts: readonly string[]) {
  return `${FOLDER_VALUE_PREFIX}${pathKey(parts)}`;
}

function buildFolderGroup(
  secrets: readonly CompanySecret[],
  currentPath: readonly string[],
  currentSecretId: string,
): SearchableSelectGroup<string, SecretOption> {
  const currentLength = currentPath.length;
  const folders = new Map<string, SecretOption>();
  const leafSecrets: SecretOption[] = [];

  for (const secret of secrets) {
    const parts = splitSecretPath(secret.name);
    if (!pathStartsWith(parts, currentPath)) continue;

    if (parts.length > currentLength + 1) {
      const folderParts = parts.slice(0, currentLength + 1);
      const key = pathKey(folderParts);
      if (!folders.has(key)) {
        const label = folderParts[folderParts.length - 1] ?? "/";
        const fullPath = pathLabel(folderParts);
        folders.set(key, {
          key: `folder-${key || "root"}`,
          value: folderValue(folderParts),
          label,
          title: fullPath,
          searchText: fullPath,
          kind: "folder",
          folderPath: key,
          pathHint: fullPath,
        });
      }
      continue;
    }

    if (parts.length === currentLength + 1 || (currentLength === 0 && parts.length === 0)) {
      const label = parts.at(-1) ?? secret.name;
      leafSecrets.push({
        key: `browse-${secret.id}`,
        value: secret.id,
        label,
        title: secret.name,
        searchText: `${secret.key} ${secret.name}`,
        secret,
        status: secret.status,
        kind: "secret",
        pathHint: secret.name,
        disabled: secret.status !== "active" && secret.id !== currentSecretId,
      });
    }
  }

  const options: SecretOption[] = [];
  if (currentPath.length > 0) {
    const parentPath = currentPath.slice(0, -1);
    options.push({
      key: `folder-up-${pathKey(currentPath)}`,
      value: folderValue(parentPath),
      label: "Up one folder",
      title: pathLabel(parentPath),
      searchText: pathLabel(parentPath),
      kind: "back",
      folderPath: pathKey(parentPath),
      pathHint: pathLabel(parentPath),
    });
  }
  options.push(...folders.values(), ...leafSecrets);

  return {
    id: "browse-secrets",
    label: currentPath.length > 0 ? pathLabel(currentPath) : "Browse secrets",
    options,
  };
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
  const [currentPathKey, setCurrentPathKey] = useState("");
  const boundSecret = useMemo(
    () => secrets.find((secret) => secret.id === secretId) ?? null,
    [secrets, secretId],
  );
  const boundMissing = Boolean(secretId) && !boundSecret;
  const currentPath = useMemo(() => (currentPathKey ? currentPathKey.split("/") : []), [currentPathKey]);
  const hasFolderPaths = useMemo(() => secrets.some((secret) => splitSecretPath(secret.name).length > 1), [secrets]);

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
            title: `Missing secret (${secretId})`,
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
          title: secret.name,
          searchText: `${secret.key} ${secret.name}`,
          secret,
          status: secret.status,
          kind: "secret",
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
        title: secret.name,
        searchText: `${secret.key} ${secret.name}`,
        secret,
        status: secret.status,
        kind: "secret",
        // Non-active secrets are not selectable for new bindings, but the
        // already-bound one stays selectable (it's the current value).
        disabled: secret.status !== "active" && secret.id !== secretId,
      })),
    });

    return result;
  }, [boundMissing, recentlyUsedSecrets, secretId, secrets]);

  const deriveGroups = useCallback(
    (query: string, baseGroups: readonly SearchableSelectGroup<string, SecretOption>[]) => {
      if (!hasFolderPaths) return baseGroups;
      if (normalizeSearchText(query)) return baseGroups;

      const browseGroup = buildFolderGroup(secrets, currentPath, secretId);
      const stableGroups = baseGroups.filter((group) => group.id === "current-missing" || group.id === "recently-used");
      return browseGroup.options.length > 0 ? [...stableGroups, browseGroup] : stableGroups;
    },
    [currentPath, hasFolderPaths, secretId, secrets],
  );

  return (
    <SearchableSelect<string, SecretOption>
      value={secretId || ""}
      groups={groups}
      onValueChange={(next, option) => {
        if (option.folderPath !== undefined) {
          setCurrentPathKey(option.folderPath);
          return false;
        }
        setCurrentPathKey("");
        onSelect(next);
      }}
      deriveGroups={deriveGroups}
      disabled={disabled}
      disablePortal={disablePortal}
      placeholder="Select secret…"
      searchPlaceholder="Search secrets…"
      emptyMessage="No matching secrets"
      triggerClassName={cn(
        "h-(--sz-34px) min-h-(--sz-34px) font-mono text-sm",
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
            <span className="flex w-full min-w-0 items-center gap-1.5 text-destructive">
              <KeyRound className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </span>
          );
        }
        const nonActive = option.status && option.status !== "active";
        return (
          <span className="flex w-full min-w-0 items-center gap-1.5" title={option.title}>
            <KeyRound className={cn("size-3.5 shrink-0", nonActive ? "text-amber-600" : "text-muted-foreground")} />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {nonActive ? <span className="text-amber-600">({option.status})</span> : null}
          </span>
        );
      }}
      renderOption={(option, { selected }) => {
        if (option.kind === "folder" || option.kind === "back") {
          const Icon = option.kind === "back" ? CornerUpLeft : Folder;
          return (
            <span className="flex min-w-0 flex-1 items-center gap-1.5" title={option.title ?? option.label}>
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className={cn("truncate text-sm", selected && "font-medium")}>{option.label}</span>
                {option.pathHint ? (
                  <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">{option.pathHint}</span>
                ) : null}
              </span>
            </span>
          );
        }

        return (
          <span
            className={cn("flex min-w-0 flex-1 items-center gap-1.5", option.disabled && "opacity-60")}
            title={option.title ?? option.label}
          >
            <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className={cn("min-w-0 truncate font-mono text-sm", selected && "font-medium")}>
                {option.label}
              </span>
              {option.pathHint && option.pathHint !== option.label ? (
                <span className="truncate font-mono text-(length:--text-micro) text-muted-foreground">{option.pathHint}</span>
              ) : null}
            </span>
            {statusBadge(option.status)}
          </span>
        );
      }}
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
