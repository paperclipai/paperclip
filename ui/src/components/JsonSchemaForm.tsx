import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { companiesApi } from "@/api/companies";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import type { Agent, Company, CompanySecret, Project } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Threshold for string length above which a Textarea is used instead of a standard Input.
 */
const TEXTAREA_THRESHOLD = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of JSON Schema properties we understand for form rendering.
 * We intentionally keep this loose (`Record<string, unknown>`) at the top
 * level to match the `JsonSchema` type in shared, but narrow internally.
 */
export interface JsonSchemaNode {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  format?: string;

  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // Number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // Object
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;
  /**
   * Explicit ordering for the form renderer. JSON Schema doesn't define field
   * order, and PostgreSQL JSONB canonicalizes keys (length-then-alphabetical)
   * when storing the manifest, so author-declared order in the source TS file
   * is lost. When a schema includes `propertyOrder`, fields named there are
   * rendered first in the listed order; any remaining fields follow in the
   * map's iteration order.
   */
  propertyOrder?: string[];

  // Array
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;

  // Metadata
  readOnly?: boolean;
  writeOnly?: boolean;

  // Allow extra keys
  [key: string]: unknown;
}

export interface JsonSchemaFormProps {
  /** The JSON Schema to render. */
  schema: JsonSchemaNode;
  /** Current form values. */
  values: Record<string, unknown>;
  /** Called whenever any field value changes. */
  onChange: (values: Record<string, unknown>) => void;
  /** Validation errors keyed by JSON pointer path (e.g. "/apiKey"). */
  errors?: Record<string, string>;
  /** If true, all fields are disabled. */
  disabled?: boolean;
  /** Additional CSS class for the root container. */
  className?: string;
  /**
   * Path prefix to prepend to generated field paths. Used when this form is
   * nested inside an ArrayField/ObjectField so scalar fields can resolve
   * sibling values via JSON-pointer-style paths anchored at the form root.
   * Outer callers should leave this unset.
   */
  pathPrefix?: string;
  /**
   * UUID of the plugin this form belongs to. Required for `x-paperclip-actions`
   * buttons to call `POST /api/plugins/:pluginId/actions/:actionKey`. When unset,
   * action buttons render as disabled.
   */
  pluginId?: string;
  /**
   * Optional list of secrets the operator can pick from for `format: "secret-ref"`
   * fields. When provided, those fields render a name-picker dropdown alongside
   * the manual UUID input. Stored value is always the secret's UUID, regardless
   * of how it was entered. Caller is responsible for fetching this list (e.g.
   * via `secretsApi.list(companyId)`) and passing it in.
   */
  secrets?: CompanySecret[];
}

/**
 * Per-item action declaration. When an array's items schema (or any object
 * schema) includes `x-paperclip-actions`, the form renders a button per
 * declaration alongside that item. Clicking the button calls the plugin's
 * `performAction` handler keyed by `actionKey` and renders the structured
 * result inline. The action handler typically validates input and performs
 * a side-effecting check like a connection probe.
 */
export interface PaperclipActionDecl {
  /** Action key matching `ctx.actions.register(...)` in the plugin worker. */
  actionKey: string;
  /** Button label. */
  label: string;
  /** Optional aria-label / tooltip. */
  description?: string;
  /** When set, the API param under `paramName` is filled from `item[itemKey]`. */
  paramName?: string;
  itemKey?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the primary type string from a schema node. */
export function resolveType(schema: JsonSchemaNode): string {
  if (schema["x-paperclip-optionsFromSibling"]) return "sibling-enum";
  if (schema["x-paperclip-optionsFrom"]) return "dynamic-enum";
  if (schema.enum) return "enum";
  if (schema.const !== undefined) return "const";
  if (schema.format === "secret-ref") return "secret-ref";
  if (Array.isArray(schema.type)) {
    // Use the first non-null type
    return schema.type.find((t) => t !== "null") ?? "string";
  }
  return schema.type ?? "string";
}

/** Human-readable label from schema title or property key. */
export function labelFromKey(key: string, schema: JsonSchemaNode): string {
  if (schema.title) return schema.title;
  // Convert camelCase / snake_case to Title Case
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Heading for an item in an array-of-objects field.
 * Prefers the item's own `name` field, then `key`, then falls back to `Item N`.
 * This lets plugin authors give resources human-readable headings (e.g. a
 * mailbox row reads "Personal Mailbox" instead of "Item 1").
 */
export function itemHeading(item: unknown, index: number): string {
  if (item && typeof item === "object") {
    const obj = item as Record<string, unknown>;
    const name = obj.name;
    if (typeof name === "string" && name.trim().length > 0) return name;
    const key = obj.key;
    if (typeof key === "string" && key.trim().length > 0) return key;
  }
  return `Item ${index + 1}`;
}

/** Produce a sensible default value for a schema node. */
export function getDefaultForSchema(schema: JsonSchemaNode): unknown {
  if (schema.default !== undefined) return schema.default;

  const type = resolveType(schema);
  switch (type) {
    case "string":
    case "secret-ref":
      return "";
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "dynamic-enum":
    case "sibling-enum":
      return "";
    case "enum":
      return schema.enum?.[0] ?? "";
    case "array":
      return [];
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        obj[key] = getDefaultForSchema(propSchema);
      }
      return obj;
    }
    default:
      return "";
  }
}

/** Validate a single field value against schema constraints. Returns error string or null. */
export function validateField(
  value: unknown,
  schema: JsonSchemaNode,
  isRequired: boolean,
): string | null {
  const type = resolveType(schema);

  // Required check
  if (isRequired && (value === undefined || value === null || value === "")) {
    return "This field is required";
  }

  // Skip further validation if empty and not required
  if (value === undefined || value === null || value === "") return null;

  if (type === "string" || type === "secret-ref") {
    const str = String(value);
    if (schema.minLength != null && str.length < schema.minLength) {
      return `Must be at least ${schema.minLength} characters`;
    }
    if (schema.maxLength != null && str.length > schema.maxLength) {
      return `Must be at most ${schema.maxLength} characters`;
    }
    if (schema.pattern) {
      // Guard against ReDoS: reject overly complex patterns from plugin JSON Schemas.
      // Limit pattern length and run the regex with a defensive try/catch.
      const MAX_PATTERN_LENGTH = 512;
      if (schema.pattern.length <= MAX_PATTERN_LENGTH) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(str)) {
            return `Must match pattern: ${schema.pattern}`;
          }
        } catch {
          // Invalid regex in schema — skip
        }
      }
    }
  }

  if (type === "number" || type === "integer") {
    const num = Number(value);
    if (isNaN(num)) return "Must be a valid number";
    if (schema.minimum != null && num < schema.minimum) {
      return `Must be at least ${schema.minimum}`;
    }
    if (schema.maximum != null && num > schema.maximum) {
      return `Must be at most ${schema.maximum}`;
    }
    if (schema.exclusiveMinimum != null && num <= schema.exclusiveMinimum) {
      return `Must be greater than ${schema.exclusiveMinimum}`;
    }
    if (schema.exclusiveMaximum != null && num >= schema.exclusiveMaximum) {
      return `Must be less than ${schema.exclusiveMaximum}`;
    }
    if (type === "integer" && !Number.isInteger(num)) {
      return "Must be a whole number";
    }
    if (schema.multipleOf != null && num % schema.multipleOf !== 0) {
      return `Must be a multiple of ${schema.multipleOf}`;
    }
  }

  if (type === "array") {
    const arr = value as unknown[];
    if (schema.minItems != null && arr.length < schema.minItems) {
      return `Must have at least ${schema.minItems} items`;
    }
    if (schema.maxItems != null && arr.length > schema.maxItems) {
      return `Must have at most ${schema.maxItems} items`;
    }
  }

  return null;
}

/** Public API for validation */
export function validateJsonSchemaForm(
  schema: JsonSchemaNode,
  values: Record<string, unknown>,
  path: string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const properties = schema.properties ?? {};
  const requiredFields = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(properties)) {
    const fieldPath = [...path, key];
    const errorKey = `/${fieldPath.join("/")}`;
    const value = values[key];
    const isRequired = requiredFields.has(key);
    const type = resolveType(propSchema);

    // Per-field validation
    const fieldErr = validateField(value, propSchema, isRequired);
    if (fieldErr) {
      errors[errorKey] = fieldErr;
    }

    // Recurse into objects
    if (type === "object" && propSchema.properties && typeof value === "object" && value !== null) {
      Object.assign(
        errors,
        validateJsonSchemaForm(propSchema, value as Record<string, unknown>, fieldPath),
      );
    }

    // Recurse into arrays
    if (type === "array" && propSchema.items && Array.isArray(value)) {
      const itemSchema = propSchema.items as JsonSchemaNode;
      const isObjectItem = resolveType(itemSchema) === "object";

      value.forEach((item, index) => {
        const itemPath = [...fieldPath, String(index)];
        const itemErrorKey = `/${itemPath.join("/")}`;

        if (isObjectItem) {
          Object.assign(
            errors,
            validateJsonSchemaForm(
              itemSchema,
              item as Record<string, unknown>,
              itemPath,
            ),
          );
        } else {
          const itemErr = validateField(item, itemSchema, false);
          if (itemErr) {
            errors[itemErrorKey] = itemErr;
          }
        }
      });
    }
  }

  return errors;
}

/** Public API for default values */
export function getDefaultValues(schema: JsonSchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = schema.properties ?? {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const def = getDefaultForSchema(propSchema);
    if (def !== undefined) {
      result[key] = def;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal Components
// ---------------------------------------------------------------------------

interface FieldWrapperProps {
  label: string;
  description?: string;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  children: React.ReactNode;
}

/**
 * Common wrapper for form fields that handles labels, descriptions, and error messages.
 */
const FieldWrapper = React.memo(({
  label,
  description,
  required,
  error,
  disabled,
  children,
}: FieldWrapperProps) => {
  return (
    <div className={cn("space-y-2", disabled && "opacity-60")}>
      <div className="flex items-center justify-between">
        {label && (
          <Label className="text-sm font-medium">
            {label}
            {required && <span className="ml-1 text-destructive">*</span>}
          </Label>
        )}
      </div>
      {children}
      {description && (
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          {description}
        </p>
      )}
      {error && (
        <p className="text-[12px] font-medium text-destructive">{error}</p>
      )}
    </div>
  );
});

FieldWrapper.displayName = "FieldWrapper";

interface FormFieldProps {
  propSchema: JsonSchemaNode;
  value: unknown;
  onChange: (val: unknown) => void;
  error?: string;
  disabled?: boolean;
  label: string;
  isRequired?: boolean;
  errors: Record<string, string>; // needed for recursion
  path: string; // needed for recursion error filtering
}

/**
 * Specialized field for boolean (checkbox) values.
 */
const BooleanField = React.memo(({
  id,
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
}: {
  id: string;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
}) => (
  <div className="flex items-start space-x-3 space-y-0">
    <Checkbox
      id={id}
      checked={!!value}
      onCheckedChange={onChange}
      disabled={disabled}
    />
    <div className="grid gap-1.5 leading-none">
      {label && (
        <Label
          htmlFor={id}
          className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
        >
          {label}
          {isRequired && <span className="ml-1 text-destructive">*</span>}
        </Label>
      )}
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {error && (
        <p className="text-xs font-medium text-destructive">{error}</p>
      )}
    </div>
  </div>
));

BooleanField.displayName = "BooleanField";

/**
 * Specialized field for enum (select) values.
 */
const EnumField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  options,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  options: unknown[];
}) => (
  <FieldWrapper
    label={label}
    description={description}
    required={isRequired}
    error={error}
    disabled={disabled}
  >
    <Select
      value={String(value ?? "")}
      onValueChange={onChange}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select an option" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={String(option)} value={String(option)}>
            {String(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </FieldWrapper>
));

EnumField.displayName = "EnumField";

// ---------------------------------------------------------------------------
// DynamicEnumField — dropdown populated at render time via a plugin action
// ---------------------------------------------------------------------------

interface DynamicEnumOption {
  value: string;
  label: string;
}

const DynamicEnumField = React.memo(({
  schema,
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
}: {
  schema: JsonSchemaNode;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
}) => {
  const ctx = React.useContext(FormRootContext);
  const pluginId = ctx?.pluginId;
  const optionsFrom = schema["x-paperclip-optionsFrom"] as
    | { actionKey: string }
    | undefined;

  const [options, setOptions] = useState<DynamicEnumOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!pluginId || !optionsFrom?.actionKey) return;
    setLoading(true);
    setFetchError(null);
    fetch(`/api/plugins/${pluginId}/actions/${optionsFrom.actionKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ params: {} }),
    })
      .then((res) => res.json())
      .then((json: { data?: { options?: unknown[] } }) => {
        const raw = json.data?.options ?? [];
        setOptions(
          raw.map((o) =>
            typeof o === "string"
              ? { value: o, label: o }
              : {
                  value: String((o as { value: unknown }).value ?? ""),
                  label: String(
                    (o as { label?: unknown }).label ??
                    (o as { value: unknown }).value ??
                    "",
                  ),
                },
          ),
        );
      })
      .catch((err: Error) => setFetchError(err.message))
      .finally(() => setLoading(false));
  }, [pluginId, optionsFrom?.actionKey]);

  // Fall back to text input when pluginId is unavailable or fetch failed with no options
  if (!pluginId || (fetchError && options.length === 0)) {
    return (
      <StringField
        value={value}
        onChange={onChange}
        disabled={disabled}
        label={label}
        isRequired={isRequired}
        description={fetchError ? `${description ?? ""} (Could not load options: ${fetchError})`.trim() : description}
        error={error}
      />
    );
  }

  return (
    <FieldWrapper label={label} description={description} required={isRequired} error={error} disabled={disabled}>
      <Select
        value={String(value ?? "")}
        onValueChange={onChange}
        disabled={disabled || loading}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={loading ? "Loading…" : "Select an option"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldWrapper>
  );
});

DynamicEnumField.displayName = "DynamicEnumField";

// ---------------------------------------------------------------------------
// SiblingEnumField — dropdown whose options come from a sibling array's items
// ---------------------------------------------------------------------------
//
// Common pattern across plugins: a "Default <thing> key" string field paired
// with a sibling array of { key, displayName, ... } items where the default
// must be one of the items' keys. Free-text inputs let operators typo a key
// that doesn't exist; this widget reads the live form values (via rootRef so
// it updates as the array is edited) and renders the keys as dropdown options.
//
// Schema shape:
//   "x-paperclip-optionsFromSibling": {
//     sibling: "workspaces",      // sibling key on the same parent object
//     valueKey: "key",            // item property used as the option value
//     labelKey: "displayName"     // optional; falls back to valueKey
//   }
//
// Empty/blank items (no value at valueKey) are filtered out. A "(no default)"
// sentinel option is always available so operators can opt out of a default
// without deleting the array. If the saved value isn't currently present in
// the sibling array (orphan from an item that got renamed/deleted), it shows
// up as a marked option so the operator can see and correct it.

interface OptionsFromSiblingConfig {
  sibling?: string;
  valueKey?: string;
  labelKey?: string;
}

const SIBLING_ENUM_NONE = "__none__";

const SiblingEnumField = React.memo(({
  schema,
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  fieldPath,
}: {
  schema: JsonSchemaNode;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  fieldPath: string;
}) => {
  const ctx = React.useContext(FormRootContext);
  const root = ctx?.rootRef.current ?? {};
  const cfg = (schema["x-paperclip-optionsFromSibling"] as OptionsFromSiblingConfig | undefined) ?? {};
  const valueKey = cfg.valueKey ?? "key";
  const labelKey = cfg.labelKey;

  // Resolve the parent of this field, then read the named sibling off it.
  const parts = fieldPath.split("/").filter(Boolean);
  parts.pop();
  const parentPath = parts.length > 0 ? "/" + parts.join("/") : "";
  const parent = readPath(root, parentPath);
  const siblingArr =
    cfg.sibling && parent && typeof parent === "object"
      ? (parent as Record<string, unknown>)[cfg.sibling]
      : undefined;

  const options: { value: string; label: string }[] = Array.isArray(siblingArr)
    ? siblingArr
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const obj = item as Record<string, unknown>;
          const v = obj[valueKey];
          if (typeof v !== "string" || v.trim().length === 0) return null;
          const labelRaw = labelKey ? obj[labelKey] : null;
          const labelText =
            typeof labelRaw === "string" && labelRaw.trim().length > 0
              ? `${labelRaw} (${v})`
              : v;
          return { value: v, label: labelText };
        })
        .filter((o): o is { value: string; label: string } => o !== null)
    : [];

  const stringValue = String(value ?? "");
  const matchInOptions = options.some((o) => o.value === stringValue);
  const showOrphan = stringValue.length > 0 && !matchInOptions;

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      <Select
        value={stringValue.length > 0 ? stringValue : SIBLING_ENUM_NONE}
        onValueChange={(v) => onChange(v === SIBLING_ENUM_NONE ? "" : v)}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue
            placeholder={
              options.length === 0
                ? "Add an entry below to populate"
                : "Select…"
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SIBLING_ENUM_NONE}>
            — None (require explicit per call) —
          </SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          {showOrphan ? (
            <SelectItem value={stringValue}>
              {stringValue} (no longer in list)
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </FieldWrapper>
  );
});

SiblingEnumField.displayName = "SiblingEnumField";

/**
 * Specialized field for secret-ref values.
 *
 * Renders a "Pick from your secrets" dropdown when the form provides a secrets
 * list (the common case for plugin settings pages — the page fetches its
 * company's secrets and passes them to JsonSchemaForm). The dropdown shows the
 * secret's human-readable name; the stored value is always the secret's UUID.
 *
 * The manual text input below the dropdown stays available so operators can:
 * - paste a UUID directly (legacy / cross-company use case)
 * - reference a secret that doesn't appear in the list yet
 *
 * When no secrets list is available (legacy callers), only the text input
 * renders, preserving backwards compatibility.
 */
const SecretField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  defaultValue,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  defaultValue?: unknown;
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const ctx = React.useContext(FormRootContext);
  const secrets = ctx?.secrets;
  const stringValue = String(value ?? "");
  const matchedSecret = useMemo(
    () => secrets?.find((s) => s.id === stringValue) ?? null,
    [secrets, stringValue],
  );

  return (
    <FieldWrapper
      label={label}
      description={
        description ||
        "This secret is stored securely via the Paperclip secret provider."
      }
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      <div className="space-y-1.5">
        {secrets && secrets.length > 0 ? (
          <Select
            value={matchedSecret ? matchedSecret.id : stringValue ? "__custom__" : ""}
            onValueChange={(v) => {
              if (v === "__custom__") return; // operator wants to type a UUID; leave value as-is
              onChange(v);
            }}
            disabled={disabled}
          >
            <SelectTrigger aria-invalid={!!error}>
              <SelectValue placeholder="Pick from your secrets…" />
            </SelectTrigger>
            <SelectContent>
              {secrets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {stringValue && !matchedSecret ? (
                <SelectItem value="__custom__">
                  (custom UUID below)
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        ) : null}
        <div className="relative">
          <Input
            type={isVisible ? "text" : "password"}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              secrets && secrets.length > 0
                ? "…or paste a secret UUID"
                : String(defaultValue ?? "")
            }
            disabled={disabled}
            className="pr-10"
            aria-invalid={!!error}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
            onClick={() => setIsVisible(!isVisible)}
            disabled={disabled}
          >
            {isVisible ? (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Eye className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="sr-only">
              {isVisible ? "Hide secret" : "Show secret"}
            </span>
          </Button>
        </div>
        {matchedSecret ? (
          <p className="text-[11px] text-muted-foreground/70">
            Using <span className="font-mono">{matchedSecret.name}</span>
          </p>
        ) : null}
      </div>
    </FieldWrapper>
  );
});

SecretField.displayName = "SecretField";

/**
 * Specialized field for numeric (number/integer) values.
 */
const NumberField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  defaultValue,
  type,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  defaultValue?: unknown;
  type: "number" | "integer";
}) => (
  <FieldWrapper
    label={label}
    description={description}
    required={isRequired}
    error={error}
    disabled={disabled}
  >
    <Input
      type="number"
      step={type === "integer" ? "1" : "any"}
      value={value !== undefined ? String(value) : ""}
      onChange={(e) => {
        const val = e.target.value;
        onChange(val === "" ? undefined : Number(val));
      }}
      placeholder={String(defaultValue ?? "")}
      disabled={disabled}
      aria-invalid={!!error}
    />
  </FieldWrapper>
));

NumberField.displayName = "NumberField";

/**
 * Specialized field for string values, rendering either an Input or Textarea based on length or format.
 */
const StringField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  defaultValue,
  format,
  maxLength,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  defaultValue?: unknown;
  format?: string;
  maxLength?: number;
}) => {
  const isTextArea = format === "textarea" || (maxLength && maxLength > TEXTAREA_THRESHOLD);
  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      {isTextArea ? (
        <Textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={String(defaultValue ?? "")}
          disabled={disabled}
          className="min-h-[100px]"
          aria-invalid={!!error}
        />
      ) : (
        <Input
          type="text"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={String(defaultValue ?? "")}
          disabled={disabled}
          aria-invalid={!!error}
        />
      )}
    </FieldWrapper>
  );
});

StringField.displayName = "StringField";

// ---------------------------------------------------------------------------
// Form-root context
// ---------------------------------------------------------------------------
// Some scalar fields (project-id, agent-id) need to read sibling values from
// elsewhere in the form — e.g. a project dropdown filters its options by the
// company UUID stored at /mailboxes/<idx>/ingestCompanyId. The outer
// JsonSchemaForm publishes the root values via context so any nested field
// can resolve them via JSON-pointer-ish paths.

interface FormRootContextValue {
  /** Reference to the latest root values; mutated by the outer form on each render. */
  rootRef: React.MutableRefObject<Record<string, unknown>>;
  /** UUID of the owning plugin, used by action buttons. */
  pluginId?: string;
  /** Operator's secrets — used by SecretField to render a name-picker dropdown. */
  secrets?: CompanySecret[];
}
const FormRootContext = React.createContext<FormRootContextValue | null>(null);

function readPath(root: unknown, path: string): unknown {
  if (!path) return root;
  const parts = path.split("/").filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Walk the form path upwards looking for a sibling key on any ancestor. Used
 * by project/agent dropdowns to find the relevant `ingestCompanyId`. Returns
 * the value as a string if found and string-typed, otherwise null.
 */
function findAncestorString(
  root: unknown,
  fieldPath: string,
  candidateKeys: string[],
): string | null {
  const parts = fieldPath.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const ancestorPath = "/" + parts.slice(0, i).join("/");
    const ancestor = readPath(root, ancestorPath);
    if (ancestor && typeof ancestor === "object") {
      for (const key of candidateKeys) {
        const v = (ancestor as Record<string, unknown>)[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
    }
  }
  return null;
}

// Module-scoped companies cache so every CompanyMultiSelectField on a page
// shares one fetch instead of calling /api/companies once per field.
let companiesCache: Company[] | null = null;
let companiesPromise: Promise<Company[]> | null = null;
function loadCompaniesOnce(): Promise<Company[]> {
  if (companiesCache) return Promise.resolve(companiesCache);
  if (!companiesPromise) {
    companiesPromise = companiesApi
      .list()
      .then((rows) => {
        companiesCache = rows;
        return rows;
      })
      .catch((err) => {
        companiesPromise = null;
        throw err;
      });
  }
  return companiesPromise;
}

/**
 * Multi-select picker for an array of company UUIDs. Triggered when the
 * schema declares `items.format = "company-id"`. Renders a "Portfolio-wide"
 * checkbox plus one checkbox per company. Stores `["*"]` for portfolio-wide
 * or specific UUIDs otherwise.
 */
export const CompanyMultiSelectField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  description,
  error,
  isRequired,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  description?: string;
  error?: string;
  isRequired?: boolean;
}) => {
  const selected: string[] = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  const allSelected = selected.includes("*");
  const [companies, setCompanies] = useState<Company[] | null>(companiesCache);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (companies) return;
    let cancelled = false;
    loadCompaniesOnce()
      .then((rows) => {
        if (!cancelled) setCompanies(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [companies]);

  const togglePortfolio = (checked: boolean) => {
    onChange(checked ? ["*"] : []);
  };

  const toggleCompany = (companyId: string, checked: boolean) => {
    const next = new Set(selected.filter((s) => s !== "*"));
    if (checked) next.add(companyId);
    else next.delete(companyId);
    onChange(Array.from(next));
  };

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center space-x-2">
          <Checkbox
            id="company-multiselect-all"
            checked={allSelected}
            onCheckedChange={(c) => togglePortfolio(c === true)}
            disabled={disabled}
          />
          <Label
            htmlFor="company-multiselect-all"
            className="cursor-pointer text-sm font-medium"
          >
            Portfolio-wide (every company)
          </Label>
        </div>
        <div className="border-t pt-2">
          {loadError ? (
            <p className="text-xs text-destructive">
              Failed to load companies: {loadError}
            </p>
          ) : !companies ? (
            <p className="text-xs text-muted-foreground">Loading companies…</p>
          ) : companies.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No companies configured yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              {companies
                .filter((c) => c.status !== "archived" || selected.includes(c.id))
                .map((c) => {
                  const checked = allSelected || selected.includes(c.id);
                  const isArchived = c.status === "archived";
                  return (
                    <div key={c.id} className="flex items-center space-x-2">
                      <Checkbox
                        id={`company-${c.id}`}
                        checked={checked}
                        onCheckedChange={(v) => toggleCompany(c.id, v === true)}
                        disabled={disabled || allSelected}
                      />
                      <Label
                        htmlFor={`company-${c.id}`}
                        className={cn(
                          "cursor-pointer text-sm",
                          (allSelected || isArchived) && "text-muted-foreground",
                        )}
                      >
                        {c.name}
                        {isArchived && (
                          <span className="ml-1.5 text-xs">(archived)</span>
                        )}
                      </Label>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </FieldWrapper>
  );
});

CompanyMultiSelectField.displayName = "CompanyMultiSelectField";

// ---------------------------------------------------------------------------
// Per-item action buttons (x-paperclip-actions)
// ---------------------------------------------------------------------------

interface ItemActionResultCheck {
  name: string;
  passed: boolean;
  message: string;
  durationMs?: number;
}
interface ItemActionResult {
  ok: boolean;
  checks?: ItemActionResultCheck[];
  message?: string;
  [key: string]: unknown;
}

const ItemActionsRow = React.memo(({
  itemSchema,
  item,
  disabled,
}: {
  itemSchema: JsonSchemaNode;
  item: unknown;
  disabled: boolean;
}) => {
  const ctx = React.useContext(FormRootContext);
  const pluginId = ctx?.pluginId;
  const actions = (itemSchema as JsonSchemaNode)["x-paperclip-actions"] as
    | PaperclipActionDecl[]
    | undefined;
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ actionKey: string; result: ItemActionResult } | null>(null);

  if (!Array.isArray(actions) || actions.length === 0) return null;

  const runAction = async (action: PaperclipActionDecl) => {
    if (!pluginId) {
      setResult({
        actionKey: action.actionKey,
        result: { ok: false, message: "pluginId not available" },
      });
      return;
    }
    setPending(action.actionKey);
    setResult(null);
    try {
      const params: Record<string, unknown> = {};
      if (action.paramName && action.itemKey && item && typeof item === "object") {
        params[action.paramName] = (item as Record<string, unknown>)[action.itemKey];
      }
      const res = await fetch(`/api/plugins/${pluginId}/actions/${action.actionKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ params }),
      });
      const json = (await res.json()) as { data?: ItemActionResult; message?: string; error?: string };
      if (!res.ok) {
        setResult({
          actionKey: action.actionKey,
          result: { ok: false, message: json.error ?? json.message ?? `HTTP ${res.status}` },
        });
        return;
      }
      const data = json.data ?? (json as unknown as ItemActionResult);
      setResult({ actionKey: action.actionKey, result: data });
    } catch (err) {
      setResult({
        actionKey: action.actionKey,
        result: { ok: false, message: (err as Error).message },
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        {actions.map((action) => (
          <Button
            key={action.actionKey}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || pending !== null || !pluginId}
            onClick={() => runAction(action)}
            title={action.description}
          >
            {pending === action.actionKey ? "Testing…" : action.label}
          </Button>
        ))}
      </div>
      {result && (
        <div
          className={cn(
            "w-full rounded-md border p-2 text-xs",
            result.result.ok
              ? "border-green-700 bg-green-950/30 text-green-200"
              : "border-destructive bg-destructive/10 text-destructive",
          )}
        >
          <div className="font-medium">
            {result.result.ok ? "Passed" : "Failed"}
            {result.result.message ? ` — ${result.result.message}` : ""}
          </div>
          {Array.isArray(result.result.checks) && result.result.checks.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {result.result.checks.map((c, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className={c.passed ? "text-green-400" : "text-destructive"}>
                    {c.passed ? "✓" : "✗"}
                  </span>
                  <span className="font-mono text-[0.7rem] opacity-70">{c.name}</span>
                  <span>— {c.message}</span>
                  {c.durationMs !== undefined && (
                    <span className="opacity-50">({c.durationMs}ms)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
ItemActionsRow.displayName = "ItemActionsRow";

// ---------------------------------------------------------------------------
// Scalar entity-id dropdowns (company-id / project-id / agent-id)
// ---------------------------------------------------------------------------

/**
 * Single-company picker. Triggered by `format: "company-id"` on a scalar
 * string field. Stores the selected company UUID.
 */
const CompanyIdField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  description,
  error,
  isRequired,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  description?: string;
  error?: string;
  isRequired?: boolean;
}) => {
  const [companies, setCompanies] = useState<Company[] | null>(companiesCache);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (companies) return;
    let cancelled = false;
    loadCompaniesOnce()
      .then((rows) => {
        if (!cancelled) setCompanies(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [companies]);

  const current = typeof value === "string" ? value : "";

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      {loadError ? (
        <p className="text-xs text-destructive">Failed to load companies: {loadError}</p>
      ) : !companies ? (
        <p className="text-xs text-muted-foreground">Loading companies…</p>
      ) : (
        <Select value={current} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder="Select a company…" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldWrapper>
  );
});
CompanyIdField.displayName = "CompanyIdField";

// Cache projects & agents per company so multiple dropdowns on one page share a fetch.
const projectsByCompany = new Map<string, { rows?: Project[]; promise?: Promise<Project[]> }>();
function loadProjectsOnce(companyId: string): Promise<Project[]> {
  let entry = projectsByCompany.get(companyId);
  if (entry?.rows) return Promise.resolve(entry.rows);
  if (!entry) {
    entry = {};
    projectsByCompany.set(companyId, entry);
  }
  if (!entry.promise) {
    entry.promise = projectsApi
      .list(companyId)
      .then((rows) => {
        const e = projectsByCompany.get(companyId);
        if (e) e.rows = rows;
        return rows;
      })
      .catch((err) => {
        projectsByCompany.delete(companyId);
        throw err;
      });
  }
  return entry.promise;
}

const agentsByCompany = new Map<string, { rows?: Agent[]; promise?: Promise<Agent[]> }>();
function loadAgentsOnce(companyId: string): Promise<Agent[]> {
  let entry = agentsByCompany.get(companyId);
  if (entry?.rows) return Promise.resolve(entry.rows);
  if (!entry) {
    entry = {};
    agentsByCompany.set(companyId, entry);
  }
  if (!entry.promise) {
    entry.promise = agentsApi
      .list(companyId)
      .then((rows) => {
        const e = agentsByCompany.get(companyId);
        if (e) e.rows = rows;
        return rows;
      })
      .catch((err) => {
        agentsByCompany.delete(companyId);
        throw err;
      });
  }
  return entry.promise;
}

/**
 * Project picker scoped by an ancestor company UUID. Triggered by
 * `format: "project-id"`. Looks up `ingestCompanyId` (or `companyId`) on any
 * form ancestor; if none is set, the dropdown is disabled with guidance.
 */
const ProjectIdField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  description,
  error,
  isRequired,
  fieldPath,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  description?: string;
  error?: string;
  isRequired?: boolean;
  fieldPath: string;
}) => {
  const ctx = React.useContext(FormRootContext);
  const root = ctx?.rootRef.current ?? {};
  const companyId = findAncestorString(root, fieldPath, ["ingestCompanyId", "companyId"]);
  const [projects, setProjects] = useState<Project[] | null>(
    companyId ? (projectsByCompany.get(companyId)?.rows ?? null) : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    if (!companyId) {
      setProjects(null);
      return;
    }
    const cached = projectsByCompany.get(companyId)?.rows;
    if (cached) {
      setProjects(cached);
      return;
    }
    let cancelled = false;
    loadProjectsOnce(companyId)
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const current = typeof value === "string" ? value : "";

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      {!companyId ? (
        <p className="text-xs text-muted-foreground">Select an ingest company first.</p>
      ) : loadError ? (
        <p className="text-xs text-destructive">Failed to load projects: {loadError}</p>
      ) : !projects ? (
        <p className="text-xs text-muted-foreground">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">This company has no projects yet.</p>
      ) : (
        <Select value={current} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder="Select a project…" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldWrapper>
  );
});
ProjectIdField.displayName = "ProjectIdField";

/**
 * Agent picker scoped by an ancestor company UUID. Triggered by
 * `format: "agent-id"`. Same lookup pattern as ProjectIdField.
 */
const AgentIdField = React.memo(({
  value,
  onChange,
  disabled,
  label,
  description,
  error,
  isRequired,
  fieldPath,
}: {
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  description?: string;
  error?: string;
  isRequired?: boolean;
  fieldPath: string;
}) => {
  const ctx = React.useContext(FormRootContext);
  const root = ctx?.rootRef.current ?? {};
  const companyId = findAncestorString(root, fieldPath, ["ingestCompanyId", "companyId"]);
  const [agents, setAgents] = useState<Agent[] | null>(
    companyId ? (agentsByCompany.get(companyId)?.rows ?? null) : null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    if (!companyId) {
      setAgents(null);
      return;
    }
    const cached = agentsByCompany.get(companyId)?.rows;
    if (cached) {
      setAgents(cached);
      return;
    }
    let cancelled = false;
    loadAgentsOnce(companyId)
      .then((rows) => {
        if (!cancelled) setAgents(rows);
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const current = typeof value === "string" ? value : "";

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      {!companyId ? (
        <p className="text-xs text-muted-foreground">Select an ingest company first.</p>
      ) : loadError ? (
        <p className="text-xs text-destructive">Failed to load agents: {loadError}</p>
      ) : !agents ? (
        <p className="text-xs text-muted-foreground">Loading agents…</p>
      ) : agents.length === 0 ? (
        <p className="text-xs text-muted-foreground">This company has no agents yet.</p>
      ) : (
        <Select value={current} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder="Select an agent…" />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name ?? a.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FieldWrapper>
  );
});
AgentIdField.displayName = "AgentIdField";

/**
 * Specialized field for array values, handling dynamic addition and removal of items.
 */
const ArrayField = React.memo(({
  propSchema,
  value,
  onChange,
  error,
  disabled,
  label,
  errors,
  path,
}: {
  propSchema: JsonSchemaNode;
  value: unknown;
  onChange: (val: unknown) => void;
  error?: string;
  disabled: boolean;
  label: string;
  errors: Record<string, string>;
  path: string;
}) => {
  const items = Array.isArray(value) ? value : [];
  const itemSchema = propSchema.items as JsonSchemaNode;
  const isComplex = resolveType(itemSchema) === "object";

  // Custom widget: array of company UUIDs → multi-select with company names.
  if (itemSchema.format === "company-id") {
    return (
      <CompanyMultiSelectField
        value={value}
        onChange={onChange}
        disabled={disabled}
        label={label}
        description={propSchema.description}
        error={error}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">{label}</Label>
          {propSchema.description && (
            <p className="text-xs text-muted-foreground">
              {propSchema.description}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            disabled ||
            (propSchema.maxItems !== undefined &&
              items.length >= (propSchema.maxItems as number))
          }
          onClick={() => {
            const newItem = getDefaultForSchema(itemSchema);
            onChange([...items, newItem]);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          {isComplex ? "Add item" : "Add"}
        </Button>
      </div>

      <div className="space-y-3">
        {items.map((item, index) => (
          <div
            key={index}
            className="group relative flex items-start space-x-2 rounded-lg border p-3"
          >
            <div className="flex-1">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-foreground">
                  {itemHeading(item, index)}
                </div>
                <ItemActionsRow itemSchema={itemSchema} item={item} disabled={disabled} />
              </div>
              <FormField
                propSchema={itemSchema}
                value={item}
                label=""
                path={`${path}/${index}`}
                onChange={(newVal) => {
                  const newItems = [...items];
                  newItems[index] = newVal;
                  onChange(newItems);
                }}
                disabled={disabled}
                errors={errors}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              disabled={
                disabled ||
                (propSchema.minItems !== undefined &&
                  items.length <= (propSchema.minItems as number))
              }
              onClick={() => {
                const newItems = [...items];
                newItems.splice(index, 1);
                onChange(newItems);
              }}
            >
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">Remove item</span>
            </Button>
          </div>
        ))}
        {items.length === 0 && (
          <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            No items added yet.
          </div>
        )}
      </div>
      {error && (
        <p className="text-xs font-medium text-destructive">{error}</p>
      )}
    </div>
  );
});

ArrayField.displayName = "ArrayField";

/**
 * Specialized field for object values, handling recursive rendering of nested properties.
 */
const ObjectField = React.memo(({
  propSchema,
  value,
  onChange,
  disabled,
  label,
  errors,
  path,
}: {
  propSchema: JsonSchemaNode;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  errors: Record<string, string>;
  path: string;
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const handleObjectChange = (newVal: Record<string, unknown>) => {
    onChange(newVal);
  };

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="text-left">
          <Label className="cursor-pointer text-sm font-semibold">
            {label}
          </Label>
          {propSchema.description && (
            <p className="text-xs text-muted-foreground">
              {propSchema.description}
            </p>
          )}
        </div>
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {!isCollapsed && (
        <div className="pt-2">
          <JsonSchemaForm
            schema={propSchema}
            values={(value as Record<string, unknown>) ?? {}}
            onChange={handleObjectChange}
            disabled={disabled}
            pathPrefix={path}
            errors={Object.fromEntries(
              Object.entries(errors)
                .filter(([errPath]) => errPath.startsWith(`${path}/`))
                .map(([errPath, err]) => [errPath.replace(path, ""), err]),
            )}
          />
        </div>
      )}
    </div>
  );
});

ObjectField.displayName = "ObjectField";

/**
 * Orchestrator component that selects and renders the appropriate field type based on the schema node.
 */
const FormField = React.memo(({
  propSchema,
  value,
  onChange,
  error,
  disabled,
  label,
  isRequired,
  errors,
  path,
}: FormFieldProps) => {
  const type = resolveType(propSchema);
  const isReadOnly = disabled || propSchema.readOnly === true;

  switch (type) {
    case "boolean":
      return (
        <BooleanField
          id={path}
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
        />
      );

    case "dynamic-enum":
      return (
        <DynamicEnumField
          schema={propSchema}
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
        />
      );

    case "sibling-enum":
      return (
        <SiblingEnumField
          schema={propSchema}
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          fieldPath={path}
        />
      );

    case "enum":
      return (
        <EnumField
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          options={propSchema.enum ?? []}
        />
      );

    case "secret-ref":
      return (
        <SecretField
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          defaultValue={propSchema.default}
        />
      );

    case "number":
    case "integer":
      return (
        <NumberField
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          defaultValue={propSchema.default}
          type={type as "number" | "integer"}
        />
      );

    case "array":
      return (
        <ArrayField
          propSchema={propSchema}
          value={value}
          onChange={onChange}
          error={error}
          disabled={isReadOnly}
          label={label}
          errors={errors}
          path={path}
        />
      );

    case "object":
      return (
        <ObjectField
          propSchema={propSchema}
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          errors={errors}
          path={path}
        />
      );

    default: {
      // string — check format hints first
      if (propSchema.format === "company-id") {
        return (
          <CompanyIdField
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
          />
        );
      }
      if (propSchema.format === "project-id") {
        return (
          <ProjectIdField
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            fieldPath={path}
          />
        );
      }
      if (propSchema.format === "agent-id") {
        return (
          <AgentIdField
            value={value}
            onChange={onChange}
            disabled={isReadOnly}
            label={label}
            isRequired={isRequired}
            description={propSchema.description}
            error={error}
            fieldPath={path}
          />
        );
      }
      return (
        <StringField
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          defaultValue={propSchema.default}
          format={propSchema.format}
          maxLength={propSchema.maxLength}
        />
      );
    }
  }
});

FormField.displayName = "FormField";

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Main JsonSchemaForm component.
 * Renders a form based on a subset of JSON Schema specification.
 * Supports primitive types, enums, secrets, objects, and arrays with recursion.
 */
export function JsonSchemaForm(props: JsonSchemaFormProps) {
  const existingCtx = React.useContext(FormRootContext);
  const rootRef = React.useRef<Record<string, unknown>>(props.values);
  rootRef.current = props.values;

  // Outer call: install the context so nested fields can resolve siblings.
  // Nested recursions (via ObjectField) inherit the existing provider so the
  // root reference stays anchored to the top-level form values.
  if (!existingCtx) {
    return (
      <FormRootContext.Provider value={{ rootRef, pluginId: props.pluginId, secrets: props.secrets }}>
        <JsonSchemaFormInner {...props} />
      </FormRootContext.Provider>
    );
  }
  return <JsonSchemaFormInner {...props} />;
}

function JsonSchemaFormInner({
  schema,
  values,
  onChange,
  errors = {},
  disabled,
  className,
  pathPrefix = "",
}: JsonSchemaFormProps) {
  const type = resolveType(schema);

  const handleRootScalarChange = useCallback((newVal: unknown) => {
    // If root is a scalar, values IS the value
    onChange(newVal as Record<string, unknown>);
  }, [onChange]);

  // If it's a scalar at root, render a single FormField
  if (type !== "object") {
    return (
      <div className={className}>
        <FormField
          propSchema={schema}
          value={values}
          label=""
          path=""
          onChange={handleRootScalarChange}
          disabled={disabled}
          errors={errors}
        />
      </div>
    );
  }

  // Memoize to avoid re-renders when parent provides new object references
  const properties = useMemo(() => schema.properties ?? {}, [schema.properties]);
  const requiredFields = useMemo(
    () => new Set(schema.required ?? []),
    [schema.required],
  );
  // Honor `propertyOrder` (a widely-used JSON Schema extension) for explicit
  // field order. Fields listed there render first; any remaining keys follow
  // in the object's iteration order.
  const orderedKeys = useMemo(() => {
    const all = Object.keys(properties);
    const order = Array.isArray(schema.propertyOrder) ? schema.propertyOrder : null;
    if (!order) return all;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of order) {
      if (key in properties && !seen.has(key)) {
        out.push(key);
        seen.add(key);
      }
    }
    for (const key of all) {
      if (!seen.has(key)) out.push(key);
    }
    return out;
  }, [properties, schema.propertyOrder]);

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...values, [key]: value });
    },
    [onChange, values],
  );

  if (Object.keys(properties).length === 0) {
    return (
      <div
        className={cn(
          "py-4 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        No configuration options available.
      </div>
    );
  }

  return (
    <div className={cn("space-y-6", className)}>
      {orderedKeys.map((key) => {
        const propSchema = properties[key];
        // Conditional visibility: a field can declare an
        // `x-paperclip-showWhen` map of sibling-key → expected value (or
        // array of accepted values). When the parent's values don't match,
        // the field is omitted from rendering entirely.
        const showWhen = (propSchema as JsonSchemaNode)["x-paperclip-showWhen"] as
          | Record<string, unknown>
          | undefined;
        if (showWhen && typeof showWhen === "object") {
          const mismatch = Object.entries(showWhen).some(([siblingKey, expected]) => {
            const actual = values[siblingKey];
            if (Array.isArray(expected)) return !expected.includes(actual);
            return actual !== expected;
          });
          if (mismatch) return null;
        }

        const value = values[key];
        const isRequired = requiredFields.has(key);
        const localPath = `/${key}`;
        const fullPath = `${pathPrefix}${localPath}`;
        const error = errors[localPath];
        const label = labelFromKey(key, propSchema);

        return (
          <FormField
            key={key}
            propSchema={propSchema}
            value={value}
            onChange={(val) => handleFieldChange(key, val)}
            error={error}
            disabled={disabled}
            label={label}
            isRequired={isRequired}
            errors={errors}
            path={fullPath}
          />
        );
      })}
    </div>
  );
}
