export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaModelsResponse {
  models: OllamaModel[];
}

export async function listOllamaModels(
  host: string = DEFAULT_OLLAMA_HOST
): Promise<{ success: boolean; models?: OllamaModel[]; error?: string }> {
  try {
    const response = await fetch(`${host}/api/tags`);
    if (!response.ok) {
      return {
        success: false,
        error: `Ollama API returned ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as OllamaModelsResponse;
    return {
      success: true,
      models: data.models || [],
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Return the models installed in the Ollama instance reachable by Paperclip.
 * An unavailable Ollama service returns an empty list so the server registry
 * can fall back to the adapter's curated defaults.
 */
export async function listOllamaAdapterModels(): Promise<AdapterModel[]> {
  const configuredHost = process.env.OLLAMA_HOST?.trim() || DEFAULT_OLLAMA_HOST;
  const result = await listOllamaModels(configuredHost);
  if (!result.success || !result.models) return [];

  return result.models
    .filter((model) => typeof model.name === "string" && model.name.trim().length > 0)
    .map((model) => {
      const id = model.name.trim();
      const details = [model.details?.parameter_size, model.details?.quantization_level]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join(", ");
      return {
        id,
        label: details ? `${id} (${details})` : id,
      };
    });
}

export async function pullOllamaModel(
  modelName: string,
  host: string = DEFAULT_OLLAMA_HOST
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/pull`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: modelName, stream: false }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to pull model: ${response.status} ${response.statusText}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteOllamaModel(
  modelName: string,
  host: string = DEFAULT_OLLAMA_HOST
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${host}/api/delete`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: modelName }),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to delete model: ${response.status} ${response.statusText}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatModelName(modelName: string): string {
  // Remove 'latest' suffix if present
  return modelName.replace(":latest", "");
}
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { DEFAULT_OLLAMA_HOST } from "../index.js";
