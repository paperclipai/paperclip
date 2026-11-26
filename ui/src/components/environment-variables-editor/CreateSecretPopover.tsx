import { useMemo, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import type { CompanySecret } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ANALYTICS_NO_CAPTURE_CLASS } from "@/lib/analytics/privacy";
import { PopoverTitle, PopoverDescription } from "@/components/ui/popover";

const SECRET_NAME_RE = /^[a-z][a-z0-9_]*$/;

const fieldClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring/40";

export interface SecretPopoverFormProps {
  /** Popover heading / body copy differ between the two flows. */
  mode: "create" | "store";
  initialName: string;
  /** The plaintext value being stored. Editable (create) or read-only (store). */
  initialValue: string;
  /** For a same-name uniqueness hint before the server round-trips. */
  existingSecretNames?: readonly string[];
  /** Existing company secrets so name collisions can bind or rotate instead of dead-ending. */
  existingSecrets?: readonly CompanySecret[];
  onCancel: () => void;
  /** Resolves once the secret is created + the row is bound; rejects with a message. */
  onSubmit: (name: string, value: string) => Promise<void>;
  /** Bind the row to an existing secret when its name already exists. */
  onSelectExisting?: (secret: CompanySecret) => void | Promise<void>;
  /** Rotate an existing secret with the typed value and bind the row. */
  onRotateExisting?: (secret: CompanySecret, value: string) => Promise<void>;
}

/**
 * Shared anchored-popover form behind {@link CreateSecretPopover} and
 * {@link ConvertToSecretPopover}. Replaces the old `window.prompt` seal flow
 * (plan §6.5). Meant to be rendered inside a `<PopoverContent>`.
 */
export function SecretPopoverForm({
  mode,
  initialName,
  initialValue,
  existingSecretNames,
  existingSecrets,
  onCancel,
  onSubmit,
  onSelectExisting,
  onRotateExisting,
}: SecretPopoverFormProps) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [selectedAmbiguousId, setSelectedAmbiguousId] = useState<string | null>(null);

  const { existingSecretByExactName, existingSecretsByLowerName } = useMemo(() => {
    const byExact = new Map<string, CompanySecret>();
    const byLower = new Map<string, CompanySecret[]>();
    for (const secret of existingSecrets ?? []) {
      const secretName = secret.name;
      if (!byExact.has(secretName)) byExact.set(secretName, secret);
      const lowerKey = secretName.toLowerCase();
      const bucket = byLower.get(lowerKey);
      if (bucket) {
        bucket.push(secret);
      } else {
        byLower.set(lowerKey, [secret]);
      }
    }
    return { existingSecretByExactName: byExact, existingSecretsByLowerName: byLower };
  }, [existingSecrets]);

  const existingSecretNameSet = useMemo(
    () =>
      existingSecrets
        ? new Set<string>()
        : new Set((existingSecretNames ?? []).map((existing) => existing.toLowerCase())),
    [existingSecrets, existingSecretNames],
  );

  const trimmedName = name.trim();
  const normalizedName = trimmedName.toLowerCase();
  const exactMatch = trimmedName.length > 0 ? (existingSecretByExactName.get(trimmedName) ?? null) : null;
  const lowerMatches = normalizedName.length > 0 ? (existingSecretsByLowerName.get(normalizedName) ?? []) : [];
  const ambiguousMatches = !exactMatch && lowerMatches.length > 1 ? lowerMatches : [];
  const selectedAmbiguousSecret =
    ambiguousMatches.length > 1 && selectedAmbiguousId
      ? (ambiguousMatches.find((candidate) => candidate.id === selectedAmbiguousId) ?? null)
      : null;
  const matchingSecret =
    exactMatch ?? (lowerMatches.length === 1 ? lowerMatches[0]! : selectedAmbiguousSecret);
  const hasNameCollision = Boolean(exactMatch || lowerMatches.length > 0);
  const existingIsActive = matchingSecret?.status === "active";
  const canRecoverCollision = Boolean(onSelectExisting || onRotateExisting);
  const hasCollisionActions = Boolean(hasNameCollision && canRecoverCollision);
  const canUseExisting = Boolean(matchingSecret && onSelectExisting && existingIsActive);
  const canRotateExisting = Boolean(
    matchingSecret &&
      onRotateExisting &&
      value.length > 0 &&
      matchingSecret.managedMode !== "external_reference" &&
      existingIsActive,
  );

  const nameError = (() => {
    if (!trimmedName) return touched ? "Name is required" : null;
    if (!SECRET_NAME_RE.test(trimmedName)) return "Use lowercase letters, digits and _";
    if (hasNameCollision) {
      return hasCollisionActions ? null : "A secret with this name already exists";
    }
    if (existingSecretNameSet.has(normalizedName)) {
      return "A secret with this name already exists";
    }
    return null;
  })();
  const valueError = value.length === 0 ? (touched ? "Value is required" : null) : null;
  const canSubmit = !submitting && !hasNameCollision && trimmedName.length > 0 && value.length > 0 && !nameError;

  async function handleSubmit() {
    setTouched(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmedName, value);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create secret");
      setSubmitting(false);
    }
  }

  async function handleUseExisting() {
    if (!matchingSecret || !canUseExisting || !onSelectExisting || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSelectExisting(matchingSecret);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : "Failed to bind existing secret");
      setSubmitting(false);
    }
  }

  async function handleRotateExisting() {
    if (!matchingSecret || !onRotateExisting || !canRotateExisting || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onRotateExisting(matchingSecret, value);
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : "Failed to save new secret version");
      setSubmitting(false);
    }
  }

  const ctaLabel = mode === "create" ? "Create & bind" : "Store & bind";
  const heading = mode === "create" ? "Create secret" : "Store value as secret";

  return (
    <div className="w-72 space-y-3">
      <div className="space-y-1">
        <PopoverTitle className="text-sm font-medium">{heading}</PopoverTitle>
        {mode === "store" ? (
          <PopoverDescription className="text-(length:--text-micro) text-muted-foreground">
            Moves the typed value into an encrypted organization secret and binds{" "}
            <span className="font-mono">{initialName || "this variable"}</span> to it.
          </PopoverDescription>
        ) : null}
      </div>

      <label className="block space-y-1">
        <span className="text-(length:--text-micro) font-medium text-muted-foreground">Name</span>
        <input
          className={cn(fieldClass, nameError && "border-destructive focus-visible:ring-destructive/40")}
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="secret_name"
          aria-label="Secret name"
          aria-invalid={nameError ? true : undefined}
          onChange={(event) => {
            setName(event.target.value);
            setSelectedAmbiguousId(null);
          }}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        {nameError ? <span className="block text-(length:--text-micro) text-destructive">{nameError}</span> : null}
      </label>

      {hasCollisionActions ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-2.5">
          {ambiguousMatches.length > 1 ? (
            <>
              <p className="text-(length:--text-micro) text-foreground">
                Multiple secrets match <span className="font-mono font-medium">{trimmedName}</span> with different
                casing. Choose which secret to use, or enter a different name:
              </p>
              <div className="flex flex-col gap-1">
                {ambiguousMatches.map((candidate) => {
                  const isSelected = matchingSecret?.id === candidate.id;
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => setSelectedAmbiguousId(candidate.id)}
                      aria-pressed={isSelected}
                      className={cn(
                        "flex items-center justify-between rounded border px-2 py-1 text-left text-(length:--text-micro) font-mono transition-colors",
                        isSelected
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-background/60 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{candidate.name}</span>
                      <span className="ml-2 shrink-0 font-sans text-muted-foreground">
                        {candidate.status === "active" ? `v${candidate.latestVersion}` : candidate.status}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {matchingSecret ? (
            <>
              {existingIsActive ? (
                <p className="text-(length:--text-micro) text-foreground">
                  <span className="font-mono font-medium">{matchingSecret.name}</span> already exists (v
                  {matchingSecret.latestVersion}).{" "}
                  {canRotateExisting
                    ? "Reuse it, save this value as a new version, or choose a different name."
                    : "Reuse it or choose a different name."}
                </p>
              ) : (
                <p className="text-(length:--text-micro) text-foreground">
                  <span className="font-mono font-medium">{matchingSecret.name}</span> already exists, but it is{" "}
                  {matchingSecret.status}. Re-enable it in Secrets before reusing it, or choose a different name.
                </p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {onSelectExisting ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleUseExisting()}
                    disabled={submitting || !existingIsActive}
                  >
                    Use existing secret
                  </Button>
                ) : null}
                {canRotateExisting ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleRotateExisting()}
                    disabled={submitting}
                  >
                    {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Save as new version
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <label className="block space-y-1">
        <span className="text-(length:--text-micro) font-medium text-muted-foreground">Value</span>
        <div className="relative">
          <input
            className={cn(fieldClass, "pr-8", ANALYTICS_NO_CAPTURE_CLASS, valueError && "border-destructive focus-visible:ring-destructive/40")}
            type={reveal ? "text" : "password"}
            value={value}
            readOnly={mode === "store"}
            spellCheck={false}
            placeholder={mode === "create" ? "value" : undefined}
            aria-label="Secret value"
            aria-invalid={valueError ? true : undefined}
            onChange={mode === "create" ? (event) => setValue(event.target.value) : undefined}
          />
          <button
            type="button"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide value" : "Show value"}
            onClick={() => setReveal((prev) => !prev)}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        {valueError ? <span className="block text-(length:--text-micro) text-destructive">{valueError}</span> : null}
      </label>

      {error ? <p className="text-(length:--text-micro) text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}

/** Create a brand-new secret from the fuzzy picker's creatable item (§6.4/§6.5). */
export function CreateSecretPopover(props: Omit<SecretPopoverFormProps, "mode">) {
  return <SecretPopoverForm mode="create" {...props} />;
}

/** Store a typed Text value as a secret and bind the row (replaces "Seal", §6.5). */
export function ConvertToSecretPopover(props: Omit<SecretPopoverFormProps, "mode">) {
  return <SecretPopoverForm mode="store" {...props} />;
}
