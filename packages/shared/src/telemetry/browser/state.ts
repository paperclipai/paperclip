import type { TelemetryState } from "../types.js";

const STORAGE_KEY = "paperclip:telemetry:state";

function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for envs without randomUUID (should be rare in modern browsers)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function generateSalt(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback — insecure but functional for non-crypto-capable envs
  return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export function loadOrCreateBrowserState(version: string): TelemetryState {
  if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as TelemetryState;
        if (parsed.installId && parsed.salt) {
          return parsed;
        }
      }
    } catch {
      // Corrupted entry — recreate below
    }
  }

  const state: TelemetryState = {
    installId: generateUUID(),
    salt: generateSalt(),
    createdAt: new Date().toISOString(),
    firstSeenVersion: version,
  };

  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage quota exceeded or blocked — use in-memory only
    }
  }

  return state;
}

export function saveBrowserState(state: TelemetryState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — ignore
  }
}
