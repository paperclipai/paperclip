import { Trash2, UserRound } from "lucide-react";
import type { EnvBinding, EnvUserSecretRefBinding } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

/** User-secret env bindings (`env.<KEY>` = `user_secret_ref`) of an agent config. */
export function parseEnvUserSecretRefs(
  config: Record<string, unknown> | null | undefined,
): Record<string, EnvUserSecretRefBinding> {
  const env = config?.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return {};
  return Object.fromEntries(
    Object.entries(env as Record<string, EnvBinding>).filter(
      (entry): entry is [string, EnvUserSecretRefBinding] =>
        typeof entry[1] === "object" && entry[1] !== null && entry[1].type === "user_secret_ref",
    ),
  );
}

interface AgentEnvironmentUserSecretEditorProps {
  bindings: Record<string, EnvUserSecretRefBinding>;
  onChange: (next: Record<string, EnvUserSecretRefBinding>) => void;
  disabled?: boolean;
}

/**
 * Shows the responsible user's secrets that the agent receives as environment
 * variables, so they stay visible after Configuration became plain-only.
 */
export function AgentEnvironmentUserSecretEditor({ bindings, onChange, disabled }: AgentEnvironmentUserSecretEditorProps) {
  const entries = Object.entries(bindings);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        User secrets
      </div>
      {entries.map(([name, binding]) => (
        <div key={name} className="flex items-center gap-1.5">
          <Badge variant="outline" className="h-5 gap-1 px-1.5 font-normal">
            <UserRound className="size-3" /> User secret
          </Badge>
          <code className="min-w-0 flex-1 truncate text-xs">env.{name} ← {binding.key}</code>
          <select
            className="h-8 shrink-0 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
            value={binding.required === false ? "optional" : "required"}
            onChange={(event) =>
              onChange({ ...bindings, [name]: { ...binding, required: event.target.value === "required" } })}
            disabled={disabled}
            aria-label={`Requirement for ${name}`}
          >
            <option value="required">Required</option>
            <option value="optional">Optional</option>
          </select>
          <button
            type="button"
            onClick={() => {
              const next = { ...bindings };
              delete next[name];
              onChange(next);
            }}
            disabled={disabled}
            aria-label={`Remove user secret ${name}`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
