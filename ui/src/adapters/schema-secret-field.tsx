import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ConfigFieldSchema } from "@paperclipai/adapter-utils";
import { DraftInput, Field } from "../components/agent-config-primitives";
import { SecretBindingPicker, type SecretBindingValue } from "../components/SecretBindingPicker";

const REDACTED_PLACEHOLDER = "***REDACTED***";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 pl-8";

type SecretRefValue = {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
};

export function isSchemaSecretField(field: ConfigFieldSchema): boolean {
  return field.meta?.secret === true;
}

export function isSecretRefValue(value: unknown): value is SecretRefValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

export function schemaSecretBinding(value: unknown): SecretBindingValue | null {
  if (!isSecretRefValue(value)) return null;
  return { secretId: value.secretId, version: value.version ?? "latest" };
}

export function schemaSecretRawValue(value: unknown): string {
  if (typeof value !== "string" || value === REDACTED_PLACEHOLDER) return "";
  return value;
}

export function schemaSecretRef(binding: SecretBindingValue): SecretRefValue {
  return { type: "secret_ref", secretId: binding.secretId, version: binding.version ?? "latest" };
}

export function SchemaSecretField({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [visible, setVisible] = useState(false);
  const binding = schemaSecretBinding(value);
  const raw = schemaSecretRawValue(value);
  const storedRedacted = value === REDACTED_PLACEHOLDER;

  return (
    <Field label={field.label} hint={field.hint}>
      <div className="space-y-2">
        <SecretBindingPicker
          value={binding}
          onChange={(next) => onChange(next ? schemaSecretRef(next) : undefined)}
          label=""
          placeholder="Select an existing secret"
          allowVersionSelector={false}
          emptyHint="No active secrets yet. Create one or enter a value below."
        />
        {binding ? null : (
          <div className="relative">
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              aria-label={visible ? `Hide ${field.label}` : `Show ${field.label}`}
            >
              {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
            <DraftInput
              value={raw}
              onCommit={(v) => onChange(v || undefined)}
              immediate
              type={visible ? "text" : "password"}
              className={inputClass}
              aria-label={field.label}
              placeholder={
                storedRedacted
                  ? "Stored secret; enter a new value to replace it"
                  : "Or enter a new value (stored as a secret on save)"
              }
            />
          </div>
        )}
      </div>
    </Field>
  );
}
