import { OPENROUTER_ATTRIBUTION_HEADERS } from "@paperclipai/adapter-utils/openrouter-attribution";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function piOpenRouterExtensionSource(): string {
  return `const attribution = ${JSON.stringify(OPENROUTER_ATTRIBUTION_HEADERS)};
const names = new Set(Object.keys(attribution).map(name => name.toLowerCase()));
function isOpenRouter(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
function headers(existing = {}) {
  return { ...Object.fromEntries(Object.entries(existing).filter(([name]) => !names.has(name.toLowerCase()))), ...attribution };
}
export default function paperclipAttribution(pi) {
  const patched = new WeakSet();
  function apply(_event, context) {
    const registry = context.modelRegistry;
    if (typeof registry.getProvider === "function") {
      for (const name of new Set(registry.getAll().map(model => model.provider))) {
        const registered = registry.getRegisteredNativeProvider?.(name);
        if (registered && patched.has(registered)) continue;
        const provider = registry.getProvider(name);
        if (!provider || patched.has(provider)) continue;
        const models = provider.getModels();
        if (!models.some(model => isOpenRouter(model.baseUrl))) continue;
        const wrapped = { ...provider };
        for (const method of ["stream", "streamSimple", "generateImages", "classify"]) {
          if (typeof provider[method] !== "function") continue;
          wrapped[method] = (model, input, options) => provider[method](model, input,
            isOpenRouter(model.baseUrl) ? { ...options, headers: headers(options?.headers) } : options);
        }
        patched.add(wrapped);
        registry.registerProvider(wrapped);
      }
    } else if (!patched.has(registry)) {
      const resolve = registry.getApiKeyAndHeaders.bind(registry);
      registry.getApiKeyAndHeaders = async model => {
        const result = await resolve(model);
        return result.ok && isOpenRouter(result.baseUrl ?? model.baseUrl)
          ? { ...result, headers: headers(result.headers) } : result;
      };
      patched.add(registry);
    }
  }
  pi.on("session_start", apply);
  pi.on("before_agent_start", apply);
  pi.on("model_select", apply);
}
`;
}

export async function preparePiOpenRouterExtension() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-attribution-"));
  const extensionPath = path.join(directory, "openrouter-attribution.mjs");
  try {
    await fs.writeFile(extensionPath, piOpenRouterExtensionSource(), "utf8");
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, extensionPath, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
