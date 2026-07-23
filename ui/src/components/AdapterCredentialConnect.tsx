import { useEffect, useId, useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ApiError } from "../api/client";
import { secretsApi } from "../api/secrets";
import { CopyText } from "./CopyText";

export interface AdapterCredentialConnectProps {
  companyId: string;
  adapterType: string;
  setup: AdapterCredentialSetup;
  boundEnvKeys: string[];
  onBind: (envKey: string, secretId: string) => void;
}

function toKebab(value: string): string {
  return value.toLowerCase().replace(/_/g, "-");
}

/**
 * Guided BYOK credential setup for one adapter (spec §3.2).
 *
 * Renders a compact "connected" summary once any of the adapter's credential
 * options is bound to a company secret, otherwise a full card: a segmented
 * control across the adapter's credential options, setup guidance for the
 * active option, and a one-shot "create secret + bind env" form.
 */
export function AdapterCredentialConnect({
  companyId,
  adapterType,
  setup,
  boundEnvKeys,
  onBind,
}: AdapterCredentialConnectProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceShowForm, setForceShowForm] = useState(false);
  const errorId = useId();

  const boundOption = setup.options.find((option) => boundEnvKeys.includes(option.envKey));

  // Collapse back to the compact summary whenever the bound credential
  // changes (e.g. a fresh successful bind) rather than lingering in the
  // "Change" state from a previous option.
  useEffect(() => {
    setForceShowForm(false);
  }, [boundOption?.envKey]);

  if (boundOption && !forceShowForm) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Badge variant="secondary" className="gap-1">
            <Check className="h-3 w-3" />
            Connected
          </Badge>
          <span className="min-w-0 truncate text-muted-foreground">
            via <span className="font-mono text-xs text-foreground">{boundOption.envKey}</span>
          </span>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setForceShowForm(true)}>
          Change
        </Button>
      </div>
    );
  }

  const active = setup.options[activeIndex] ?? setup.options[0];

  function selectOption(index: number) {
    setActiveIndex(index);
    setValue("");
    setError(null);
  }

  async function handleConnect() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);
    const envKey = active.envKey;
    const baseName = `${toKebab(adapterType)}-${toKebab(envKey)}`;

    try {
      const created = await secretsApi.create(companyId, { name: baseName, value: trimmed });
      onBind(envKey, created.id);
      setValue("");
    } catch (err) {
      // Only retry on a name conflict (409). Any other failure (network,
      // validation, auth, etc.) surfaces immediately — retrying under a new
      // name would silently create a second secret for an unrelated error.
      if (err instanceof ApiError && err.status === 409) {
        try {
          const created = await secretsApi.create(companyId, { name: `${baseName}-2`, value: trimmed });
          onBind(envKey, created.id);
          setValue("");
        } catch (retryError) {
          setError(retryError instanceof Error ? retryError.message : "Failed to create secret");
        }
      } else {
        setError(err instanceof Error ? err.message : "Failed to create secret");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      {setup.options.length > 1 ? (
        <div className="flex gap-1 rounded-md border border-border bg-muted/30 p-0.5">
          {setup.options.map((option, index) => (
            <button
              key={option.envKey}
              type="button"
              aria-pressed={index === activeIndex}
              onClick={() => selectOption(index)}
              className={cn(
                "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
                index === activeIndex
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-sm font-medium text-foreground">{active.label}</div>
      )}

      {active.hint ? <p className="text-xs text-muted-foreground">{active.hint}</p> : null}

      {active.setupCommand ? (
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 w-fit">
          <code className="font-mono text-xs text-foreground">{active.setupCommand}</code>
          <CopyText
            text={active.setupCommand}
            ariaLabel="Copy setup command"
            className="text-muted-foreground hover:text-foreground"
            copiedLabel="Command copied"
          >
            <Copy className="h-3 w-3" />
          </CopyText>
        </div>
      ) : null}

      {active.setupUrl ? (
        <a
          href={active.setupUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          Open setup page
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}

      <div className="flex items-center gap-2">
        <Input
          type="password"
          placeholder={active.placeholder}
          value={value}
          aria-label={`${active.label} value`}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (!value.trim() || submitting) return;
            void handleConnect();
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={!value.trim() || submitting}
          onClick={() => void handleConnect()}
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Connect
        </Button>
      </div>

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
