import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  Trash2,
} from "lucide-react";
import { isUuidLike, type EnvSecretRefBinding } from "@paperclipai/shared";
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
import { SecretBindingPicker, type SecretBindingValue } from "./SecretBindingPicker";

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
  examples?: unknown[];
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

  // Array
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;

  // Metadata
  readOnly?: boolean;
  writeOnly?: boolean;

  // Paperclip extensions
  /**
   * When true, the field is hidden behind an "Advanced options" disclosure
   * in the top-level `JsonSchemaForm`. Defaults to false (essential).
   */
  "x-paperclip-advanced"?: boolean;
  /**
   * Optional sub-section name used to group advanced fields under headings
   * inside the disclosure (e.g. "SSH access", "VM resources"). Ignored when
   * `x-paperclip-advanced` is not true.
   */
  "x-paperclip-group"?: string;

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
  /** Label for the disclosure that hides advanced fields. Defaults to "Advanced options". */
  advancedLabel?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the primary type string from a schema node. */
export function resolveType(schema: JsonSchemaNode): string {
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
 * Produce a sensible default value for a schema node.
 *
 * Optional scalar fields (string, number, integer, secret-ref) without an
 * explicit `default` return `undefined` so they stay out of the submitted
 * payload — otherwise an empty field would round-trip as `""` or `0` and
 * trip server-side "X must be greater than 0 when provided" style validators.
 */
export function getDefaultForSchema(schema: JsonSchemaNode): unknown {
  if (schema.default !== undefined) return schema.default;

  const type = resolveType(schema);
  switch (type) {
    case "string":
    case "secret-ref":
    case "number":
    case "integer":
      return undefined;
    case "boolean":
      return false;
    case "enum":
      return undefined;
    case "array":
      return [];
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const def = getDefaultForSchema(propSchema);
        if (def !== undefined) obj[key] = def;
      }
      return obj;
    }
    default:
      return undefined;
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

  if (type === "secret-ref" && isSecretRefBinding(value)) {
    return null;
  }
  if (type === "secret-ref" && typeof value === "object") {
    return "Invalid secret reference";
  }

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
        <p className="text-xs text-muted-foreground leading-relaxed">
          {description}
        </p>
      )}
      {error && (
        <p className="text-xs font-medium text-destructive">{error}</p>
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
 * Sentinel value for the "not configured" row of an optional enum select.
 * Radix `Select` forbids an empty-string item value, so we map the unset state
 * onto this sentinel and translate it back to `undefined` on change.
 */
const ENUM_UNSET_VALUE = "__paperclip_unset__";

function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

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
}) => {
  // Optional enums get a leading blank row so the user can express "not
  // configured"; it is also the selected row when no value is set.
  const showUnsetOption = !isRequired;
  // When every option is numeric, coerce the selected string back to a number
  // so the payload keeps the schema's integer/number type — a stringified "2"
  // would otherwise fail server-side integer validation.
  const numericOptions =
    options.length > 0 && options.every((option) => typeof option === "number");

  const isUnset = value === undefined || value === null || value === "";
  const selectValue = isUnset
    ? showUnsetOption
      ? ENUM_UNSET_VALUE
      : ""
    : String(value);

  const handleChange = (next: string) => {
    if (next === ENUM_UNSET_VALUE) {
      onChange(undefined);
      return;
    }
    onChange(numericOptions ? Number(next) : next);
  };

  return (
    <FieldWrapper
      label={label}
      description={description}
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      <Select
        value={selectValue}
        onValueChange={handleChange}
        disabled={disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          {showUnsetOption && (
            <SelectItem value={ENUM_UNSET_VALUE} textValue="None">
              <span className="text-muted-foreground">None</span>
            </SelectItem>
          )}
          {options.map((option) => (
            <SelectItem key={String(option)} value={String(option)}>
              {String(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldWrapper>
  );
});

EnumField.displayName = "EnumField";

/**
 * Specialized field for secret-ref values. Renders a picker for existing
 * company secrets plus a raw-value fallback. A UUID-shaped value is treated
 * as a bound secret reference; anything else is a raw value that the server
 * converts to a stored secret on save.
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
  maxLength?: number;
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const isTextArea = maxLength != null && maxLength > TEXTAREA_THRESHOLD;

  const secretRefValue = isSecretRefBinding(value) ? value : null;
  const stringValue = typeof value === "string" ? value : "";
  const trimmed = stringValue.trim();
  const legacySecretId = trimmed.length > 0 && isUuidLike(trimmed) ? trimmed : null;
  const isBoundToSecret = secretRefValue !== null || legacySecretId !== null;
  const hasRawValue = stringValue.length > 0 && !isBoundToSecret;

  const [showRawInput, setShowRawInput] = useState(hasRawValue);

  // Keep the raw-input panel open when the parent loads a raw value after
  // mount (e.g. an environment-config form rendering with empty defaults
  // before its API response arrives). We only promote to `true` here; manual
  // toggles off are still preserved as long as `hasRawValue` is false.
  useEffect(() => {
    if (hasRawValue) setShowRawInput(true);
  }, [hasRawValue]);

  const bindingValue: SecretBindingValue | null = secretRefValue
    ? { secretId: secretRefValue.secretId, version: secretRefValue.version }
    : legacySecretId
      ? { secretId: legacySecretId }
      : null;

  const handlePickerChange = useCallback(
    (next: SecretBindingValue | null) => {
      if (next) {
        onChange({
          type: "secret_ref",
          secretId: next.secretId,
          version: next.version ?? "latest",
        });
        setShowRawInput(false);
        setIsVisible(false);
      } else {
        onChange("");
      }
    },
    [onChange],
  );

  const rawInput = isTextArea ? (
    <div className="relative">
      {isVisible ? (
        <Textarea
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={String(defaultValue ?? "")}
          disabled={disabled}
          className="min-h-(--sz-140px) pr-10 font-mono text-xs"
          aria-invalid={!!error}
        />
      ) : (
        <Textarea
          // Render a placeholder summary instead of the secret content while
          // hidden. This avoids exposing multi-line secrets (e.g. SSH
          // private keys) on screen-shares; clicking the eye toggle reveals
          // the editable textarea above.
          value={
            stringValue.length === 0
              ? ""
              : `Sensitive — ${stringValue.length} characters hidden. Click the eye to reveal.`
          }
          readOnly
          placeholder={String(defaultValue ?? "")}
          disabled={disabled}
          className="min-h-(--sz-140px) pr-10 font-mono text-xs italic text-muted-foreground"
          aria-invalid={!!error}
        />
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="absolute right-0 top-0 px-3 py-2 hover:bg-transparent"
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
  ) : (
    <div className="relative">
      <Input
        type={isVisible ? "text" : "password"}
        value={stringValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={String(defaultValue ?? "")}
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
  );

  return (
    <FieldWrapper
      label={label}
      description={
        description ||
        "Pick an existing company secret, or paste a raw value (Paperclip will store it as a secret on save)."
      }
      required={isRequired}
      error={error}
      disabled={disabled}
    >
      <div className="space-y-2">
        <SecretBindingPicker
          value={bindingValue}
          onChange={handlePickerChange}
          label=""
          placeholder="Select an existing secret"
          allowVersionSelector={false}
          emptyHint="No active secrets yet. Create one or paste a raw value below."
          disabled={disabled}
        />
        {!isBoundToSecret ? (
          showRawInput ? (
            <div className="space-y-1">
              {rawInput}
              {!hasRawValue ? (
                <button
                  type="button"
                  className="text-(length:--text-micro) text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setShowRawInput(false);
                    setIsVisible(false);
                  }}
                  disabled={disabled}
                >
                  Hide raw value input
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className="text-(length:--text-micro) text-muted-foreground hover:text-foreground"
              onClick={() => setShowRawInput(true)}
              disabled={disabled}
            >
              Or paste a raw value
            </button>
          )
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
  id,
  value,
  onChange,
  disabled,
  label,
  isRequired,
  description,
  error,
  defaultValue,
  type,
  minimum,
  maximum,
  suggestions,
}: {
  id: string;
  value: unknown;
  onChange: (val: unknown) => void;
  disabled: boolean;
  label: string;
  isRequired?: boolean;
  description?: string;
  error?: string;
  defaultValue?: unknown;
  type: "number" | "integer";
  minimum?: number;
  maximum?: number;
  suggestions?: unknown[];
}) => {
  const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
  // Sanitize the path-based id so it is a valid CSS/HTML identifier (paths can contain "/").
  const listId = hasSuggestions ? `${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-suggestions` : undefined;
  return (
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
        min={minimum}
        max={maximum}
        list={listId}
        value={value !== undefined ? String(value) : ""}
        onChange={(e) => {
          const val = e.target.value;
          const trimmed = val.trim();
          onChange(trimmed === "" ? undefined : Number(trimmed));
        }}
        placeholder={String(defaultValue ?? "")}
        disabled={disabled}
        aria-invalid={!!error}
      />
      {listId ? (
        <datalist id={listId}>
          {suggestions!.map((suggestion) => (
            <option key={String(suggestion)} value={String(suggestion)} />
          ))}
        </datalist>
      ) : null}
    </FieldWrapper>
  );
});

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
          className="min-h-(--sz-100px)"
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
              <div className="mb-2 text-xs font-medium text-muted-foreground">
                Item {index + 1}
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
          maxLength={typeof propSchema.maxLength === "number" ? propSchema.maxLength : undefined}
        />
      );

    case "number":
    case "integer":
      return (
        <NumberField
          id={path}
          value={value}
          onChange={onChange}
          disabled={isReadOnly}
          label={label}
          isRequired={isRequired}
          description={propSchema.description}
          error={error}
          defaultValue={propSchema.default}
          type={type as "number" | "integer"}
          minimum={typeof propSchema.minimum === "number" ? propSchema.minimum : undefined}
          maximum={typeof propSchema.maximum === "number" ? propSchema.maximum : undefined}
          suggestions={Array.isArray(propSchema.examples) ? propSchema.examples : undefined}
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

    default: // string
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
export function JsonSchemaForm({
  schema,
  values,
  onChange,
  errors = {},
  disabled,
  className,
  advancedLabel = "Advanced options",
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

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...values, [key]: value });
    },
    [onChange, values],
  );

  const { essentials, advancedGroups, advancedKeys } = useMemo(() => {
    const essentials: Array<[string, JsonSchemaNode]> = [];
    // Preserve original key order while bucketing into groups.
    const groupOrder: string[] = [];
    const groups = new Map<string, Array<[string, JsonSchemaNode]>>();
    const advancedKeys = new Set<string>();
    const DEFAULT_GROUP = "More options";

    for (const entry of Object.entries(properties)) {
      const [key, propSchema] = entry;
      if (propSchema["x-paperclip-advanced"] === true) {
        advancedKeys.add(key);
        const rawGroup = propSchema["x-paperclip-group"];
        const group = typeof rawGroup === "string" && rawGroup.length > 0
          ? rawGroup
          : DEFAULT_GROUP;
        if (!groups.has(group)) {
          groups.set(group, []);
          groupOrder.push(group);
        }
        groups.get(group)!.push(entry);
      } else {
        essentials.push(entry);
      }
    }

    return {
      essentials,
      advancedGroups: groupOrder.map((group) => ({
        group,
        fields: groups.get(group)!,
      })),
      advancedKeys,
    };
  }, [properties]);

  const hasAdvanced = advancedGroups.length > 0;

  const hasAdvancedError = useMemo(() => {
    if (!hasAdvanced) return false;
    for (const errorKey of Object.keys(errors)) {
      // Top-level errors arrive as "/<key>" or "/<key>/<...>".
      const stripped = errorKey.startsWith("/") ? errorKey.slice(1) : errorKey;
      const topKey = stripped.split("/")[0];
      if (advancedKeys.has(topKey)) return true;
    }
    return false;
  }, [errors, advancedKeys, hasAdvanced]);

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // Force the disclosure open when a validation error lands on a hidden field
  // so the user can see and fix it. Never auto-close — once open, the user
  // controls collapse.
  useEffect(() => {
    if (hasAdvancedError) setIsAdvancedOpen(true);
  }, [hasAdvancedError]);

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

  const renderField = ([key, propSchema]: [string, JsonSchemaNode]) => {
    const value = values[key];
    const isRequired = requiredFields.has(key);
    const error = errors[`/${key}`];
    const label = labelFromKey(key, propSchema);
    const path = `/${key}`;

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
        path={path}
      />
    );
  };

  return (
    <div className={cn("space-y-6", className)}>
      {essentials.map(renderField)}

      {hasAdvanced && (
        <div className="space-y-3 rounded-lg border border-dashed">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            onClick={() => setIsAdvancedOpen((open) => !open)}
            aria-expanded={isAdvancedOpen}
          >
            <span className="text-sm font-medium">{advancedLabel}</span>
            {isAdvancedOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {isAdvancedOpen && (
            <div className="space-y-6 px-4 pb-4">
              {advancedGroups.map(({ group, fields }) => (
                <div key={group} className="space-y-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group}
                  </div>
                  <div className="space-y-6">
                    {fields.map(renderField)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
