import { useEffect, useRef, useState } from "react";
import type {
  CompanySecret,
  EnvBinding,
  SecretVersionSelector,
  UserSecretDefinition,
} from "@paperclipai/shared";
import { AlertCircle, KeyRound, UserRound, X } from "lucide-react";
import { cn } from "../lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

// shadcn Select trigger sized to line up with the mono inputs above.
const selectTriggerClass =
  "h-[34px] min-h-[34px] rounded-md border-border bg-transparent px-2.5 text-sm font-mono shadow-none";

/** Radix Select forbids empty-string item values; use a sentinel for "unset". */
const SECRET_UNSET = "__unset__";

/** Suggest an env-var-style KEY from a secret name (UPPER_SNAKE). */
function envKeyFromSecretName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

type RowSource = "plain" | "secret" | "user_secret";

type Row = {
  key: string;
  source: RowSource;
  plainValue: string;
  secretId: string;
  version: SecretVersionSelector;
  /** For user_secret rows: the user-secret definition key this env var resolves from. */
  userSecretKey: string;
  /** For user_secret rows: whether a run must fail if the responsible user has not set a value. */
  required: boolean;
};

function emptyRow(): Row {
  return {
    key: "",
    source: "plain",
    plainValue: "",
    secretId: "",
    version: "latest",
    userSecretKey: "",
    required: true,
  };
}

function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
  if (!rec || typeof rec !== "object") {
    return [emptyRow()];
  }
  const entries = Object.entries(rec).map(([key, binding]): Row => {
    if (typeof binding === "string") {
      return { ...emptyRow(), key, source: "plain", plainValue: binding };
    }
    if (typeof binding === "object" && binding !== null && "type" in binding) {
      const type = (binding as { type?: unknown }).type;
      if (type === "secret_ref") {
        const record = binding as { secretId?: unknown; version?: unknown };
        const version: SecretVersionSelector =
          typeof record.version === "number" ? record.version : "latest";
        return {
          ...emptyRow(),
          key,
          source: "secret",
          secretId: typeof record.secretId === "string" ? record.secretId : "",
          version,
        };
      }
      if (type === "user_secret_ref") {
        const record = binding as { key?: unknown; version?: unknown; required?: unknown };
        const version: SecretVersionSelector =
          typeof record.version === "number" ? record.version : "latest";
        return {
          ...emptyRow(),
          key,
          source: "user_secret",
          userSecretKey: typeof record.key === "string" ? record.key : "",
          version,
          required: record.required !== false,
        };
      }
      if (type === "plain") {
        const record = binding as { value?: unknown };
        return {
          ...emptyRow(),
          key,
          source: "plain",
          plainValue: typeof record.value === "string" ? record.value : "",
        };
      }
    }
    return { ...emptyRow(), key, source: "plain" };
  });
  return [...entries, emptyRow()];
}

export function EnvVarEditor({
  value,
  secrets,
  userSecretDefinitions,
  onCreateSecret,
  onChange,
  recentlyUsedSecrets,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  /**
   * Optional company user-secret definitions. When present, the "User secret"
   * source becomes a picker over these definitions; otherwise the user types
   * the definition key directly. Absent for non-admin contexts.
   */
  userSecretDefinitions?: UserSecretDefinition[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
  /**
   * Optional project-scoped secrets to surface as one-tap "quick bind" chips
   * below the editor (§3.4). Already-bound secrets are filtered out.
   */
  recentlyUsedSecrets?: CompanySecret[];
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);
  const emittingRef = useRef(false);
  const userSecretsEnabled = (userSecretDefinitions?.length ?? 0) > 0;

  useEffect(() => {
    if (emittingRef.current) {
      emittingRef.current = false;
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: Row[]) {
    const rec: Record<string, EnvBinding> = {};
    for (const row of nextRows) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.source === "secret") {
        if (row.secretId) {
          rec[key] = { type: "secret_ref", secretId: row.secretId, version: row.version };
        } else {
          rec[key] = { type: "plain", value: row.plainValue };
        }
      } else if (row.source === "user_secret") {
        const definitionKey = row.userSecretKey.trim();
        if (definitionKey) {
          rec[key] = {
            type: "user_secret_ref",
            key: definitionKey,
            version: row.version,
            required: row.required,
          };
        } else {
          rec[key] = { type: "plain", value: row.plainValue };
        }
      } else {
        rec[key] = { type: "plain", value: row.plainValue };
      }
    }
    emittingRef.current = true;
    onChange(Object.keys(rec).length > 0 ? rec : undefined);
  }

  function updateRow(index: number, patch: Partial<Row>) {
    const withPatch: Row[] = rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch, version: patch.version ?? row.version } : row,
    );
    const last = withPatch[withPatch.length - 1];
    if (last.key || last.plainValue || last.secretId || last.userSecretKey) {
      withPatch.push(emptyRow());
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    const last = next[next.length - 1];
    if (next.length === 0 || last.key || last.plainValue || last.secretId || last.userSecretKey) {
      next.push(emptyRow());
    }
    setRows(next);
    emit(next);
  }

  function bindRecentSecret(secret: CompanySecret) {
    // Fill the trailing empty row (or append one) with this secret bound.
    const next = rows.map((row) => ({ ...row }));
    const trailing = next[next.length - 1];
    let target: Row;
    if (
      trailing &&
      !trailing.key &&
      !trailing.plainValue &&
      !trailing.secretId &&
      !trailing.userSecretKey
    ) {
      target = trailing;
    } else {
      target = emptyRow();
      next.push(target);
    }
    target.source = "secret";
    target.secretId = secret.id;
    target.version = "latest";
    if (!target.key) target.key = envKeyFromSecretName(secret.name);
    next.push(emptyRow());
    setRows(next);
    emit(next);
  }

  function defaultSecretName(key: string) {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  async function sealRow(index: number) {
    const row = rows[index];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(name, plain);
      updateRow(index, { source: "secret", secretId: created.id });
    } catch (error) {
      setSealError(error instanceof Error ? error.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => {
        const isTrailing =
          index === rows.length - 1 &&
          !row.key &&
          !row.plainValue &&
          !row.secretId &&
          !row.userSecretKey;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <Select
              value={row.source}
              onValueChange={(next) =>
                updateRow(index, {
                  source: next as RowSource,
                  ...(next === "plain" ? { secretId: "", userSecretKey: "" } : {}),
                  ...(next === "secret" ? { userSecretKey: "" } : {}),
                  ...(next === "user_secret" ? { secretId: "" } : {}),
                })
              }
            >
              <SelectTrigger className={cn(selectTriggerClass, "flex-[1]")} aria-label="Binding mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plain">Plain</SelectItem>
                <SelectItem value="secret">Company secret</SelectItem>
                <SelectItem value="user_secret">User secret</SelectItem>
              </SelectContent>
            </Select>
            {row.source === "secret" ? (
              <>
                <Select
                  value={row.secretId || SECRET_UNSET}
                  onValueChange={(next) =>
                    updateRow(index, { secretId: next === SECRET_UNSET ? "" : next })
                  }
                >
                  <SelectTrigger
                    aria-label="Secret"
                    className={cn(
                      selectTriggerClass,
                      "flex-[3]",
                      row.secretId &&
                        !secrets.some((s) => s.id === row.secretId) &&
                        "border-destructive text-destructive",
                    )}
                  >
                    <SelectValue placeholder="Select secret..." />
                  </SelectTrigger>
                  <SelectContent>
                    {row.secretId && !secrets.some((s) => s.id === row.secretId) ? (
                      <SelectItem value={row.secretId}>
                        Missing ({row.secretId.slice(0, 8)}…)
                      </SelectItem>
                    ) : null}
                    {secrets.map((secret) => (
                      <SelectItem key={secret.id} value={secret.id}>
                        {secret.name}
                        {secret.status !== "active" ? ` (${secret.status})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={row.version === "latest" ? "latest" : String(row.version)}
                  onValueChange={(raw) =>
                    updateRow(index, {
                      version: raw === "latest" ? "latest" : Number.parseInt(raw, 10),
                    })
                  }
                  disabled={!row.secretId}
                >
                  <SelectTrigger className={cn(selectTriggerClass, "flex-[1]")} aria-label="Version">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="latest">latest</SelectItem>
                    {(() => {
                      const selected = secrets.find((s) => s.id === row.secretId);
                      if (!selected) return null;
                      return Array.from({ length: Math.max(0, selected.latestVersion) }, (_, idx) => {
                        const version = selected.latestVersion - idx;
                        if (version <= 0) return null;
                        return (
                          <SelectItem key={version} value={String(version)}>
                            v{version}
                          </SelectItem>
                        );
                      });
                    })()}
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(index)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Create secret from current plain value"
                >
                  New
                </button>
              </>
            ) : row.source === "user_secret" ? (
              <>
                {userSecretsEnabled ? (
                  <Select
                    value={row.userSecretKey || SECRET_UNSET}
                    onValueChange={(next) => {
                      const definitionKey = next === SECRET_UNSET ? "" : next;
                      const definition = userSecretDefinitions?.find((d) => d.key === definitionKey);
                      updateRow(index, {
                        userSecretKey: definitionKey,
                        ...(definition && !row.key.trim()
                          ? { key: envKeyFromSecretName(definition.key) }
                          : {}),
                      });
                    }}
                  >
                    <SelectTrigger
                      aria-label="User secret"
                      className={cn(
                        selectTriggerClass,
                        "flex-[3]",
                        row.userSecretKey &&
                          !userSecretDefinitions?.some((d) => d.key === row.userSecretKey) &&
                          "border-destructive text-destructive",
                      )}
                    >
                      <SelectValue placeholder="Select user secret..." />
                    </SelectTrigger>
                    <SelectContent>
                      {row.userSecretKey &&
                      !userSecretDefinitions?.some((d) => d.key === row.userSecretKey) ? (
                        <SelectItem value={row.userSecretKey}>
                          Unknown ({row.userSecretKey})
                        </SelectItem>
                      ) : null}
                      {(userSecretDefinitions ?? []).map((definition) => (
                        <SelectItem key={definition.id} value={definition.key}>
                          {definition.name}
                          {definition.status !== "active" ? ` (${definition.status})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <input
                    className={cn(inputClass, "flex-[3]")}
                    placeholder="user-secret key"
                    aria-label="User secret key"
                    value={row.userSecretKey}
                    onChange={(event) => updateRow(index, { userSecretKey: event.target.value })}
                  />
                )}
                <Select
                  value={row.required ? "required" : "optional"}
                  onValueChange={(next) => updateRow(index, { required: next === "required" })}
                >
                  <SelectTrigger
                    className={cn(selectTriggerClass, "flex-[1]")}
                    aria-label="Requirement"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="required">Required</SelectItem>
                    <SelectItem value="optional">Optional</SelectItem>
                  </SelectContent>
                </Select>
                <div className="w-[34px] shrink-0" />
              </>
            ) : (
              <>
                <input
                  className={cn(inputClass, "flex-[3]")}
                  placeholder="value"
                  value={row.plainValue}
                  onChange={(event) => updateRow(index, { plainValue: event.target.value })}
                />
                <button
                  type="button"
                  className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
                  onClick={() => sealRow(index)}
                  disabled={!row.key.trim() || !row.plainValue}
                  title="Store value as secret and replace with reference"
                >
                  Seal
                </button>
              </>
            )}
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(index)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {(() => {
        const boundIds = new Set(
          rows.filter((row) => row.source === "secret" && row.secretId).map((row) => row.secretId),
        );
        const quick = (recentlyUsedSecrets ?? [])
          .filter((secret) => secret.status === "active" && !boundIds.has(secret.id))
          .slice(0, 8);
        if (quick.length === 0) return null;
        return (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <KeyRound className="h-3 w-3" />
              Recently used:
            </span>
            {quick.map((secret) => (
              <button
                key={secret.id}
                type="button"
                onClick={() => bindRecentSecret(secret)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                title={`Bind ${secret.name}`}
              >
                + {secret.name}
              </button>
            ))}
          </div>
        );
      })()}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
      {(() => {
        const issues: { key: string; reason: string }[] = [];
        for (const row of rows) {
          if (row.source !== "secret" || !row.secretId) continue;
          const secret = secrets.find((s) => s.id === row.secretId);
          if (!secret) {
            issues.push({ key: row.key.trim() || row.secretId, reason: "missing" });
          } else if (secret.status !== "active") {
            issues.push({ key: row.key.trim() || secret.name, reason: secret.status });
          }
        }
        if (!issues.length) return null;
        return (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 inline-flex items-start gap-1">
            <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              {issues.length} secret binding{issues.length === 1 ? "" : "s"} need attention:{" "}
              {issues.map((issue, idx) => (
                <span key={idx} className="font-mono">
                  {issue.key}
                  <span className="text-muted-foreground"> ({issue.reason})</span>
                  {idx < issues.length - 1 ? ", " : ""}
                </span>
              ))}
              . Runs will fail until you remap or re-enable.
            </span>
          </p>
        );
      })()}
      {(() => {
        const userRows = rows.filter((row) => row.source === "user_secret" && row.userSecretKey);
        if (!userRows.length) return null;
        return (
          <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1">
            <UserRound className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              User secrets resolve to the value set by the user responsible for the run. Required
              bindings fail the run until that user sets their value under Secrets → My secrets.
            </span>
          </p>
        );
      })()}
      <p className="text-[11px] text-muted-foreground/60">
        Set KEY to the env var name the process expects, for example GH_TOKEN. Choose Company secret
        to resolve a shared stored value, or User secret to resolve each user&apos;s own value at run
        start. PAPERCLIP_* variables are injected automatically.
      </p>
    </div>
  );
}
