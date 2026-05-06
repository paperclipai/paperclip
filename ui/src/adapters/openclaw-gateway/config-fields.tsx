import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftTextarea,
  help,
} from "../../components/agent-config-primitives";
import { cn } from "../../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const artifactOutputsPlaceholder = `[
  { "pattern": "deliverables/final-packet.md", "title": "Final packet", "primary": true },
  { "pattern": "deliverables/articles/*.md", "title": "Article draft" }
]`;

type OpenClawSetupMode = "token_only" | "token_and_device_pairing";

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function resolveEffectiveSetupMode(input: {
  disableDeviceAuth: unknown;
  devicePrivateKeyPem: unknown;
}): OpenClawSetupMode {
  const parsedDisableDeviceAuth = parseBooleanLike(input.disableDeviceAuth);
  if (parsedDisableDeviceAuth !== null) {
    return parsedDisableDeviceAuth ? "token_only" : "token_and_device_pairing";
  }
  if (typeof input.devicePrivateKeyPem === "string" && input.devicePrivateKeyPem.trim().length > 0) {
    return "token_and_device_pairing";
  }
  return "token_only";
}

function ModeButton({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border bg-transparent text-muted-foreground hover:bg-accent/30",
      )}
    >
      <div className="text-xs font-medium">{title}</div>
      <div className="mt-1 text-[11px] leading-relaxed opacity-90">{description}</div>
    </button>
  );
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function OpenClawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const effectiveGatewayToken = isCreate
    ? values?.accessToken ?? ""
    : eff("adapterConfig", "authToken", "");
  const currentMode: OpenClawSetupMode = isCreate
    ? values?.openClawSetupMode ?? "token_only"
    : resolveEffectiveSetupMode({
        disableDeviceAuth: eff("adapterConfig", "disableDeviceAuth", config.disableDeviceAuth),
        devicePrivateKeyPem: eff("adapterConfig", "devicePrivateKeyPem", config.devicePrivateKeyPem),
      });

  const setMode = (mode: OpenClawSetupMode) => {
    if (isCreate) {
      set!({ openClawSetupMode: mode });
      return;
    }
    mark("adapterConfig", "disableDeviceAuth", mode === "token_only");
  };

  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:18789"
        />
      </Field>

      <Field label="Setup mode">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ModeButton
            active={currentMode === "token_only"}
            title="Token only (cloud-first)"
            description="Use the gateway URL and access token only. This is the default business setup."
            onClick={() => setMode("token_only")}
          />
          <ModeButton
            active={currentMode === "token_and_device_pairing"}
            title="Token + device pairing"
            description="Enable signed device auth and pairing for advanced or self-managed environments."
            onClick={() => setMode("token_and_device_pairing")}
          />
        </div>
      </Field>

      <SecretField
        label="Access token"
        value={effectiveGatewayToken}
        onCommit={(v) =>
          isCreate
            ? set!({ accessToken: v })
            : mark("adapterConfig", "authToken", v?.trim() ? v.trim() : undefined)
        }
        placeholder={isCreate ? "OpenClaw access token" : "Leave blank to keep the stored token"}
      />

      {!isCreate && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>Stored securely. Enter a new token only when you want to replace the current one.</div>
          <div>
            Effective mode:{" "}
            <span className="font-medium text-foreground">
              {currentMode === "token_only" ? "Token only (cloud-first)" : "Token + device pairing"}
            </span>
          </div>
        </div>
      )}

      <Field
        label="Artifact outputs JSON"
        hint="Optional declared workspace-relative files or globs to collect as deliverables after successful issue-backed runs."
      >
        <DraftTextarea
          value={
            isCreate
              ? values?.artifactOutputsJson ?? ""
              : JSON.stringify(eff("adapterConfig", "artifactOutputs", config.artifactOutputs ?? []), null, 2)
          }
          onCommit={(v) => {
            if (isCreate) {
              set!({ artifactOutputsJson: v });
              return;
            }
            const trimmed = v.trim();
            if (!trimmed) {
              mark("adapterConfig", "artifactOutputs", undefined);
              return;
            }
            try {
              const parsed = JSON.parse(trimmed);
              mark("adapterConfig", "artifactOutputs", Array.isArray(parsed) ? parsed : undefined);
            } catch {
              // Keep invalid drafts local until the user finishes editing.
            }
          }}
          minRows={5}
          placeholder={artifactOutputsPlaceholder}
        />
      </Field>
    </>
  );
}
