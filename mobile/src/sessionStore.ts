import AsyncStorage from "@react-native-async-storage/async-storage";

import type { PaperclipDeploymentMode } from "./config";

const SESSION_KEY = "paperclip.mobile.auth.session.v1";

interface StoredSession {
  token: string;
  mode: PaperclipDeploymentMode;
  savedAt: string;
  lastValidatedAt?: string;
}

async function readStoredSession(): Promise<StoredSession | null> {
  const raw = await AsyncStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.token || typeof parsed.token !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function loadSessionToken(
  mode: PaperclipDeploymentMode,
): Promise<{ token: string; savedAt: string } | null> {
  if (mode !== "local_trusted") {
    return null;
  }

  const session = await readStoredSession();
  if (!session || session.mode !== mode) {
    return null;
  }

  return {
    token: session.token,
    savedAt: session.savedAt,
  };
}

export async function saveSessionToken(
  mode: PaperclipDeploymentMode,
  token: string,
): Promise<void> {
  if (mode !== "local_trusted") {
    await AsyncStorage.removeItem(SESSION_KEY);
    return;
  }

  await AsyncStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      token,
      mode,
      savedAt: new Date().toISOString(),
    } satisfies StoredSession),
  );
}

export async function markSessionValidated(
  mode: PaperclipDeploymentMode,
): Promise<void> {
  if (mode !== "local_trusted") {
    return;
  }

  const existing = await readStoredSession();
  if (!existing || existing.mode !== mode) {
    return;
  }

  await AsyncStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      ...existing,
      lastValidatedAt: new Date().toISOString(),
    } satisfies StoredSession),
  );
}

export async function clearSessionToken(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}
