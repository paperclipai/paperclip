import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";

export const QUALIFIED_OPENCODE_RUNNER_VERSION = "1.18.17" as const;
export const DEFAULT_OPENCODE_RUNNER_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;

export const QUALIFIED_ACPX_RUNNER_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
} as const;

export type QualifiedPaperclipRunnerAcpxAgent =
  keyof typeof QUALIFIED_ACPX_RUNNER_MODELS;

export type PaperclipRunnerProviderProfile =
  | {
      provider: "codex";
      backend: "codex_app_server";
      model: string | null;
    }
  | {
      provider: "opencode";
      backend: "opencode_server";
      model: string;
    }
  | {
      provider: "acpx";
      backend: "acpx_runtime";
      model: string;
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
    };

export type PaperclipRunnerNativeProviderInput =
  | {
      provider: "codex";
      model: string | null;
      codexApprovalPolicy: "never" | "on-request" | "untrusted";
    }
  | {
      provider: "opencode";
      model: string;
      opencodePermissionMode: "allow" | "ask" | "deny";
    }
  | {
      provider: "acpx";
      model: string;
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
      acpxPermissionMode: "approve-all" | "approve-reads" | "deny-all";
    };

export class PaperclipRunnerProviderProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipRunnerProviderProfileError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function assertPermissionMode(
  provider: PaperclipRunnerProvider,
  config: Record<string, unknown>,
): void {
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  const configured = config[capability.configKey];
  if (
    configured !== undefined
    && resolvePaperclipRunnerPermissionMode(provider, configured) !== configured
  ) {
    throw new PaperclipRunnerProviderProfileError(
      "runner_permission_mode_invalid",
      `${capability.configKey} is not supported by ${provider}.`,
    );
  }
}

/**
 * Resolve the immutable provider identity used for a fresh Paperclip Runner
 * selection. The persisted adapterConfig is the authority; runtimeConfig is
 * deliberately not consulted so model-profile or migration metadata cannot
 * silently switch the harness selected for a run.
 */
export function resolvePaperclipRunnerProviderProfile(
  adapterConfig: unknown,
): PaperclipRunnerProviderProfile {
  const config = asRecord(adapterConfig);
  const candidate = config.provider ?? "codex";
  if (!isPaperclipRunnerProvider(candidate)) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_unsupported",
      "Paperclip Runner provider must be codex, opencode, or acpx.",
    );
  }

  assertPermissionMode(candidate, config);
  const model = optionalString(config.model);
  if (candidate === "codex") {
    return {
      provider: "codex",
      backend: "codex_app_server",
      model,
    };
  }

  if (candidate === "opencode") {
    if (!model || !model.includes("/") || model.endsWith("/")) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_opencode_model_invalid",
        "Paperclip Runner OpenCode requires model in provider/model form.",
      );
    }
    return {
      provider: "opencode",
      backend: "opencode_server",
      model,
    };
  }

  const acpxAgent = config.acpxAgent;
  if (acpxAgent !== "claude" && acpxAgent !== "codex") {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_agent_unavailable",
      "Paperclip Runner ACPX requires the qualified Claude or Codex agent profile; Pi is not available.",
    );
  }
  const qualifiedModel = QUALIFIED_ACPX_RUNNER_MODELS[acpxAgent];
  if (model !== qualifiedModel) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_model_unqualified",
      `Paperclip Runner ACPX ${acpxAgent} requires exact model ${qualifiedModel}.`,
    );
  }
  return {
    provider: "acpx",
    backend: "acpx_runtime",
    model,
    acpxAgent,
  };
}

/**
 * Project the operator-owned adapter configuration into the closed native
 * execution descriptor. The selected backend must still match the provider;
 * an adapter edit cannot silently change a run that already persisted its
 * runtime driver.
 */
export function resolvePaperclipRunnerNativeProviderInput(input: {
  backend: PaperclipRunnerProviderProfile["backend"];
  adapterConfig: unknown;
}): PaperclipRunnerNativeProviderInput {
  const config = asRecord(input.adapterConfig);
  const profile = resolvePaperclipRunnerProviderProfile(config);
  if (profile.backend !== input.backend) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_changed",
      "Paperclip Runner provider changed after this run selected its native backend.",
    );
  }
  if (profile.provider === "opencode") {
    return {
      provider: "opencode",
      model: profile.model,
      opencodePermissionMode: resolvePaperclipRunnerPermissionMode(
        "opencode",
        config.opencodePermissionMode,
      ) as "allow" | "ask" | "deny",
    };
  }
  if (profile.provider === "acpx") {
    return {
      provider: "acpx",
      model: profile.model,
      acpxAgent: profile.acpxAgent,
      acpxPermissionMode: resolvePaperclipRunnerPermissionMode(
        "acpx",
        config.acpxPermissionMode,
      ) as "approve-all" | "approve-reads" | "deny-all",
    };
  }
  return {
    provider: "codex",
    model: profile.model,
    codexApprovalPolicy: resolvePaperclipRunnerPermissionMode(
      "codex",
      config.codexPermissionMode,
    ) as "never" | "on-request" | "untrusted",
  };
}
