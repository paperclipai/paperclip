import type { RuntimeProfileDefinition } from "@paperclipai/shared";
import { api } from "./client";

export const runtimeProfilesApi = {
  list: () => api.get<RuntimeProfileDefinition[]>("/runtime-profiles"),
};
