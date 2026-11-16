import { execFile } from "node:child_process";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_DISTILL_LOCAL_MODEL, models as fallbackModels } from "../index.js";
import { parseDistillModelsOutput } from "./parse.js";

const MODEL_CACHE_MS = 60_000;
let modelCache: { at: number; models: AdapterModel[] } | null = null;

function runDistillModels(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      process.env.PAPERCLIP_DISTILL_COMMAND || "distill",
      ["models"],
      { timeout: 30_000, env: { ...process.env, GROK_FOLDER_TRUST: "0" }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

export async function discoverDistillModels(force = false): Promise<AdapterModel[]> {
  if (!force && modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  const stdout = await runDistillModels();
  if (!stdout) return modelCache?.models ?? fallbackModels;
  const { defaultModel, models } = parseDistillModelsOutput(stdout);
  const ids = [DEFAULT_DISTILL_LOCAL_MODEL, ...models.filter((id) => id !== DEFAULT_DISTILL_LOCAL_MODEL)];
  const list = ids.map((id) => ({
    id,
    label:
      id === DEFAULT_DISTILL_LOCAL_MODEL
        ? "Auto (Distill account routing)"
        : id === defaultModel
          ? `${id} (Distill default)`
          : id,
  }));
  modelCache = { at: Date.now(), models: list };
  return list;
}
