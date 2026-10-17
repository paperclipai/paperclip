import {
  advertisedModelImageInput, discoverModelImageInput, MODEL_CATALOG_MAX_BYTES,
  modelCatalogUrl, modelImageModalities,
} from "@paperclipai/adapter-utils/opencode-model-input";
import { runAdapterExecutionTargetProcess, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

/** Enrich only the selected managed provider. Remote discovery stays on the target. */
export async function prepareManagedModelImageInput(input: {
  runId: string; target: AdapterExecutionTarget | null | undefined; cwd: string;
  env: Record<string, string>; model: string; managed: boolean;
  localEnvironment?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!input.managed || !input.model.startsWith("paperclip/")) return;
  const baseUrl = input.env.PAPERCLIP_AI_PROVIDER_URL;
  if (!baseUrl) return;
  try {
    const config = JSON.parse(input.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const model = input.model.slice("paperclip/".length);
    const entry = config.provider?.paperclip?.models?.[model];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.modalities !== undefined) return;
    const credential = input.env.PAPERCLIP_AI_PROVIDER_KEY ?? "";
    if (/[\r\n\0]/.test(credential)) return;
    let imageInput: boolean | undefined;
    if (input.target?.kind === "remote") {
      // curl is used by the existing OpenCode sandbox installer. If absent,
      // discovery stays unknown. Send configuration over stdin, not argv/logs.
      const curlConfig = [
        `url = ${JSON.stringify(modelCatalogUrl(baseUrl).href)}`,
        "silent", "fail", "max-time = 3", `max-filesize = ${MODEL_CATALOG_MAX_BYTES}`,
        'proto = "=http,https"',
        ...(credential ? [`header = ${JSON.stringify(`Authorization: Bearer ${credential}`)}`] : []),
      ].join("\n");
      const result = await runAdapterExecutionTargetProcess(input.runId, input.target, "curl", ["--disable", "--config", "-", "--write-out", "\n%{http_code}"], {
        cwd: input.cwd, env: input.env, stdin: curlConfig,
        timeoutSec: 5, graceSec: 1, onLog: async () => {},
      });
      if (result.timedOut || result.exitCode !== 0 || Buffer.byteLength(result.stdout) > MODEL_CATALOG_MAX_BYTES) return;
      const statusLine = result.stdout.lastIndexOf("\n");
      if (result.stdout.slice(statusLine + 1) !== "200") return;
      imageInput = advertisedModelImageInput(JSON.parse(result.stdout.slice(0, statusLine)), model);
    } else {
      imageInput = await discoverModelImageInput({ baseUrl, credential, model, environment: input.localEnvironment ?? input.env });
    }
    Object.assign(entry, modelImageModalities(imageInput));
    input.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  } catch {
    // An optional catalog is not a new prerequisite for running a task.
  }
}
