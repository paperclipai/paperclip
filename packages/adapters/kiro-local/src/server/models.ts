import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models } from "../index.js";

/**
 * Kiro model list, derived from the adapter's canonical model array.
 * Verified against kiro-cli v1.27.3 (DEM-52 research).
 */
export const KIRO_MODELS: AdapterModel[] = [...models];

/**
 * List all available kiro-cli models.
 */
export async function listKiroModels(): Promise<AdapterModel[]> {
  return KIRO_MODELS;
}
