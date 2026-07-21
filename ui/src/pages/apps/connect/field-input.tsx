import type { FieldDef } from "@paperclipai/shared";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Render a single markdown-ish helper string. We only need `**bold**` and plain
 * text for the provider guidance/helper copy (plan-catalog §5), so this stays a
 * tiny inline renderer rather than pulling the full markdown pipeline.
 */
export function InlineMarkdown({ children, className }: { children: string; className?: string }) {
  const parts = children.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

export interface FieldInputProps {
  field: FieldDef;
  value: string;
  onChange: (value: string) => void;
  /** Rotation mode: secret fields show "leave blank to keep current value". */
  rotation?: boolean;
  id: string;
}

/**
 * A single {@link FieldDef} rendered per its `type`, with provider-realistic
 * placeholders, prefix adornments, secret masking, and expert helper text
 * naming the exact provider screen (plan-catalog §5 copy standards).
 */
export function FieldInput({ field, value, onChange, rotation, id }: FieldInputProps) {
  const helper = field.helperMd;
  const placeholder = rotation && field.secret ? "Leave blank to keep the current value" : field.placeholder;

  const control = (() => {
    switch (field.type) {
      case "textarea":
        return (
          <Textarea
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="font-mono text-xs"
            rows={4}
          />
        );
      case "checkbox":
        return (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              id={id}
              checked={value === "true"}
              onCheckedChange={(next) => onChange(next === true ? "true" : "false")}
            />
            {field.label}
          </label>
        );
      case "select":
        return (
          <Select value={value} onValueChange={onChange}>
            <SelectTrigger id={id}>
              <SelectValue placeholder={placeholder ?? "Select…"} />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case "datetime":
        return (
          <Input
            id={id}
            type="datetime-local"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      case "password":
      case "text":
      default:
        return (
          <div className={cn("flex items-stretch", field.prefix && "rounded-md border border-input")}>
            {field.prefix && (
              <span className="flex items-center whitespace-nowrap rounded-l-md border-r border-input bg-muted px-2.5 text-sm text-muted-foreground">
                {field.prefix}
              </span>
            )}
            <Input
              id={id}
              type={field.type === "password" ? "password" : "text"}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              autoComplete={field.secret ? "off" : undefined}
              className={cn(field.prefix && "rounded-l-none border-0 focus-visible:ring-0")}
            />
          </div>
        );
    }
  })();

  if (field.type === "checkbox") {
    return (
      <div className="space-y-1">
        {control}
        {helper && (
          <p className="pl-6 text-xs text-muted-foreground">
            <InlineMarkdown>{helper}</InlineMarkdown>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {field.label}
        {field.required && <span className="text-destructive">*</span>}
        {field.secret && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
            secret
          </span>
        )}
      </label>
      {control}
      {helper && (
        <p className="text-xs text-muted-foreground">
          <InlineMarkdown>{helper}</InlineMarkdown>
        </p>
      )}
    </div>
  );
}
