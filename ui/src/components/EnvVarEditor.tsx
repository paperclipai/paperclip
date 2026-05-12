import { useEffect, useRef, useState } from "react";
import type { CompanySecret, EnvBinding, SecretVersionSelector } from "@paperclipai/shared";
import { AlertCircle, X } from "lucide-react";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type Row = {
  key: string;
  source: "plain" | "secret";
  plainValue: string;
  secretId: string;
  version: SecretVersionSelector;
};

function emptyRow(): Row {
  return { key: "", source: "plain", plainValue: "", secretId: "", version: "latest" };
}

function toRows(rec: Record<string, EnvBinding> | null | undefined): Row[] {
  if (!rec || typeof rec !== "object") {
    return [emptyRow()];
  }
  const entries = Object.entries(rec).map(([key, binding]) => {
    if (typeof binding === "string") {
      return { key, source: "plain" as const, plainValue: binding, secretId: "", version: "latest" as const };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "secret_ref"
    ) {
      const record = binding as { secretId?: unknown; version?: unknown };
      const version: SecretVersionSelector = typeof record.version === "number"
        ? record.version
        : "latest";
      return {
        key,
        source: "secret" as const,
        plainValue: "",
        secretId: typeof record.secretId === "string" ? record.secretId : "",
        version,
      };
    }
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "plain"
    ) {
      const record = binding as { value?: unknown };
      return {
        key,
        source: "plain" as const,
        plainValue: typeof record.value === "string" ? record.value : "",
        secretId: "",
        version: "latest" as const,
      };
    }
    return { key, source: "plain" as const, plainValue: "", secretId: "", version: "latest" as const };
  });
  return [...entries, emptyRow()];
}

export function EnvVarEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
}: {
  value: Record<string, EnvBinding>;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (env: Record<string, EnvBinding> | undefined) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [sealError, setSealError] = useState<string | null>(null);
  const valueRef = useRef(value);
  const emittingRef = useRef(false);

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
    if (
      withPatch[withPatch.length - 1].key ||
      withPatch[withPatch.length - 1].plainValue ||
      withPatch[withPatch.length - 1].secretId
    ) {
      withPatch.push(emptyRow());
    }
    setRows(withPatch);
    emit(withPatch);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, rowIndex) => rowIndex !== index);
    if (
      next.length === 0 ||
      next[next.length - 1].key ||
      next[next.length - 1].plainValue ||
      next[next.length - 1].secretId
    ) {
      next.push(emptyRow());
    }
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
          !row.secretId;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder="KEY"
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <select
              className={cn(inputClass, "flex-[1] bg-background")}
              value={row.source}
              onChange={(event) =>
                updateRow(index, {
                  source: event.target.value === "secret" ? "secret" : "plain",
                  ...(event.target.value === "plain" ? { secretId: "" } : {}),
                })
              }
            >
              <option value="plain">Plain</option>
              <option value="secret">Secret</option>
            </select>
            {row.source === "secret" ? (
              <>
                <select
                  className={cn(inputClass, "flex-[3] bg-background", row.secretId && !secrets.some((s) => s.id === row.secretId) && "border-destructive text-destructive")}
                  value={row.secretId}
                  onChange={(event) => updateRow(index, { secretId: event.target.value })}
                >
                  <option value="">Select secret...</option>
                  {row.secretId && !secrets.some((s) => s.id === row.secretId) ? (
                    <option value={row.secretId}>Missing ({row.secretId.slice(0, 8)}…)</option>
                  ) : null}
                  {secrets.map((secret) => (
                    <option key={secret.id} value={secret.id}>
                      {secret.name}
                      {secret.status !== "active" ? ` (${secret.status})` : ""}
                    </option>
                  ))}
                </select>
                <select
                  className={cn(inputClass, "flex-[1] bg-background")}
                  value={row.version === "latest" ? "latest" : String(row.version)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    updateRow(index, { version: raw === "latest" ? "latest" : Number.parseInt(raw, 10) });
                  }}
                  disabled={!row.secretId}
                  aria-label="Version"
                >
                  <option value="latest">latest</option>
                  {(() => {
                    const selected = secrets.find((s) => s.id === row.secretId);
                    if (!selected) return null;
                    return Array.from({ length: Math.max(0, selected.latestVersion) }, (_, idx) => {
                      const version = selected.latestVersion - idx;
                      if (version <= 0) return null;
                      return (
                        <option key={version} value={version}>
                          v{version}
                        </option>
                      );
                    });
                  })()}
                </select>
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
      <p className="text-[11px] text-muted-foreground/60">
        Set KEY to the env var name the process expects, for example GH_TOKEN. Choose Secret to resolve a stored
        value at run start. PAPERCLIP_* variables are injected automatically.
      </p>
    </div>
  );
}
