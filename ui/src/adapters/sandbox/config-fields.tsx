import { useMemo, useState } from "react";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import type { EnvBinding } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const sandboxAgentOptions = [
  { value: "claude_local", label: "Claude Code" },
  { value: "codex_local", label: "Codex" },
  { value: "opencode_local", label: "OpenCode" },
  { value: "pi_local", label: "Pi" },
  { value: "cursor", label: "Cursor" },
] as const;

const sandboxProviderOptions = [
  { value: "e2b", label: "E2B", description: "Managed default" },
  { value: "opensandbox", label: "OpenSandbox", description: "Self-hosted default" },
  { value: "cloudflare", label: "Cloudflare", description: "Advanced gateway" },
] as const;

const instanceTypeOptions = ["lite", "standard", "heavy"] as const;
const sandboxCredentialKeys = [
  "E2B_API_KEY",
  "OPEN_SANDBOX_API_KEY",
  "CLOUDFLARE_GATEWAY_TOKEN",
] as const;

function recommendedE2BTemplate(agentType: string) {
  if (agentType === "codex_local") return "codex";
  if (agentType === "opencode_local") return "opencode";
  return "base";
}

function recommendedCloudflareImage(agentType: string) {
  if (agentType === "claude_local" || agentType === "codex_local" || agentType === "opencode_local") {
    return "ghcr.io/paperclipai/cloudflare-agent-sandbox:latest";
  }
  return "";
}

function recommendedOpenSandboxImage() {
  return "ghcr.io/paperclipai/agent-sandbox:latest";
}

function readPlainValue(binding: unknown): string {
  if (typeof binding === "string") return binding;
  if (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "plain"
  ) {
    const value = (binding as { value?: unknown }).value;
    return typeof value === "string"
      ? value
      : "";
  }
  return "";
}

export function SandboxConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  secrets = [],
  onCreateSecret,
}: AdapterConfigFieldsProps) {
  const createValues = (values ?? {}) as CreateConfigValues;
  const providerConfig = (
    isCreate
      ? {
          baseUrl: createValues.sandboxBaseUrl ?? "",
          namespace: createValues.sandboxNamespace ?? "paperclip",
          instanceType: createValues.sandboxInstanceType ?? "standard",
          image: createValues.sandboxImage ?? "",
          template: createValues.sandboxTemplate ?? "",
          domain: createValues.sandboxDomain ?? "",
        }
      : eff("adapterConfig", "providerConfig", (config.providerConfig ?? {}) as Record<string, unknown>)
  ) as Record<string, unknown>;
  const sandboxAgentType = isCreate
    ? createValues.sandboxAgentType || "claude_local"
    : eff("adapterConfig", "sandboxAgentType", String(config.sandboxAgentType ?? "claude_local"));
  const providerType = isCreate
    ? createValues.sandboxProviderType || "e2b"
    : eff("adapterConfig", "providerType", String(config.providerType ?? "e2b"));
  const envConfig = (
    isCreate
      ? (createValues.envBindings ?? {})
      : eff("adapterConfig", "env", ((config.env ?? {}) as Record<string, EnvBinding>) ?? {})
  ) as Record<string, EnvBinding>;

  const [advancedOpen, setAdvancedOpen] = useState(!isCreate);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState(() => ({
    e2b: readPlainValue(envConfig.E2B_API_KEY),
    opensandbox: readPlainValue(envConfig.OPEN_SANDBOX_API_KEY),
    cloudflare: readPlainValue(envConfig.CLOUDFLARE_GATEWAY_TOKEN),
  }));

  const secretNameById = useMemo(
    () => new Map(secrets.map((secret) => [secret.id, secret.name])),
    [secrets],
  );

  const updateProviderConfig = (next: Record<string, unknown>) => {
    const base = eff(
      "adapterConfig",
      "providerConfig",
      (config.providerConfig ?? {}) as Record<string, unknown>,
    ) as Record<string, unknown>;
    mark("adapterConfig", "providerConfig", { ...base, ...next });
  };

  function updateEnvBinding(key: string, binding: EnvBinding | undefined) {
    const nextEnv = { ...envConfig };
    if (binding === undefined) delete nextEnv[key];
    else nextEnv[key] = binding;

    if (isCreate) {
      set!({ envBindings: nextEnv });
      return;
    }
    mark("adapterConfig", "env", nextEnv);
  }

  function clearProviderCredentials(nextProviderType: string) {
    const keepKey =
      nextProviderType === "e2b"
        ? "E2B_API_KEY"
        : nextProviderType === "opensandbox"
          ? "OPEN_SANDBOX_API_KEY"
          : "CLOUDFLARE_GATEWAY_TOKEN";
    for (const key of sandboxCredentialKeys) {
      if (key !== keepKey) updateEnvBinding(key, undefined);
    }
    setDrafts({
      e2b: keepKey === "E2B_API_KEY" ? drafts.e2b : "",
      opensandbox: keepKey === "OPEN_SANDBOX_API_KEY" ? drafts.opensandbox : "",
      cloudflare: keepKey === "CLOUDFLARE_GATEWAY_TOKEN" ? drafts.cloudflare : "",
    });
  }

  function applyProviderPreset(nextProviderType: string) {
    clearProviderCredentials(nextProviderType);
    if (isCreate) {
      const patch: Partial<CreateConfigValues> = {
        sandboxProviderType: nextProviderType,
        sandboxBaseUrl: "",
        sandboxNamespace: "paperclip",
        sandboxInstanceType: "standard",
        sandboxImage: "",
        sandboxTemplate: "",
        sandboxDomain: "",
      };
      if (nextProviderType === "e2b") {
        patch.sandboxTemplate = recommendedE2BTemplate(sandboxAgentType);
      } else if (nextProviderType === "opensandbox") {
        patch.sandboxImage = recommendedOpenSandboxImage();
      } else if (nextProviderType === "cloudflare") {
        patch.sandboxImage = recommendedCloudflareImage(sandboxAgentType);
      }
      set!(patch);
      return;
    }

    mark("adapterConfig", "providerType", nextProviderType);
    if (nextProviderType === "e2b") {
      mark("adapterConfig", "providerConfig", {
        template: recommendedE2BTemplate(sandboxAgentType),
        domain: undefined,
      });
      return;
    }
    if (nextProviderType === "opensandbox") {
      mark("adapterConfig", "providerConfig", {
        domain: undefined,
        image: recommendedOpenSandboxImage(),
      });
      return;
    }
    mark("adapterConfig", "providerConfig", {
      baseUrl: undefined,
      namespace: "paperclip",
      instanceType: "standard",
      image: recommendedCloudflareImage(sandboxAgentType) || undefined,
    });
  }

  async function saveCredentialSecret(
    envKey: "E2B_API_KEY" | "OPEN_SANDBOX_API_KEY" | "CLOUDFLARE_GATEWAY_TOKEN",
  ) {
    if (!onCreateSecret) return;
    const value =
      envKey === "E2B_API_KEY"
        ? drafts.e2b
        : envKey === "OPEN_SANDBOX_API_KEY"
          ? drafts.opensandbox
          : drafts.cloudflare;
    if (!value.trim()) return;
    const name = window.prompt("Secret name", envKey.toLowerCase())?.trim();
    if (!name) return;

    try {
      setSecretError(null);
      const created = await onCreateSecret(name, value.trim());
      updateEnvBinding(envKey, {
        type: "secret_ref",
        secretId: created.id,
        version: "latest",
      });
      setDrafts((current) => ({
        ...current,
        e2b: envKey === "E2B_API_KEY" ? "" : current.e2b,
        opensandbox: envKey === "OPEN_SANDBOX_API_KEY" ? "" : current.opensandbox,
        cloudflare: envKey === "CLOUDFLARE_GATEWAY_TOKEN" ? "" : current.cloudflare,
      }));
    } catch (error) {
      setSecretError(error instanceof Error ? error.message : "Failed to create secret");
    }
  }

  function credentialSummary(envKey: string, fallback: string) {
    const binding = envConfig[envKey];
    if (
      typeof binding === "object" &&
      binding !== null &&
      "type" in binding &&
      (binding as { type?: unknown }).type === "secret_ref"
    ) {
      const secretId = typeof (binding as { secretId?: unknown }).secretId === "string"
        ? (binding as { secretId: string }).secretId
        : "";
      return secretNameById.get(secretId)
        ? `Stored in secret: ${secretNameById.get(secretId)}`
        : "Stored in Paperclip secrets";
    }
    if (readPlainValue(binding)) return "Stored in agent config";
    return fallback;
  }

  return (
    <>
      <Field label="Sandbox runtime" hint={help.sandboxAgentType}>
        <select
          className={inputClass}
          value={sandboxAgentType}
          onChange={(event) => {
            const nextRuntime = event.target.value;
            if (isCreate) {
              const patch: Partial<CreateConfigValues> = { sandboxAgentType: nextRuntime };
              if (providerType === "e2b") patch.sandboxTemplate = recommendedE2BTemplate(nextRuntime);
              if (providerType === "cloudflare" && !createValues.sandboxImage) {
                patch.sandboxImage = recommendedCloudflareImage(nextRuntime);
              }
              set!(patch);
              return;
            }
            mark("adapterConfig", "sandboxAgentType", nextRuntime);
            if (providerType === "e2b" && !String(providerConfig.template ?? "")) {
              updateProviderConfig({ template: recommendedE2BTemplate(nextRuntime) });
            }
          }}
        >
          {sandboxAgentOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Sandbox provider" hint={help.sandboxProviderType}>
        <div className="grid gap-2 sm:grid-cols-3">
          {sandboxProviderOptions.map((option) => {
            const selected = providerType === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={`rounded-md border px-3 py-2 text-left ${selected ? "border-foreground bg-accent" : "border-border"}`}
                onClick={() => applyProviderPreset(option.value)}
              >
                <div className="text-sm font-medium">{option.label}</div>
                <div className="text-xs text-muted-foreground">{option.description}</div>
              </button>
            );
          })}
        </div>
      </Field>

      {providerType === "e2b" && (
        <>
          <Field label="E2B API key" hint="Recommended managed setup. Paperclip connects directly to E2B.">
            <div className="space-y-2">
              <input
                type="password"
                className={inputClass}
                value={drafts.e2b}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((current) => ({ ...current, e2b: value }));
                  updateEnvBinding("E2B_API_KEY", value ? { type: "plain", value } : undefined);
                }}
                placeholder="e2b_..."
              />
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{credentialSummary("E2B_API_KEY", `Recommended template: ${recommendedE2BTemplate(sandboxAgentType)}`)}</span>
                <button type="button" className="underline" onClick={() => saveCredentialSecret("E2B_API_KEY")}>
                  Save to secrets
                </button>
              </div>
            </div>
          </Field>

          <Field label="Template" hint={help.sandboxTemplate}>
            <DraftInput
              value={
                isCreate
                  ? createValues.sandboxTemplate ?? ""
                  : String(providerConfig.template ?? providerConfig.image ?? "")
              }
              onCommit={(value) =>
                isCreate
                  ? set!({ sandboxTemplate: value || recommendedE2BTemplate(sandboxAgentType) })
                  : updateProviderConfig({ template: value || recommendedE2BTemplate(sandboxAgentType) })
              }
              immediate
              className={inputClass}
              placeholder={recommendedE2BTemplate(sandboxAgentType)}
            />
          </Field>
        </>
      )}

      {providerType === "opensandbox" && (
        <Field label="OpenSandbox API key" hint="Recommended self-hosted setup. Run the OpenSandbox lifecycle server next to Paperclip.">
          <div className="space-y-2">
            <input
              type="password"
              className={inputClass}
              value={drafts.opensandbox}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((current) => ({ ...current, opensandbox: value }));
                updateEnvBinding("OPEN_SANDBOX_API_KEY", value ? { type: "plain", value } : undefined);
              }}
              placeholder="opensandbox key"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{credentialSummary("OPEN_SANDBOX_API_KEY", "Paperclip will connect directly to your OpenSandbox server.")}</span>
              <button type="button" className="underline" onClick={() => saveCredentialSecret("OPEN_SANDBOX_API_KEY")}>
                Save to secrets
              </button>
            </div>
          </div>
        </Field>
      )}

      {providerType === "cloudflare" && (
        <Field label="Gateway token" hint="Advanced setup. Cloudflare needs a deployed gateway worker in front of Sandbox.">
          <div className="space-y-2">
            <input
              type="password"
              className={inputClass}
              value={drafts.cloudflare}
              onChange={(event) => {
                const value = event.target.value;
                setDrafts((current) => ({ ...current, cloudflare: value }));
                updateEnvBinding("CLOUDFLARE_GATEWAY_TOKEN", value ? { type: "plain", value } : undefined);
              }}
              placeholder="gateway bearer token"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>{credentialSummary("CLOUDFLARE_GATEWAY_TOKEN", "Store the gateway token here, then open advanced settings for the gateway URL.")}</span>
              <button type="button" className="underline" onClick={() => saveCredentialSecret("CLOUDFLARE_GATEWAY_TOKEN")}>
                Save to secrets
              </button>
            </div>
          </div>
        </Field>
      )}

      {secretError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {secretError}
        </div>
      )}

      <ToggleField
        label="Keep sandbox alive"
        hint={help.sandboxKeepAlive}
        checked={
          isCreate
            ? createValues.sandboxKeepAlive ?? true
            : eff("adapterConfig", "keepAlive", config.keepAlive === true)
        }
        onChange={(value) =>
          isCreate
            ? set!({ sandboxKeepAlive: value })
            : mark("adapterConfig", "keepAlive", value)
        }
      />

      <div className="rounded-md border border-border">
        <button
          type="button"
          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>Advanced sandbox settings</span>
          <span className="text-xs text-muted-foreground">{advancedOpen ? "Hide" : "Show"}</span>
        </button>

        {advancedOpen && (
          <div className="space-y-3 border-t border-border px-3 py-3">
            {providerType === "cloudflare" && (
              <>
                <Field label="Gateway URL" hint={help.sandboxBaseUrl}>
                  <DraftInput
                    value={
                      isCreate
                        ? createValues.sandboxBaseUrl ?? ""
                        : String(providerConfig.baseUrl ?? "")
                    }
                    onCommit={(value) =>
                      isCreate
                        ? set!({ sandboxBaseUrl: value })
                        : updateProviderConfig({ baseUrl: value || undefined })
                    }
                    immediate
                    className={inputClass}
                    placeholder="https://paperclip-sandbox.<subdomain>.workers.dev"
                  />
                </Field>

                <Field label="Namespace" hint={help.sandboxNamespace}>
                  <DraftInput
                    value={
                      isCreate
                        ? createValues.sandboxNamespace ?? "paperclip"
                        : String(providerConfig.namespace ?? "paperclip")
                    }
                    onCommit={(value) =>
                      isCreate
                        ? set!({ sandboxNamespace: value })
                        : updateProviderConfig({ namespace: value || "paperclip" })
                    }
                    immediate
                    className={inputClass}
                    placeholder="paperclip"
                  />
                </Field>

                <Field label="Instance type" hint={help.sandboxInstanceType}>
                  <select
                    className={inputClass}
                    value={
                      isCreate
                        ? createValues.sandboxInstanceType ?? "standard"
                        : String(providerConfig.instanceType ?? "standard")
                    }
                    onChange={(event) =>
                      isCreate
                        ? set!({ sandboxInstanceType: event.target.value })
                        : updateProviderConfig({ instanceType: event.target.value })
                    }
                  >
                    {instanceTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Container image" hint={help.sandboxImage}>
                  <DraftInput
                    value={
                      isCreate
                        ? createValues.sandboxImage ?? ""
                        : String(providerConfig.image ?? "")
                    }
                    onCommit={(value) =>
                      isCreate
                        ? set!({ sandboxImage: value })
                        : updateProviderConfig({ image: value || undefined })
                    }
                    immediate
                    className={inputClass}
                    placeholder="ghcr.io/paperclipai/cloudflare-agent-sandbox:latest"
                  />
                </Field>
              </>
            )}

            {providerType === "e2b" && (
              <Field label="API domain" hint={help.sandboxDomain}>
                <DraftInput
                  value={
                    isCreate
                      ? createValues.sandboxDomain ?? ""
                      : String(providerConfig.domain ?? "")
                  }
                  onCommit={(value) =>
                    isCreate
                      ? set!({ sandboxDomain: value })
                      : updateProviderConfig({ domain: value || undefined })
                  }
                  immediate
                  className={inputClass}
                  placeholder="e2b.app"
                />
              </Field>
            )}

            {providerType === "opensandbox" && (
              <>
                <Field label="API domain" hint={help.sandboxDomain}>
                  <DraftInput
                    value={
                      isCreate
                        ? createValues.sandboxDomain ?? ""
                        : String(providerConfig.domain ?? "")
                    }
                    onCommit={(value) =>
                      isCreate
                        ? set!({ sandboxDomain: value })
                        : updateProviderConfig({ domain: value || undefined })
                    }
                    immediate
                    className={inputClass}
                    placeholder="api.opensandbox.io"
                  />
                </Field>

                <Field label="Container image" hint={help.sandboxImage}>
                  <DraftInput
                    value={
                      isCreate
                        ? createValues.sandboxImage ?? ""
                        : String(providerConfig.image ?? "")
                    }
                    onCommit={(value) =>
                      isCreate
                        ? set!({ sandboxImage: value || recommendedOpenSandboxImage() })
                        : updateProviderConfig({ image: value || recommendedOpenSandboxImage() })
                    }
                    immediate
                    className={inputClass}
                    placeholder="ghcr.io/paperclipai/agent-sandbox:latest"
                  />
                </Field>
              </>
            )}

            <Field label="Bootstrap command" hint={help.sandboxBootstrapCommand}>
              <DraftInput
                value={
                  isCreate
                    ? createValues.sandboxBootstrapCommand ?? ""
                    : eff("adapterConfig", "bootstrapCommand", String(config.bootstrapCommand ?? ""))
                }
                onCommit={(value) =>
                  isCreate
                    ? set!({ sandboxBootstrapCommand: value })
                    : mark("adapterConfig", "bootstrapCommand", value || undefined)
                }
                immediate
                className={inputClass}
                placeholder="Optional one-time sandbox prep command"
              />
            </Field>

            <Field label="Agent instructions file" hint={help.instructionsFilePath}>
              <div className="flex items-center gap-2">
                <DraftInput
                  value={
                    isCreate
                      ? createValues.instructionsFilePath ?? ""
                      : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
                  }
                  onCommit={(value) =>
                    isCreate
                      ? set!({ instructionsFilePath: value })
                      : mark("adapterConfig", "instructionsFilePath", value || undefined)
                  }
                  immediate
                  className={inputClass}
                  placeholder="/absolute/path/to/AGENTS.md"
                />
                <ChoosePathButton />
              </div>
            </Field>
          </div>
        )}
      </div>
    </>
  );
}
