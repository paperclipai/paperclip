export const llmCredentialsApi = {
  list: async () => {
    const res = await fetch("/api/users/me/llm-credentials");
    if (!res.ok) throw new Error("Failed to list credentials");
    return res.json();
  },

  create: async (payload: { providerType: string; apiKey: string; baseUrl?: string }) => {
    const res = await fetch("/api/users/me/llm-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to create credential");
    }
    return res.json();
  },

  delete: async (id: string) => {
    const res = await fetch(`/api/users/me/llm-credentials/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error("Failed to delete credential");
    return res.json();
  },

  validate: async (payload: { providerType: string; apiKey: string; baseUrl?: string }) => {
    const res = await fetch("/api/users/me/llm-credentials/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Validation failed");
    return res.json();
  },

  test: async (id: string) => {
    const res = await fetch(`/api/users/me/llm-credentials/${id}/test`, {
      method: "POST",
    });
    if (!res.ok) throw new Error("Test failed");
    return res.json();
  },
};
