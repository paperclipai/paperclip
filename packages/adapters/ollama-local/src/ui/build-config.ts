import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MAX_ITERATIONS,
  DEFAULT_OLLAMA_TIMEOUT_SEC,
} from "../index.js";

export function buildOllamaLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {
    host: DEFAULT_OLLAMA_HOST,
    maxIterations: DEFAULT_OLLAMA_MAX_ITERATIONS,
    timeoutSec: DEFAULT_OLLAMA_TIMEOUT_SEC,
  };
  if (v.cwd) ac.cwd = v.cwd;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  if (v.model) ac.model = v.model;
  return ac;
}
