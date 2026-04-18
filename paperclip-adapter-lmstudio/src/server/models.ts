export async function fetchModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data: Array<{ id: string }> };
    return data.data.map((m) => m.id);
  } catch {
    return [];
  }
}
