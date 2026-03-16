export const companyLlmSettingsApi = {
  get: async (companyId: string) => {
    const res = await fetch(`/api/companies/${companyId}/llm-settings`);
    if (!res.ok) throw new Error("Failed to get settings");
    return res.json();
  },

  set: async (
    companyId: string,
    payload: { preferredProviderType: string; preferredModelId: string },
  ) => {
    const res = await fetch(`/api/companies/${companyId}/llm-settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to set settings");
    }
    return res.json();
  },
};
