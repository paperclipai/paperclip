import {
  aiRoutingBaseUrl,
  aiRoutingModel,
  deepseekReasoningEffort,
  type AiProviderRouting,
} from "@paperclipai/shared";

/** Projects one authoritative connection into an isolated harness environment. */
export function managedProviderRouting(
  route: AiProviderRouting,
  harness: string,
  credential: string,
  model: string,
  effort?: unknown,
) {
  const env: Record<string, string> = {};
  const config: Record<string, unknown> = {};
  let codexConfig = "";
  let hermesConfig = "";
  const baseUrl = aiRoutingBaseUrl(route, harness);
  if (route.kind === "bedrock") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    env.AWS_REGION = route.region!;
    env.AWS_DEFAULT_REGION = route.region!;
    env.AWS_EC2_METADATA_DISABLED = "true";
    env.AWS_BEARER_TOKEN_BEDROCK = credential;
  } else if (harness === "codex_local") {
    env.PAPERCLIP_AI_PROVIDER_KEY = credential;
    // DeepSeek normalizes the full effort domain, but pin it to low|high|max.
    const level = route.kind === "deepseek" ? deepseekReasoningEffort(effort) : undefined;
    codexConfig = `${level ? `model_reasoning_effort = ${JSON.stringify(level)}\n` : ""}model_provider = "paperclip"\n[model_providers.paperclip]\nname = "Paperclip connection"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n${route.auth === "none" ? "" : 'env_key = "PAPERCLIP_AI_PROVIDER_KEY"\n'}`;
    if (route.kind === "deepseek") {
      // Codex falls back to its own OpenAI default model when config.model is
      // empty or names another provider's model. The DeepSeek endpoint rejects
      // that, so pin the resolved DeepSeek model (defaulting to deepseek-flash)
      // to keep the default setup path working.
      config.model = model.toLowerCase().includes("deepseek") ? model : "deepseek-flash";
    }
  } else if (harness === "claude_local") {
    // DeepSeek's Claude Code integration uses the `[1m]` window suffix on the
    // primary models only (not the haiku/subagent aliases).
    const claudeModel = route.kind === "deepseek" && model === "deepseek-flash"
      ? "deepseek-flash[1m]"
      : model;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env[
      route.auth === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"
    ] = credential;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (model) {
      env.ANTHROPIC_MODEL = claudeModel;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = claudeModel;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = claudeModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    }
    if (route.kind === "deepseek") {
      // The Claude adapter passes config.model through --model and prefers it
      // over ANTHROPIC_MODEL, so publish the resolved DeepSeek model (with its
      // window suffix and a default) there too.
      config.model = model ? claudeModel : "deepseek-flash[1m]";
    }
    const claudeLevel = route.kind === "deepseek" ? deepseekReasoningEffort(effort) : undefined;
    if (claudeLevel) env.CLAUDE_CODE_EFFORT_LEVEL = claudeLevel;
  } else if (harness === "opencode_local") {
    const provider = route.kind === "openrouter" ? "openrouter" : "paperclip";
    if (route.kind === "openrouter") env.OPENROUTER_API_KEY = credential;
    else {
      env.PAPERCLIP_AI_PROVIDER_KEY = credential;
      env.PAPERCLIP_AI_PROVIDER_URL = baseUrl;
      // The projected `paperclip` provider is per-run and never appears in
      // `opencode models`; skip OpenCode's availability pre-flight so the
      // configured model is not rejected as unavailable.
      env.OPENCODE_ALLOW_ALL_MODELS = "1";
    }
    const projectedModel = aiRoutingModel(route, harness, model);
    const id = model.startsWith(`${provider}/`)
      ? model.slice(provider.length + 1)
      : model;
    // `enabled_providers` restricts OpenCode to the projected provider, so the
    // auxiliary "small"/title model has no built-in provider default to fall
    // back to. Pin it to the projected model for the per-run `paperclip`
    // provider; otherwise OpenCode's title-generation call fails and aborts the
    // run with a bare exit code 1 after the main turn already produced output.
    if (provider === "paperclip" && projectedModel) {
      env.PAPERCLIP_OPENCODE_SMALL_MODEL = projectedModel;
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        [provider]: {
          ...(provider === "paperclip"
            ? { npm: "@ai-sdk/openai-compatible", name: "Paperclip connection" }
            : {}),
          options: { baseURL: baseUrl, apiKey: credential },
          models: id ? { [id]: { name: id } } : {},
        },
      },
      enabled_providers: [provider],
      ...(provider === "paperclip" && projectedModel
        ? { small_model: projectedModel }
        : {}),
    });
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    config.model = projectedModel;
  } else if (harness === "hermes_local") {
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_API_KEY = credential;
    env.OPENROUTER_API_KEY = route.kind === "openrouter" ? credential : "";
    config.provider = route.kind === "openrouter" ? "openrouter" : "auto";
    // Hermes now reads custom endpoint routing from config.yaml, not OPENAI_BASE_URL.
    // Hermes strips OPENAI_API_KEY from terminal children. A custom variable
    // would expose the reusable gateway key to task-controlled shell commands.
    hermesConfig = `model:\n  provider: ${route.kind === "openrouter" ? '"openrouter"' : '"custom"'}\n  default: ${JSON.stringify(model)}\n  base_url: ${JSON.stringify(baseUrl)}\n  api_mode: "chat_completions"\n${route.auth === "none" ? "" : '  api_key: "${OPENAI_API_KEY}"\n'}`;
  }
  return { env, config, codexConfig, hermesConfig };
}
