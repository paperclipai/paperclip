function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function runnerApiProviderResponse(operationId: string, result: unknown, companyPrefix: string): unknown {
  if (!/^POST \/api\/(?:routines\/\{[^}]+\}\/(?:triggers|revisions\/\{[^}]+\}\/restore)|routine-triggers\/\{[^}]+\}\/rotate-secret)$/.test(operationId)) return result;
  const response = record(result);
  if (!response || response.data == null) return result;
  const data = record(response.data);
  if (!data) return { ...response, data: null, guidance: "Open the routine's Triggers page to complete webhook credential setup." };
  const { secretMaterial, secretMaterials, ...metadata } = data;
  if (secretMaterial == null && (secretMaterials == null || (Array.isArray(secretMaterials) && secretMaterials.length === 0))) return result;
  const routineId = record(data.trigger)?.routineId ?? record(data.routine)?.id;
  return {
    ...response,
    data: metadata,
    secureSetup: {
      ...(typeof routineId === "string" && routineId ? {
        path: `/${encodeURIComponent(companyPrefix)}/routines/${encodeURIComponent(routineId)}/triggers`,
      } : {}),
      guidance: "Complete webhook credential setup in the routine's Triggers page. Use its protected key replacement control to generate and copy a key. Do not request or print the key in chat.",
    },
  };
}
