/** Installation-wide defaults for adapters with CLI and ACP engines. */
export const EXECUTION_ENGINE_DEFAULTS_ENV = "PAPERCLIP_DEFAULT_EXECUTION_ENGINES";

export type ConfigurableEngine = "acp" | "cli";

export const CONFIGURABLE_ENGINE_ADAPTERS = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "kimi_local",
] as const;

const supportedAdapters: ReadonlySet<string> = new Set(CONFIGURABLE_ENGINE_ADAPTERS);

/** Reject malformed operator configuration rather than silently choosing an engine. */
export function parseExecutionEngineDefaults(
  value: string | undefined,
): Readonly<Record<string, ConfigurableEngine>> {
  if (value === undefined || value.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${EXECUTION_ENGINE_DEFAULTS_ENV} must be a JSON object mapping adapter IDs to "cli" or "acp"`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${EXECUTION_ENGINE_DEFAULTS_ENV} must be a JSON object`);
  }
  const defaults: Record<string, ConfigurableEngine> = Object.create(null);
  for (const [adapter, engine] of Object.entries(parsed)) {
    if (!supportedAdapters.has(adapter)) {
      throw new Error(`${EXECUTION_ENGINE_DEFAULTS_ENV}: unsupported adapter ${adapter}`);
    }
    if (engine !== "cli" && engine !== "acp") {
      throw new Error(`${EXECUTION_ENGINE_DEFAULTS_ENV}: ${adapter} must be "cli" or "acp"`);
    }
    defaults[adapter] = engine;
  }
  return defaults;
}

/** Explicit agent engine choices are resolved by adapters before using this fallback. */
export function resolveExecutionEngineDefault(
  adapter: string,
  environment: NodeJS.ProcessEnv = process.env,
): ConfigurableEngine {
  return parseExecutionEngineDefaults(environment[EXECUTION_ENGINE_DEFAULTS_ENV])[adapter] ?? "acp";
}
