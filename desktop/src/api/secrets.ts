import { tauriInvoke } from "./tauri-client";

export const secretsApi = {
  list: () => tauriInvoke<string[]>("list_secret_keys"),
  set: (key: string, value: string) => tauriInvoke<void>("set_secret", { key, value }),
  get: (key: string) => tauriInvoke<string>("get_secret", { key }),
  delete: (key: string) => tauriInvoke<void>("delete_secret", { key }),
};
