import { readFile } from "node:fs/promises";
import { templateRegistrySchema, type TemplateRegistry } from "@paperclipai/shared";

export interface TemplateRegistryService {
  get(): Promise<TemplateRegistry>;
  invalidate(): void;
}

export function createTemplateRegistry(filePath: string): TemplateRegistryService {
  let cached: TemplateRegistry | null = null;

  return {
    async get() {
      if (cached) return cached;
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (err) {
        throw new Error(`Template registry not found at ${filePath}`);
      }
      const parsed = JSON.parse(raw);
      cached = templateRegistrySchema.parse(parsed);
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}
