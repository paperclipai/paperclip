import type { HostFeaturesSnapshotV1 } from "@paperclipai/shared";
import { api } from "./client";

export const runtimeFeaturesApi = {
  get: () => api.get<HostFeaturesSnapshotV1>("/runtime-features"),
};
