import { useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
  onCancel: () => void;
  /** Resolves once the secret is created + the row is bound; rejects with a message. */
  onSubmit: (name: string, value: string) => Promise<void>;
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
  onCancel,
  onSubmit,
}: SecretPopoverFormProps) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState(initialValue);
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const trimmedName = name.trim();
  const nameError = (() => {
    if (!trimmedName) return touched ? "Name is required" : null;
    if (!SECRET_NAME_RE.test(trimmedName)) return "Use lowercase letters, digits and _";
    if (existingSecretNames?.some((existing) => existing.toLowerCase() === trimmedName)) {
      return "A secret with this name already exists";
    }
    return null;
  })();
  const valueError = value.length === 0 ? (touched ? "Value is required" : null) : null;
  const canSubmit = !submitting && trimmedName.length > 0 && value.length > 0 && !nameError;

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

  const ctaLabel = mode === "create" ? "Create & bind" : "Store & bind";
  const heading = mode === "create" ? "Create secret" : "Store value as secret";

  return (
    <div className="w-72 space-y-3">
      <div className="space-y-1">
        <PopoverTitle className="text-sm font-medium">{heading}</PopoverTitle>
        {mode === "store" ? (
          <PopoverDescription className="text-[11px] text-muted-foreground">
            Moves the typed value into an encrypted company secret and binds{" "}
            <span className="font-mono">{initialName || "this variable"}</span> to it.
          </PopoverDescription>
        ) : null}
      </div>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium text-muted-foreground">Name</span>
        <input
          className={cn(fieldClass, nameError && "border-destructive focus-visible:ring-destructive/40")}
          value={name}
          autoFocus
          spellCheck={false}
          placeholder="secret_name"
          aria-label="Secret name"
          aria-invalid={nameError ? true : undefined}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        {nameError ? <span className="block text-[11px] text-destructive">{nameError}</span> : null}
      </label>

      <label className="block space-y-1">
        <span className="text-[11px] font-medium text-muted-foreground">Value</span>
        <div className="relative">
          <input
            className={cn(fieldClass, "pr-8", valueError && "border-destructive focus-visible:ring-destructive/40")}
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
        {valueError ? <span className="block text-[11px] text-destructive">{valueError}</span> : null}
      </label>

      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

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
