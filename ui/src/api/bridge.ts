/**
 * Bridge session API client (CLI-142 / ADR-0005 §8).
 */
import { api } from "./client";

export const bridgeApi = {
  async revokeBridgeSession(jti: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await api.delete(`/bridge/sessions/${jti}`);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Revoke failed";
      return { ok: false, error: message };
    }
  },
};
