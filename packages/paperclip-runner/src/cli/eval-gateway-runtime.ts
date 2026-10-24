import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalSessionRequest } from "./eval-session-contract.js";

export interface EvalGatewayDescriptor {
  schema: "paperclip.runner-eval.gateway/v1";
  provider: "openai" | "anthropic";
  model: string;
  baseUrl: string;
  campaignId: string;
  executionId: string;
  attemptId: string;
  upstreamRoute: "direct" | "braintrust";
}

const TOKEN_ENV = "PAPERCLIP_RUNNER_EVAL_GATEWAY_TOKEN";
const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);

export async function prepareEvalGatewayRuntime(
  descriptorPath: string,
  request: EvalSessionRequest,
  source: NodeJS.ProcessEnv = process.env,
) {
  const raw = await readFile(descriptorPath, "utf8");
  let descriptor: EvalGatewayDescriptor;
  try {
    if (Buffer.byteLength(raw) > 8192) throw new Error();
    descriptor = JSON.parse(raw) as EvalGatewayDescriptor;
    const fields = ["schema", "provider", "model", "baseUrl", "campaignId", "executionId", "attemptId", "upstreamRoute"];
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)
        || Object.keys(descriptor).length !== fields.length || Object.keys(descriptor).some(key => !fields.includes(key))
        || descriptor.schema !== "paperclip.runner-eval.gateway/v1"
        || !["openai", "anthropic"].includes(descriptor.provider)
        || !["direct", "braintrust"].includes(descriptor.upstreamRoute)
        || ![descriptor.campaignId, descriptor.executionId, descriptor.attemptId].every(safeId)
        || descriptor.attemptId !== request.attemptId || descriptor.model !== request.model
        || typeof descriptor.baseUrl !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(descriptor.baseUrl)) throw new Error();
    const url = new URL(descriptor.baseUrl);
    if (!url.port || Number(url.port) > 65535) throw new Error();
  } catch {
    throw new Error("Invalid controller gateway descriptor");
  }
  const provider = request.provider ?? "codex";
  const codex = provider === "codex";
  const claude = provider === "acpx" && request.acpxAgent === "claude";
  if (!codex && !claude || descriptor.provider !== (codex ? "openai" : "anthropic")) {
    throw new Error("Controller gateway does not support this eval provider");
  }
  const token = source[TOKEN_ENV];
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Missing or invalid controller gateway token");
  const root = await mkdtemp(join(tmpdir(), "paperclip-runner-eval-gateway-"));
  try {
    const home = join(root, "home"), codexHome = join(root, "codex"), claudeHome = join(root, "claude");
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      ["PATH", "LANG", "LANGUAGE", "LC_ALL", "TZ", "SystemRoot", "WINDIR", "PATHEXT"]
        .flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]),
    );
    Object.assign(environment, {
      HOME: home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
      PAPERCLIP_RUNNER_HOME_MODE: "preconfigured",
    });
    for (const directory of [home, codexHome, claudeHome, environment.XDG_CONFIG_HOME!, environment.XDG_DATA_HOME!, environment.XDG_CACHE_HOME!, environment.TMPDIR!]) {
      await mkdir(directory, { mode: 0o700 });
    }
    if (codex) {
      environment.PAPERCLIP_AI_PROVIDER_KEY = token;
      await writeFile(join(codexHome, "config.toml"), [
        'model_provider = "paperclip_eval"',
        'web_search = "disabled"',
        `model = ${JSON.stringify(request.model)}`,
        '[model_providers.paperclip_eval]',
        'name = "Paperclip eval controller"',
        `base_url = ${JSON.stringify(descriptor.baseUrl + "/v1")}`,
        'wire_api = "responses"', 'requires_openai_auth = false', 'env_key = "PAPERCLIP_AI_PROVIDER_KEY"',
        '[features]', 'shell_snapshot = false', '',
      ].join("\n"), { mode: 0o600, flag: "wx" });
    } else {
      Object.assign(environment, {
        ANTHROPIC_API_KEY: token, ANTHROPIC_BASE_URL: descriptor.baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
        ANTHROPIC_MODEL: request.model, ANTHROPIC_DEFAULT_OPUS_MODEL: request.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: request.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: request.model,
        CLAUDE_CODE_SUBAGENT_MODEL: request.model,
      });
      await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ model: request.model, availableModels: [request.model] }) + "\n", { mode: 0o600, flag: "wx" });
    }
    return {
      transportOptions: { homeMode: "preconfigured" as const, environment },
      evidence: {
        mode: "controller_gateway" as const, provider: descriptor.provider,
        declaredUpstreamRoute: descriptor.upstreamRoute,
        campaignId: descriptor.campaignId, executionId: descriptor.executionId, attemptId: descriptor.attemptId,
        descriptorSha256: createHash("sha256").update(raw).digest("hex"),
      },
      close: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
