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
  host: string = "http://localhost:11434"
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

export async function pullOllamaModel(
  modelName: string,
  host: string = "http://localhost:11434"
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
  host: string = "http://localhost:11434"
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
