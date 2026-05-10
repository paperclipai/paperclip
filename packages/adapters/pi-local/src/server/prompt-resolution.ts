import { DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE } from "@paperclipai/adapter-utils/server-utils";

/**
 * Detects whether the operator explicitly supplied a prompt template via
 * `config.promptTemplate`. Empty string, whitespace-only, or omitted is
 * treated as "use the default" — and, when AGENTS.md loads cleanly, those
 * cases also suppress the default to avoid duplicating the execution
 * contract that AGENTS.md already provides.
 *
 * Returns the explicit value when present (preserving exact whitespace),
 * or `null` to signal "no operator override".
 */
export function detectExplicitPromptTemplate(
  rawPromptTemplate: unknown,
): string | null {
  return typeof rawPromptTemplate === "string" && rawPromptTemplate.trim().length > 0
    ? rawPromptTemplate
    : null;
}

export interface SystemPromptInputs {
  /** Path that was used to read the AGENTS.md file, or "" if none configured. */
  resolvedInstructionsFilePath: string;
  /** Directory used in the path-resolution hint, with trailing slash. */
  instructionsFileDir: string;
  /** Contents of the AGENTS.md file, or null if not configured / read failed. */
  instructionsContents: string | null;
  /** True when an instructionsFilePath was configured but reading failed. */
  instructionsReadFailed: boolean;
  /** Result of detectExplicitPromptTemplate(). */
  explicitPromptTemplate: string | null;
  /** Template to use when no AGENTS.md is loaded; defaults to the project default. */
  fallbackPromptTemplate?: string;
}

/**
 * Builds the system-prompt extension string passed to pi-agent via
 * `--append-system-prompt`.
 *
 * Behavior matrix:
 *   - AGENTS.md loads + no explicit template → AGENTS.md + path directive only.
 *     (Default template is suppressed because AGENTS.md owns the contract.)
 *   - AGENTS.md loads + explicit template    → AGENTS.md + path directive + explicit template.
 *   - AGENTS.md not configured               → fallback template.
 *   - AGENTS.md read failed                  → fallback template.
 */
export function buildSystemPromptExtension(inputs: SystemPromptInputs): string {
  const fallback = inputs.fallbackPromptTemplate ?? DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;

  if (
    inputs.resolvedInstructionsFilePath &&
    inputs.instructionsContents !== null &&
    !inputs.instructionsReadFailed
  ) {
    const trailingTemplate =
      inputs.explicitPromptTemplate !== null ? `\n\n${inputs.explicitPromptTemplate}` : "";
    return (
      `${inputs.instructionsContents}\n\n` +
      `The above agent instructions were loaded from ${inputs.resolvedInstructionsFilePath}. ` +
      `Resolve any relative file references from ${inputs.instructionsFileDir}.` +
      trailingTemplate
    );
  }

  if (inputs.explicitPromptTemplate !== null) {
    return inputs.explicitPromptTemplate;
  }

  return fallback;
}

export interface HeartbeatGateInputs {
  /** True when an instructionsFilePath was configured (regardless of read success). */
  resolvedInstructionsFilePath: string;
  /** True when the configured instructionsFilePath was configured but reading failed. */
  instructionsReadFailed: boolean;
  /** Result of detectExplicitPromptTemplate(). */
  explicitPromptTemplate: string | null;
}

/**
 * Decides whether the default per-heartbeat user-prompt template should
 * still be rendered into the user message.
 *
 * Returns `false` (suppress) only when AGENTS.md loaded successfully AND
 * the operator did not explicitly supply a custom promptTemplate. In that
 * case, AGENTS.md is the single source of execution contract and we avoid
 * duplicating it as a user-message echo.
 */
export function shouldRenderDefaultHeartbeatPrompt(inputs: HeartbeatGateInputs): boolean {
  if (!inputs.resolvedInstructionsFilePath) return true;
  if (inputs.instructionsReadFailed) return true;
  if (inputs.explicitPromptTemplate !== null) return true;
  return false;
}
