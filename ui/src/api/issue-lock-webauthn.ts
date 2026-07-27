import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { api } from "./client";

/**
 * MAT-112 — client for the issue-lock WebAuthn / Touch ID gate (variant A).
 * This is an interface-level lock: it hides a locked issue's content in the
 * browser until Touch ID succeeds. It does not encrypt data and does not gate
 * agent API access.
 */

export interface IssueLockStatus {
  registered: boolean;
  credentialCount: number;
  unlocked: boolean;
  unlockTtlSeconds: number;
  protectionScope: "ui_only";
}

export interface UnlockResult {
  verified: boolean;
  unlocked: boolean;
  unlockExpiresAt: number;
}

const BASE = "/webauthn/issue-lock";

export const issueLockWebauthnApi = {
  getStatus: () => api.get<IssueLockStatus>(`${BASE}/status`),

  /** True only when the device can do platform (Touch ID) WebAuthn. */
  capabilities: async (): Promise<{ supported: boolean; platformAvailable: boolean }> => {
    const supported = browserSupportsWebAuthn();
    let platformAvailable = false;
    if (supported) {
      try {
        platformAvailable = await platformAuthenticatorIsAvailable();
      } catch {
        platformAvailable = false;
      }
    }
    return { supported, platformAvailable };
  },

  /** Register this device's platform authenticator; opens an unlock session. */
  register: async (deviceLabel?: string): Promise<UnlockResult> => {
    const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>(
      `${BASE}/register/options`,
      {},
    );
    const response = await startRegistration({ optionsJSON });
    return api.post<UnlockResult>(`${BASE}/register/verify`, { response, deviceLabel });
  },

  /** Assert Touch ID to open a short-lived unlock session. */
  unlock: async (): Promise<UnlockResult> => {
    const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>(
      `${BASE}/unlock/options`,
      {},
    );
    const response = await startAuthentication({ optionsJSON });
    return api.post<UnlockResult>(`${BASE}/unlock/verify`, { response });
  },

  /** End the unlock session immediately (re-lock this browser). */
  relock: () => api.post<{ unlocked: boolean }>(`${BASE}/relock`, {}),
};
