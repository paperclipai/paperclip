import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models } from "../index.js";

export async function listZaiModels(): Promise<AdapterModel[]> {
  return [...models];
}
